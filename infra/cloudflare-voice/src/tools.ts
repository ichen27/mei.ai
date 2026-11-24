import type { Env } from './env';

/**
 * Runs the shared order tools against the mei.ai ordering API. This mirrors
 * src/workers/call-tools.ts, which depends on Node-only modules and cannot be
 * bundled into a Worker. Results are JSON strings handed back to the model.
 */
export class OrderTools {
  constructor(
    private readonly env: Env,
    private readonly callId: string,
    private readonly callerPhone: string
  ) {}

  async execute(name: string, argsJson: string): Promise<string> {
    try {
      const args = (argsJson ? JSON.parse(argsJson) : {}) as Record<string, unknown>;
      switch (name) {
        case 'get_store_mode':
          return await this.get(`/api/internal/stores/${this.env.STORE_ID}`);
        case 'search_menu':
          return await this.get(
            `/api/internal/stores/${this.env.STORE_ID}/menu?q=${encodeURIComponent(String(args.query ?? ''))}`
          );
        case 'create_order':
          return await this.post('/api/internal/orders', {
            store_id: this.env.STORE_ID,
            call_id: this.callId,
            customer_name: args.customer_name,
            customer_phone: this.callerPhone,
            items: args.items,
            ...(typeof args.notes === 'string' && args.notes ? { notes: args.notes } : {})
          });
        case 'transfer_to_staff':
          return JSON.stringify({
            status: 'unavailable',
            message: 'No staff line is configured. Apologize and offer to keep helping.'
          });
        case 'end_call':
          return JSON.stringify({ status: 'ending', reason: args.reason ?? '' });
        default:
          return JSON.stringify({ error: `unknown tool: ${name}` });
      }
    } catch (err) {
      return JSON.stringify({ error: err instanceof Error ? err.message : 'tool failed' });
    }
  }

  private headers(): Record<string, string> {
    return { 'x-internal-api-key': this.env.INTERNAL_API_KEY, Accept: 'application/json' };
  }

  private async get(path: string): Promise<string> {
    const res = await fetch(`${this.env.ORDER_API_BASE_URL}${path}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`ordering API returned ${res.status}`);
    return res.text();
  }

  private async post(path: string, body: unknown): Promise<string> {
    const res = await fetch(`${this.env.ORDER_API_BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        ...this.headers(),
        'Content-Type': 'application/json',
        'Idempotency-Key': crypto.randomUUID()
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`ordering API returned ${res.status}`);
    return res.text();
  }
}
