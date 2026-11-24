import { DurableObject } from 'cloudflare:workers';

const KEEP = 50;

/**
 * Keeps the most recent call records (transcripts, tool calls, timings) so a
 * phone test can be reviewed afterwards. Transcripts are caller speech; the
 * read endpoint is key-protected and old records are dropped.
 */
export class CallLog extends DurableObject {
  async append(record: unknown): Promise<void> {
    const key = `call:${String(Date.now()).padStart(15, '0')}:${crypto.randomUUID().slice(0, 8)}`;
    await this.ctx.storage.put(key, record);
    const all = await this.ctx.storage.list({ prefix: 'call:' });
    const excess = [...all.keys()].slice(0, Math.max(0, all.size - KEEP));
    if (excess.length) await this.ctx.storage.delete(excess);
  }

  async recent(limit: number): Promise<unknown[]> {
    const all = await this.ctx.storage.list({ prefix: 'call:', reverse: true, limit });
    return [...all.values()];
  }
}
