/**
 * Telnyx media-stream adapter for the Cloudflare Agents voice pipeline.
 *
 * Adapted from @cloudflare/voice-twilio (MIT License, Copyright (c) 2025
 * Cloudflare, Inc.), which bridges Twilio Media Streams the same way. Telnyx
 * sends 8 kHz mu-law audio as base64 JSON; the voice agent speaks 16 kHz 16-bit
 * PCM as binary frames plus JSON control messages. This converts both ways,
 * starts and ends the agent's call with the phone call, and interrupts playback
 * when the caller talks over the agent.
 */
import { getAgentByName } from 'agents';
import type { Env } from './env';

const MULAW_DECODE = new Int16Array(256);
for (let i = 0; i < 256; i += 1) {
  const mu = ~i & 0xff;
  const sample = ((((mu & 0x0f) << 3) + 132) << ((mu >> 4) & 0x07)) - 132;
  MULAW_DECODE[i] = mu & 0x80 ? -sample : sample;
}

export function encodeMulaw(input: number): number {
  const sign = input < 0 ? 0x80 : 0;
  let sample = Math.min(Math.abs(input), 32635) + 132;
  let exponent = 7;
  for (; exponent > 0; exponent -= 1) {
    if (sample & 0x4000) break;
    sample <<= 1;
  }
  return ~(sign | (exponent << 4) | ((sample >> 10) & 0x0f)) & 0xff;
}

export function decodeMulaw(bytes: Uint8Array): Int16Array {
  const pcm = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) pcm[i] = MULAW_DECODE[bytes[i] ?? 0] ?? 0;
  return pcm;
}

/** Linear-interpolation resampler; adequate for 8 kHz <-> 16 kHz speech. */
export function resample(input: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const output = new Int16Array(Math.floor(input.length / ratio));
  for (let i = 0; i < output.length; i += 1) {
    const position = i * ratio;
    const index = Math.floor(position);
    const a = input[index] ?? 0;
    const b = input[Math.min(index + 1, input.length - 1)] ?? 0;
    output[i] = Math.round(a + (position - index) * (b - a));
  }
  return output;
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i] ?? 0);
  return btoa(binary);
}

function energy(samples: Int16Array): number {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return samples.length ? sum / samples.length : 0;
}

const SPEECH_ENERGY = 250000;
const SPEECH_FRAMES = 3;
const PLAYBACK_GRACE_MS = 1000;
/** Telnyx accepts chunks from 20 ms up; 200 ms keeps interruptions responsive. */
const OUT_CHUNK_SAMPLES = 1600;

interface TelnyxMessage {
  event?: string;
  stream_id?: string;
  start?: { call_control_id?: string; from?: string };
  media?: { track?: string; payload?: string };
}

/**
 * Bridges one Telnyx audio stream to its voice agent. With `debug`, the agent's
 * transcripts and timings are also sent down the stream as `debug` events, which
 * the call simulator reads; Telnyx never sets it.
 */
