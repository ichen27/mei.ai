import type { Env } from './env';
import { handleTelnyxStream } from './telnyx-adapter';

export { MeiVoiceAgent } from './agent';
export { CallLog } from './call-log';

const TOKEN_TTL_SECONDS = 60;

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sign(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
}

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** A token that lets one call open its audio stream for the next minute. */
async function issueStreamToken(env: Env): Promise<string> {
  const expires = String(Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS);
  return `${expires}.${await sign(env.STREAM_SIGNING_KEY, expires)}`;
}

async function validStreamToken(env: Env, token: string | null): Promise<boolean> {
  const [expires, signature] = (token ?? '').split('.');
  if (!expires || !signature || !/^\d+$/.test(expires)) return false;
  if (Number(expires) < Date.now() / 1000) return false;
  return sameText(signature, await sign(env.STREAM_SIGNING_KEY, expires));
}

/** Call instructions for Telnyx: stream the call's audio both ways, then hang up. */
function callInstructions(host: string, token: string, debug: boolean): string {
  const url = `wss://${host}/telnyx?token=${token}${debug ? '&amp;debug=1' : ''}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${url}" track="inbound_track" codec="PCMU" bidirectionalMode="rtp" bidirectionalCodec="PCMU" />
  </Connect>
  <Hangup/>
</Response>`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return Response.json({ ok: true, service: 'mei-ai-cloudflare-voice' });
    }
    // Both secrets must be set, or the phone endpoints stay closed.
    const configured = Boolean(env.CARRIER_KEY && env.STREAM_SIGNING_KEY);
    if (url.pathname === '/voice') {
      if (!configured || !sameText(url.searchParams.get('key') ?? '', env.CARRIER_KEY)) {
        return new Response('Forbidden', { status: 403 });
      }
      const debug = url.searchParams.get('debug') === '1';
      return new Response(callInstructions(url.host, await issueStreamToken(env), debug), {
        headers: { 'content-type': 'application/xml; charset=utf-8' }
      });
    }
    if (url.pathname === '/calls/recent') {
      if (!configured || !sameText(url.searchParams.get('key') ?? '', env.CARRIER_KEY)) {
        return new Response('Forbidden', { status: 403 });
      }
      const log = env.CallLog.get(env.CallLog.idFromName('recent')) as unknown as {
        recent(limit: number): Promise<unknown[]>;
      };
      return Response.json({ calls: await log.recent(Math.min(Number(url.searchParams.get('limit') ?? 5), 50)) });
    }
    if (url.pathname === '/telnyx') {
      if (!configured || !(await validStreamToken(env, url.searchParams.get('token')))) {
        return new Response('Forbidden', { status: 403 });
      }
      return handleTelnyxStream(request, env, url.searchParams.get('debug') === '1');
    }
    // The voice agent is reached only through the token-checked audio stream above.
    // It is deliberately not exposed on the SDK's public /agents/* route.
    return new Response('Not found', { status: 404 });
  }
};
