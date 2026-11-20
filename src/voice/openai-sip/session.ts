import { randomUUID } from 'node:crypto';
import { safeLog } from '../../logger.js';
import type { CallRecorder } from '../call-recorder.js';
import type { OpenAiSipClient, SidebandConnection } from './client.js';
import type { SipMode } from './config.js';

export interface ToolRunner {
  execute(toolName: string, argsJson: string): Promise<string>;
}

export interface SipCallOptions {
  mode: SipMode;
  id: string;
  client: OpenAiSipClient;
  tools: ToolRunner;
  recorder: CallRecorder;
  staffPhone: string;
  hangupDelayMs: number;
  onEnded?: () => void;
}

interface FunctionCall {
  callId: string;
  name: string;
  argsJson: string;
}

const CLOSED_GRACE_MS = 5000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function functionCallFrom(item: unknown): FunctionCall | null {
  const record = asRecord(item);
  if (
    !record ||
    record.type !== 'function_call' ||
    typeof record.call_id !== 'string' ||
    typeof record.name !== 'string' ||
    typeof record.arguments !== 'string'
  ) {
    return null;
  }
  return { callId: record.call_id, name: record.name, argsJson: record.arguments };
}

function toolSucceeded(output: string): boolean {
  try {
    const parsed = asRecord(JSON.parse(output));
    return !parsed || !('error' in parsed);
  } catch {
    return false;
  }
}

/**
 * Runs one accepted phone call. OpenAI carries the audio; this class listens on
 * the control ("sideband") WebSocket, executes the order tools the model asks
 * for, returns their results, and ends or transfers the call when asked.
 *
 * A tool result may only be followed by "continue" once the response that
 * requested it has completed and no other tool is still running, so the
 * continuation is gated on both.
 */
