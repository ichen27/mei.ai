import { Agent, type Connection } from 'agents';
import { WorkersAIFluxSTT, withVoice, type VoiceTurnContext } from 'agents/voice';
import { buildSystemPrompt, buildToolDefinitions } from '../../../src/workers/call-prompt';
import type { Env } from './env';
import { OrderTools } from './tools';
import { PcmTTS } from './tts';

type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; name: string; content: string };

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

const MAX_TOOL_STEPS = 6;
const PCM_BYTES_PER_SECOND = 16000 * 2;
const GREETING = "Hi, thanks for calling. I'm an AI assistant and I can take your pickup order. What would you like?";
const FALLBACK = "Sorry, I'm having trouble right now. Could you say that again?";

const VoiceAgent = withVoice(Agent, { audioFormat: 'pcm16', sampleRate: 16000 });

/**
 * One phone call. The SDK runs speech-to-text and text-to-speech; onTurn runs
 * the language model with the same prompt and order tools the other providers use.
 * Each call is its own Durable Object, so the in-memory history lasts the call.
 */
export class MeiVoiceAgent extends VoiceAgent<Env> {
  transcriber = new WorkersAIFluxSTT(this.env.AI);
  tts = new PcmTTS(this.env.AI, this.env.TTS_MODEL, this.env.TTS_SPEAKER);

  private history: ChatMessage[] = [];
  private endRequested = false;
  private endTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSpeechMs = 0;

  /** Timing and tool details for whoever is carrying the call audio; never spoken. */
  private diag(connection: Connection, event: string, data: Record<string, unknown>): void {
    console.log(JSON.stringify({ event, call: this.name, ...data }));
    try {
      connection.send(JSON.stringify({ type: 'diagnostic', event, timestamp: Date.now(), data }));
    } catch {
      // The caller may already have hung up.
    }
  }

  async onCallStart(connection: Connection): Promise<void> {
    this.history = [
      {
        role: 'system',
        content:
          buildSystemPrompt(this.env.STORE_NAME) +
          '\n\n## Voice\n- You have already greeted the caller and said you are an AI assistant.' +
          '\n- Reply in one or two short spoken sentences. No lists, symbols, or markdown.' +
          '\n- Never state a menu item, price, availability, or order confirmation that did not come from a tool result.'
      },
      { role: 'assistant', content: GREETING }
    ];
    await this.speak(connection, GREETING);
  }

  async onTurn(transcript: string, context: VoiceTurnContext): Promise<string> {
    this.history.push({ role: 'user', content: transcript });
    const tools = new OrderTools(this.env, this.name, 'unknown');
    const definitions = buildToolDefinitions().map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters }
    }));

    for (let step = 0; step < MAX_TOOL_STEPS; step += 1) {
      if (context.signal.aborted) return '';
      const startedAt = Date.now();
      const message = await this.complete(definitions);
      this.diag(context.connection, 'llm_step', {
        ms: Date.now() - startedAt,
        tool_calls: message?.tool_calls?.map((call) => call.function.name) ?? [],
        failed: !message
      });
      if (!message) break;

      const calls = message.tool_calls ?? [];
      this.history.push({ role: 'assistant', content: message.content ?? '', ...(calls.length ? { tool_calls: calls } : {}) });
      if (calls.length === 0) {
        if (this.endRequested) this.pendingSpeechMs = 0;
        return message.content?.trim() || FALLBACK;
      }
      for (const call of calls) {
        const toolStartedAt = Date.now();
        const output = await tools.execute(call.function.name, call.function.arguments);
        this.diag(context.connection, 'tool', {
          name: call.function.name,
          ms: Date.now() - toolStartedAt,
          ok: !output.startsWith('{"error"'),
          ...(output.startsWith('{"error"') ? { output: output.slice(0, 200) } : {})
        });
        if (call.function.name === 'end_call') this.endRequested = true;
        this.history.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: output });
      }
    }
    return FALLBACK;
  }

  private async complete(tools: unknown[]): Promise<{ content?: string | null; tool_calls?: ToolCall[] } | null> {
    try {
      const result = (await this.env.AI.run(this.env.LLM_MODEL, {
        messages: this.history,
        tools,
        max_tokens: 400
      })) as { choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCall[] } }> };
      return result.choices?.[0]?.message ?? null;
    } catch (err) {
      console.log(
        JSON.stringify({ event: 'llm_error', call: this.name, error: err instanceof Error ? err.message : 'unknown' })
      );
      return null;
    }
  }

  /** After end_call, hang up once the goodbye has had time to play. */
  afterSynthesize(audio: ArrayBuffer | null, _text: string, connection: Connection): ArrayBuffer | null {
    if (this.endRequested && audio) {
      this.pendingSpeechMs += (audio.byteLength / PCM_BYTES_PER_SECOND) * 1000;
      if (this.endTimer) clearTimeout(this.endTimer);
      this.endTimer = setTimeout(() => {
        this.forceEndCall(connection);
        connection.close(1000, 'call ended');
      }, this.pendingSpeechMs + 1500);
    }
    return audio;
  }

  onCallEnd(): void {
    if (this.endTimer) clearTimeout(this.endTimer);
    console.log(JSON.stringify({ event: 'call_end', call: this.name, turns: this.history.filter((m) => m.role === 'user').length }));
  }
}
