// Carrier line check: returns call instructions (TeXML, Telnyx's TwiML-compatible
// format) that speak a confirmation and hang up. It holds no state and no secrets.
const TEXML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>This is the may test line. The phone number is connected, but no voice agent is attached yet. Goodbye.</Say>
  <Hangup/>
</Response>`;

export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === '/health') {
      return Response.json({ ok: true, service: 'mei-ai-line-check' });
    }
    if (pathname === '/voice' && (request.method === 'POST' || request.method === 'GET')) {
      return new Response(TEXML, { headers: { 'content-type': 'application/xml; charset=utf-8' } });
    }
    return new Response('Not found', { status: 404 });
  }
};
