import { buildSystemPrompt, buildToolDefinitions } from '../../workers/call-prompt.js';

/** Which OpenAI voice API answers a call: GPT-Live or the Realtime API. */
export type SipMode = 'live' | 'realtime';

export interface OpenAiSipConfig {
  apiKey: string;
  webhookSecret: string;
  /** Mode used when the called number has no entry in numberModes. */
  defaultMode: SipMode;
  /** Called number (E.164) to mode, so each test number can pin one API. */
  numberModes: Map<string, SipMode>;
  liveModel: string;
  liveBackendModel: string;
  realtimeModel: string;
  realtimeTranscriptionModel: string;
  voice: string;
  storeId: string;
  storeName: string;
  /** E.164 number for staff transfers; empty disables transfers. */
  staffPhone: string;
  apiBaseUrl: string;
  internalApiKey: string;
  /** Directory for per-call JSONL records; empty disables recording. */
  recordDir: string;
  /** How long to let the goodbye play before hanging up after end_call. */
  hangupDelayMs: number;
}

function parseMode(value: string | undefined, fallback: SipMode): SipMode {
  return value === 'live' || value === 'realtime' ? value : fallback;
}

function parseNumberModes(value: string | undefined): Map<string, SipMode> {
  const modes = new Map<string, SipMode>();
  for (const pair of (value ?? '').split(',')) {
    const [number, mode] = pair.split('=').map((part) => part.trim());
    if (number && (mode === 'live' || mode === 'realtime')) modes.set(number, mode);
  }
  return modes;
}

export function readOpenAiSipConfig(env: NodeJS.ProcessEnv, port: number): OpenAiSipConfig {
  return {
    apiKey: env.OPENAI_API_KEY ?? '',
    webhookSecret: env.OPENAI_WEBHOOK_SECRET ?? '',
    defaultMode: parseMode(env.OPENAI_SIP_MODE, 'live'),
    numberModes: parseNumberModes(env.OPENAI_SIP_NUMBER_MODES),
    liveModel: env.OPENAI_LIVE_MODEL ?? 'gpt-live-1.1',
    liveBackendModel: env.OPENAI_LIVE_BACKEND_MODEL ?? 'gpt-6-luna',
    realtimeModel: env.OPENAI_REALTIME_MODEL ?? 'gpt-realtime-2.1',
    realtimeTranscriptionModel: env.OPENAI_REALTIME_TRANSCRIPTION_MODEL ?? 'gpt-4o-mini-transcribe',
    voice: env.OPENAI_VOICE ?? 'marin',
    storeId: env.VOICE_STORE_ID ?? 'store-1',
    storeName: env.VOICE_STORE_NAME ?? 'Restaurant',
    staffPhone: env.VOICE_STAFF_PHONE ?? '',
    apiBaseUrl: env.VOICE_API_BASE_URL ?? `http://127.0.0.1:${port}`,
    internalApiKey: env.INTERNAL_API_KEY ?? '',
    recordDir: env.VOICE_RECORD_DIR ?? '',
    hangupDelayMs: Number(env.VOICE_HANGUP_DELAY_MS ?? 7000)
  };
}

const VOICE_ADDENDUM = `

## Voice
- Say at the start that you are an AI assistant.
- Speak in short sentences and stop talking when the caller interrupts.
- Never state a menu item, price, availability, or order confirmation that did not come from a tool result.`;

/** Accept body for a GPT-Live call. Tools run in the delegated backend model. */
export function buildLiveAcceptBody(config: OpenAiSipConfig): Record<string, unknown> {
  const prompt = buildSystemPrompt(config.storeName) + VOICE_ADDENDUM;
  return {
    session: {
      type: 'live',
      model: config.liveModel,
      instructions: `${prompt}\n- Every tool runs in your backend. Hand all menu, store-status, and order work to it.`,
      input: [
        {
          type: 'message',
          role: 'developer',
          content: [
            {
              type: 'input_text',
              text: 'Greet the caller now in English, say you are an AI assistant, and ask what they would like to order. Then pause and listen.'
            }
          ]
        }
      ],
      audio: { output: { voice: config.voice } },
      delegation: {
        type: 'responses',
        responses: {
          model: config.liveBackendModel,
          instructions: `${prompt}\n- Report only what tools return, as short facts for the voice assistant to say.`,
          tools: buildToolDefinitions(),
          tool_choice: 'auto',
          parallel_tool_calls: false
        }
      }
    }
  };
}

/** Accept body for a Realtime API call. The speech model calls tools itself. */
export function buildRealtimeAcceptBody(config: OpenAiSipConfig): Record<string, unknown> {
  return {
    type: 'realtime',
    model: config.realtimeModel,
    instructions: buildSystemPrompt(config.storeName) + VOICE_ADDENDUM,
    audio: {
      input: { transcription: { model: config.realtimeTranscriptionModel } },
      output: { voice: config.voice }
    },
    tools: buildToolDefinitions(),
    tool_choice: 'auto'
  };
}