export class SipCallSession {
  private connection: SidebandConnection | null = null;
  private ended = false;
  private readonly seenEvents = new Set<string>();
  private readonly handledCalls = new Set<string>();
  private runningTools = 0;
  private needsContinue = false;
  private responseOpen = false;
  private endRequested = false;
  private hangUpWhenAudioStops = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly options: SipCallOptions) {}

  async start(): Promise<void> {
    const { mode, id, client } = this.options;
    this.connection = await client.attach(mode, id, {
      onEvent: (event) => this.onEvent(event),
      onClose: () => void this.finish('sideband_closed')
    });
    // GPT-Live greets from the seeded developer message; Realtime needs a nudge.
    if (mode === 'realtime') this.send({ type: 'response.create' });
  }

  onEvent(event: Record<string, unknown>): void {
    if (this.ended) return;
    if (typeof event.event_id === 'string') {
      if (this.seenEvents.has(event.event_id)) return;
      this.seenEvents.add(event.event_id);
    }
    if (event.type === 'error') {
      safeLog('warn', 'voice_provider_error', { callId: this.options.id, detail: event.error ?? event.message });
      this.options.recorder.note('provider_error', { detail: event.error ?? event.message ?? null });
      return;
    }
    if (this.options.mode === 'live') this.onLiveEvent(event);
    else this.onRealtimeEvent(event);
  }

  private onLiveEvent(event: Record<string, unknown>): void {
    const { recorder } = this.options;
    switch (event.type) {
      case 'session.input_transcript.delta':
        if (typeof event.delta === 'string') recorder.callerText(event.delta);
        recorder.callerStopped(typeof event.end_ms === 'number' ? event.end_ms : undefined);
        return;
      case 'session.output_transcript.delta':
        recorder.assistantStarted(typeof event.start_ms === 'number' ? event.start_ms : undefined);
        if (typeof event.delta === 'string') recorder.assistantText(event.delta);
        return;
      case 'session.closed':
        recorder.addUsage(event.usage);
        void this.finish(typeof event.reason === 'string' ? event.reason : 'session_closed');
        return;
      case 'response.event': {
        const nested = asRecord(event.event);
        if (!nested) return;
        if (nested.type === 'response.created') this.responseOpen = true;
        if (nested.type === 'response.output_item.done') this.onFunctionCall(functionCallFrom(nested.item));
        if (
          nested.type === 'response.completed' ||
          nested.type === 'response.failed' ||
          nested.type === 'response.incomplete'
        ) {
          recorder.addUsage(asRecord(nested.response)?.usage);
          this.responseOpen = false;
          this.maybeContinue();
        }
        return;
      }
      default:
        return;
    }
  }

  private onRealtimeEvent(event: Record<string, unknown>): void {
    const { recorder } = this.options;
    switch (event.type) {
      case 'input_audio_buffer.speech_stopped':
        recorder.callerStopped();
        return;
      case 'output_audio_buffer.started':
        recorder.assistantStarted();
        return;
      case 'conversation.item.input_audio_transcription.completed':
        if (typeof event.transcript === 'string') recorder.callerText(event.transcript + ' ');
        return;
      case 'response.output_audio_transcript.done':
        if (typeof event.transcript === 'string') recorder.assistantText(event.transcript + ' ');
        return;
      case 'response.created':
        this.responseOpen = true;
        return;
      case 'response.output_item.done':
        this.onFunctionCall(functionCallFrom(event.item));
        return;
      case 'response.done':
        recorder.addUsage(asRecord(event.response)?.usage);
        this.responseOpen = false;
        this.maybeContinue();
        return;
      case 'output_audio_buffer.stopped':
        if (this.hangUpWhenAudioStops) void this.hangUp();
        return;
      default:
        return;
    }
  }

  private onFunctionCall(call: FunctionCall | null): void {
    if (!call || this.handledCalls.has(call.callId)) return;
    this.handledCalls.add(call.callId);
    this.runningTools += 1;
    this.needsContinue = true;
    this.responseOpen = true;
    void this.runTool(call);
  }

  private async runTool(call: FunctionCall): Promise<void> {
    const { tools, recorder, staffPhone, mode } = this.options;
    const startedAt = Date.now();
    let output: string;
    try {
      output = await tools.execute(call.name, call.argsJson);
    } catch (err) {
      output = JSON.stringify({ error: err instanceof Error ? err.message : 'tool failed' });
    }
    if (call.name === 'transfer_to_staff' && !staffPhone) {
      output = JSON.stringify({
        status: 'unavailable',
        message: 'No staff line is configured. Apologize and offer to keep helping.'
      });
    }
    recorder.toolFinished(call.name, Date.now() - startedAt, toolSucceeded(output), menuSearchDetail(call, output));
    this.runningTools -= 1;
    if (this.ended) return;

    const item = { type: 'function_call_output', call_id: call.callId, output };
    this.send(
      mode === 'live'
        ? { type: 'response.item.create', event_id: randomUUID(), item }
        : { type: 'conversation.item.create', item }
    );
    if (call.name === 'end_call') this.endRequested = true;
    this.maybeContinue();

    if (call.name === 'end_call') {
      this.schedule(() => void this.hangUp());
    } else if (call.name === 'transfer_to_staff' && staffPhone) {
      this.schedule(() => void this.transfer(`tel:${staffPhone}`));
    }
  }

  private maybeContinue(): void {
    if (this.ended || !this.needsContinue || this.responseOpen || this.runningTools > 0) return;
    this.needsContinue = false;
    this.send(
      this.options.mode === 'live'
        ? { type: 'response.create', event_id: randomUUID() }
        : { type: 'response.create' }
    );
    // Once the goodbye that follows end_call has played, there is nothing left to wait for.
    if (this.endRequested) this.hangUpWhenAudioStops = true;
  }

  /** Runs an action after the configured delay, so the assistant's last line can play. */
  private schedule(action: () => void): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(action, this.options.hangupDelayMs);
  }

  private async hangUp(): Promise<void> {
    if (this.ended) return;
    this.hangUpWhenAudioStops = false;
    try {
      await this.options.client.hangup(this.options.mode, this.options.id);
    } catch (err) {
      safeLog('warn', 'voice_hangup_failed', {
        callId: this.options.id,
        error: err instanceof Error ? err.message : 'unknown'
      });
    }
    // The provider reports final usage when it closes the session; give it a moment.
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.finish('agent_hangup'), CLOSED_GRACE_MS);
  }

  private async transfer(targetUri: string): Promise<void> {
    if (this.ended) return;
    try {
      await this.options.client.refer(this.options.mode, this.options.id, targetUri);
      this.options.recorder.note('transferred');
    } catch (err) {
      safeLog('warn', 'voice_transfer_failed', {
        callId: this.options.id,
        error: err instanceof Error ? err.message : 'unknown'
      });
    }
  }

  private send(event: unknown): void {
    try {
      this.connection?.send(event);
    } catch (err) {
      safeLog('warn', 'voice_sideband_send_failed', {
        callId: this.options.id,
        error: err instanceof Error ? err.message : 'unknown'
      });
    }
  }

  async finish(reason: string): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    if (this.timer) clearTimeout(this.timer);
    this.connection?.close();
    const summary = await this.options.recorder.finish(reason);
    safeLog('info', 'voice_call_ended', {
      provider: summary.provider,
      callId: summary.callId,
      duration_ms: summary.durationMs,
      reason: summary.endReason,
      response_gaps_ms: summary.responseGapsMs,
      tool_calls: summary.toolCalls
    });
    this.options.onEnded?.();
  }
}

/** For menu searches, keeps what was asked and how many items came back. */
function menuSearchDetail(call: FunctionCall, output: string): Record<string, unknown> | undefined {
  if (call.name !== 'search_menu') return undefined;
  try {
    const args = JSON.parse(call.argsJson || '{}') as { query?: unknown };
    const result = JSON.parse(output) as { items?: unknown };
    return {
      query: typeof args.query === 'string' ? args.query : '',
      results: Array.isArray(result.items) ? result.items.length : null
    };
  } catch {
    return undefined;
  }
}