export function handleTelnyxStream(request: Request, env: Env, debug = false): Response {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('Expected WebSocket upgrade', { status: 426 });
  }
  const pair = new WebSocketPair();
  const client = pair[0];
  const telnyx = pair[1];
  telnyx.accept();

  let agent: WebSocket | null = null;
  let callId = '';
  let startedAt = 0;
  let playbackEndsAt = 0;
  let loudFrames = 0;
  let gated = false;
  let lastCallerAudioAt = 0;
  let awaitingReply = false;

  const events: Array<Record<string, unknown>> = [];
  let saved = false;
  let inboundFrames = 0;
  let outboundChunks = 0;

  /**
   * Records a call event. Everything goes to the key-protected call record;
   * `sensitive` details (what was said) are kept out of the platform logs.
   */
  const log = (event: string, data: Record<string, unknown> = {}, sensitive: Record<string, unknown> = {}) => {
    const entry = { event, t: startedAt ? Date.now() - startedAt : 0, ...data };
    if (events.length < 400) events.push({ ...entry, ...sensitive });
    console.log(JSON.stringify({ call: callId, ...entry }));
  };

  /** Stores the call record once, before the sockets close and the request ends. */
  const save = async () => {
    if (saved || !callId) return;
    saved = true;
    try {
      const stub = env.CallLog.get(env.CallLog.idFromName('recent')) as unknown as {
        append(record: unknown): Promise<void>;
      };
      await stub.append({
        provider: 'cloudflare',
        callId,
        startedAt: new Date(startedAt).toISOString(),
        durationMs: Date.now() - startedAt,
        inboundFrames,
        outboundChunks,
        events
      });
    } catch (err) {
      console.log(JSON.stringify({ event: 'call_log_failed', error: err instanceof Error ? err.message : 'unknown' }));
    }
  };

  const clearPlayback = () => {
    playbackEndsAt = 0;
    if (telnyx.readyState === WebSocket.OPEN) telnyx.send(JSON.stringify({ event: 'clear' }));
  };

  const closeAll = async () => {
    if (agent?.readyState === WebSocket.OPEN) {
      agent.send(JSON.stringify({ type: 'end_call' }));
      agent.close();
    }
    await save();
    if (telnyx.readyState === WebSocket.OPEN) telnyx.close(1000, 'call ended');
  };

  const onAgentMessage = (data: unknown) => {
    if (typeof data === 'string') {
      let message: { type?: string; status?: string; role?: string; text?: string } & Record<string, unknown>;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }
      if (debug && message.type !== 'audio_config' && telnyx.readyState === WebSocket.OPEN) {
        telnyx.send(JSON.stringify({ event: 'debug', t: Date.now() - startedAt, message }));
      }
      if (message.type === 'playback_interrupt') {
        if (!gated) clearPlayback();
        gated = false;
        loudFrames = 0;
      } else if (message.type === 'status') {
        if (message.status !== 'idle') gated = false;
      } else if (message.type === 'transcript' && message.role === 'user') {
        awaitingReply = true;
        log('caller', {}, { text: message.text });
      } else if (message.type === 'transcript_end') {
        log('assistant', {}, { text: message.text });
      } else if (
        message.type === 'metrics' ||
        message.type === 'turn_metrics' ||
        message.type === 'diagnostic' ||
        message.type === 'error'
      ) {
        log(message.type, message);
      }
      return;
    }
    if (!(data instanceof ArrayBuffer) || gated) return;
    if (awaitingReply) {
      awaitingReply = false;
      log('response_gap', { ms: Date.now() - lastCallerAudioAt });
    }
    const pcm8k = resample(new Int16Array(data), 16000, 8000);
    const now = Date.now();
    playbackEndsAt = Math.max(now, playbackEndsAt) + (pcm8k.length / 8000) * 1000;
    for (let offset = 0; offset < pcm8k.length; offset += OUT_CHUNK_SAMPLES) {
      const chunk = pcm8k.subarray(offset, offset + OUT_CHUNK_SAMPLES);
      const mulaw = new Uint8Array(chunk.length);
      for (let i = 0; i < chunk.length; i += 1) mulaw[i] = encodeMulaw(chunk[i] ?? 0);
      if (telnyx.readyState === WebSocket.OPEN) {
        outboundChunks += 1;
        telnyx.send(JSON.stringify({ event: 'media', media: { payload: bytesToBase64(mulaw) } }));
      }
    }
  };

  const connectAgent = async () => {
    const stub = await getAgentByName(env.MeiVoiceAgent as never, callId);
    const url = new URL(request.url);
    url.pathname = `/agents/mei-voice-agent/${callId}`;
    const response = await (stub as unknown as { fetch(req: Request): Promise<Response> }).fetch(
      new Request(url.toString(), { headers: { Upgrade: 'websocket' } })
    );
    const socket = response.webSocket;
    if (!socket) throw new Error('voice agent did not return a WebSocket');
    socket.binaryType = 'arraybuffer';
    socket.accept();
    socket.addEventListener('message', (event) => onAgentMessage(event.data));
    socket.addEventListener('close', () => {
      log('agent_closed');
      void closeAll();
    });
    agent = socket;
    socket.send(JSON.stringify({ type: 'start_call', preferred_format: 'pcm16' }));
  };

  telnyx.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return;
    let message: TelnyxMessage;
    try {
      message = JSON.parse(event.data) as TelnyxMessage;
    } catch {
      return;
    }
    switch (message.event) {
      case 'start': {
        const raw = message.start?.call_control_id ?? message.stream_id ?? crypto.randomUUID();
        callId = raw.replace(/[^A-Za-z0-9_-]/g, '_').slice(-60);
        startedAt = Date.now();
        // Keep the shape of the carrier's stream description, which this adapter
        // depends on, but not its values: they include the caller's phone number.
        log('call_start', {
          start_fields: Object.keys(message.start ?? {}),
          media_format: (message.start as { media_format?: unknown } | undefined)?.media_format ?? null
        });
        connectAgent().catch((err: unknown) => {
          log('agent_connect_failed', { error: err instanceof Error ? err.message : 'unknown' });
          void closeAll();
        });
        break;
      }
      case 'media': {
        if (message.media?.track === 'outbound' || !message.media?.payload) break;
        inboundFrames += 1;
        const pcm16k = resample(decodeMulaw(base64ToBytes(message.media.payload)), 8000, 16000);
        const loud = energy(pcm16k) > SPEECH_ENERGY;
        loudFrames = loud ? loudFrames + 1 : 0;
        if (loud) lastCallerAudioAt = Date.now();
        const agentSpeaking = Date.now() < playbackEndsAt + PLAYBACK_GRACE_MS;
        if (!gated && agentSpeaking && loudFrames >= SPEECH_FRAMES) {
          gated = true;
          loudFrames = 0;
          clearPlayback();
          if (agent?.readyState === WebSocket.OPEN) agent.send(JSON.stringify({ type: 'interrupt' }));
        }
        if (agent?.readyState === WebSocket.OPEN) {
          agent.send(pcm16k.buffer.slice(pcm16k.byteOffset, pcm16k.byteOffset + pcm16k.byteLength) as ArrayBuffer);
        }
        break;
      }
      case 'stop':
        log('call_stop');
        void closeAll();
        break;
      default:
        if (message.event !== 'connected') log('carrier_event', { name: message.event ?? 'unknown' });
        break;
    }
  });
  telnyx.addEventListener('close', () => void closeAll());

  return new Response(null, { status: 101, webSocket: client });
}
