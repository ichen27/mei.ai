import WebSocket from 'ws';
import type { SipMode } from './config.js';

const API = 'https://api.openai.com/v1';
const WSS = 'wss://api.openai.com/v1';

export interface SidebandConnection {
  send(event: unknown): void;
  close(): void;
}

export interface SidebandHandlers {
  onEvent(event: Record<string, unknown>): void;
  onClose(): void;
}

/** The OpenAI operations a call needs. Faked in tests. */
export interface OpenAiSipClient {
  accept(mode: SipMode, id: string, body: unknown): Promise<void>;
  hangup(mode: SipMode, id: string): Promise<void>;
  refer(mode: SipMode, id: string, targetUri: string): Promise<void>;
  attach(mode: SipMode, id: string, handlers: SidebandHandlers): Promise<SidebandConnection>;
}

export class OpenAiSipError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    detail: string
  ) {
    super(`OpenAI ${operation} failed with ${status}: ${detail}`);
  }
}

function callPath(mode: SipMode, id: string): string {
  const safe = encodeURIComponent(id);
  return mode === 'live' ? `/live/sessions/${safe}` : `/realtime/calls/${safe}`;
}

function sidebandUrl(mode: SipMode, id: string): string {
  const safe = encodeURIComponent(id);
  return mode === 'live' ? `${WSS}/live/sessions/${safe}/attach` : `${WSS}/realtime?call_id=${safe}`;
}

export function createOpenAiSipClient(apiKey: string): OpenAiSipClient {
  async function post(operation: string, path: string, body?: unknown): Promise<void> {
    const response = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 500);
      throw new OpenAiSipError(operation, response.status, detail);
    }
  }

  return {
    accept: (mode, id, body) => post('accept', `${callPath(mode, id)}/accept`, body),
    hangup: (mode, id) => post('hangup', `${callPath(mode, id)}/hangup`),
    refer: (mode, id, targetUri) => post('refer', `${callPath(mode, id)}/refer`, { target_uri: targetUri }),
    async attach(mode, id, handlers) {
      const ws = new WebSocket(sidebandUrl(mode, id), {
        headers: { Authorization: `Bearer ${apiKey}` },
        handshakeTimeout: 15000,
        maxPayload: 4 * 1024 * 1024
      });
      ws.on('message', (data) => {
        try {
          const event: unknown = JSON.parse(data.toString());
          if (event && typeof event === 'object') handlers.onEvent(event as Record<string, unknown>);
        } catch {
          handlers.onEvent({ type: 'error', error: { message: 'unparseable sideband message' } });
        }
      });
      ws.on('close', () => handlers.onClose());
      await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
      // After the handshake, a socket error is followed by 'close', which ends the call.
      ws.on('error', () => undefined);
      return {
        send(event) {
          if (ws.readyState !== WebSocket.OPEN) throw new Error('OpenAI sideband is not open');
          ws.send(JSON.stringify(event));
        },
        close() {
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
        }
      };
    }
  };
}
