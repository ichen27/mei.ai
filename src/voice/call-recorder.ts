import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { safeLog } from '../logger.js';

export interface CallSummary {
  provider: string;
  callId: string;
  durationMs: number;
  endReason: string;
  /** Milliseconds from the caller's last words to the assistant's next words, per turn. */
  responseGapsMs: number[];
  toolCalls: Array<{ name: string; ms: number; ok: boolean }>;
  callerTranscript: string;
  assistantTranscript: string;
  usage?: unknown[];
}

/**
 * Collects what happened on one call so providers can be compared afterwards:
 * transcripts, tool timings, and the gap between the caller finishing and the
 * assistant starting to answer. Writes one JSON line per event when a directory
 * is configured. Transcripts are caller speech: keep the directory out of Git.
 */
export class CallRecorder {
  private readonly startedAt = Date.now();
  private readonly gaps: number[] = [];
  private readonly tools: Array<{ name: string; ms: number; ok: boolean }> = [];
  private callerText_ = '';
  private assistantText_ = '';
  private lastCallerAt: number | null = null;
  private writes: Promise<void> = Promise.resolve();
  private readonly usage: unknown[] = [];

  constructor(
    private readonly provider: string,
    private readonly callId: string,
    private readonly dir: string
  ) {}

  private write(type: string, data: Record<string, unknown>): void {
    if (!this.dir) return;
    const file = join(this.dir, `${this.provider}-${this.callId.replace(/[^A-Za-z0-9_-]/g, '_')}.jsonl`);
    const line = JSON.stringify({ t: Date.now() - this.startedAt, type, ...data }) + '\n';
    this.writes = this.writes
      .then(() => mkdir(this.dir, { recursive: true, mode: 0o700 }))
      .then(() => appendFile(file, line, { mode: 0o600 }))
      .catch((err: unknown) => {
        safeLog('warn', 'call_record_write_failed', { error: err instanceof Error ? err.message : 'unknown' });
      });
  }

  note(type: string, data: Record<string, unknown> = {}): void {
    this.write(type, data);
  }

  callerText(text: string): void {
    this.callerText_ += text;
    this.write('caller', { text });
  }

  assistantText(text: string): void {
    this.assistantText_ += text;
    this.write('assistant', { text });
  }

  /** Marks when the caller stopped speaking, on the provider's clock when it gives one. */
  callerStopped(atMs: number = Date.now()): void {
    this.lastCallerAt = atMs;
  }

  /** Marks when the assistant started answering; records the gap since the caller stopped. */
  assistantStarted(atMs: number = Date.now()): void {
    if (this.lastCallerAt === null) return;
    const gap = atMs - this.lastCallerAt;
    this.lastCallerAt = null;
    if (gap >= 0) {
      this.gaps.push(gap);
      this.write('response_gap', { ms: gap });
    }
  }

  toolFinished(name: string, ms: number, ok: boolean): void {
    this.tools.push({ name, ms, ok });
    this.write('tool', { name, ms, ok });
  }

  addUsage(usage: unknown): void {
    if (usage !== undefined && usage !== null) this.usage.push(usage);
  }

  async finish(endReason: string): Promise<CallSummary> {
    const summary: CallSummary = {
      provider: this.provider,
      callId: this.callId,
      durationMs: Date.now() - this.startedAt,
      endReason,
      responseGapsMs: this.gaps,
      toolCalls: this.tools,
      callerTranscript: this.callerText_.trim(),
      assistantTranscript: this.assistantText_.trim(),
      ...(this.usage.length === 0 ? {} : { usage: this.usage })
    };
    this.write('summary', { ...summary });
    await this.writes;
    return summary;
  }
}
