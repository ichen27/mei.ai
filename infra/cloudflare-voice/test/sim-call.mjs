// Simulates a Telnyx phone call against the deployed voice agent, without a phone.
// It speaks scripted caller lines (synthesized with Workers AI), streams them as
// 8 kHz mu-law frames in real time the way Telnyx does, records what the agent
// says back, transcribes it, and reports how long each reply took to start.
//
// Usage: CF_ACCOUNT_ID=... CF_AI_TOKEN=... CARRIER_KEY=... node test/sim-call.mjs https://<worker> "line one" "line two"
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../../package.json', import.meta.url));
const WebSocket = require('ws');

const [base, ...lines] = process.argv.slice(2);
const { CF_ACCOUNT_ID, CF_AI_TOKEN, CARRIER_KEY } = process.env;
if (!base || lines.length === 0 || !CF_ACCOUNT_ID || !CF_AI_TOKEN || !CARRIER_KEY) {
  console.error('usage: CF_ACCOUNT_ID=... CF_AI_TOKEN=... CARRIER_KEY=... node test/sim-call.mjs <https worker url> "<caller line>"...');
  process.exit(2);
}
// Ask for call instructions exactly as the carrier does, and read the stream URL from them.
const instructions = await (await fetch(`${base}/voice?key=${encodeURIComponent(CARRIER_KEY)}&debug=1`, { method: 'POST' })).text();
const url = /<Stream url="([^"]+)"/.exec(instructions)?.[1]?.replaceAll('&amp;', '&');
if (!url) { console.error('no stream URL in call instructions:', instructions.slice(0, 200)); process.exit(1); }
const AI = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run`;
const auth = { Authorization: `Bearer ${CF_AI_TOKEN}`, 'Content-Type': 'application/json' };

const DECODE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const mu = ~i & 0xff;
  const s = ((((mu & 0x0f) << 3) + 132) << ((mu >> 4) & 7)) - 132;
  DECODE[i] = mu & 0x80 ? -s : s;
}
function encodeMulaw(v) {
  const sign = v < 0 ? 0x80 : 0;
  let s = Math.min(Math.abs(v), 32635) + 132;
  let e = 7;
  for (; e > 0; e--) { if (s & 0x4000) break; s <<= 1; }
  return ~(sign | (e << 4) | ((s >> 10) & 0x0f)) & 0xff;
}

async function speak(text) {
  const res = await fetch(`${AI}/@cf/deepgram/aura-2-en`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ text, speaker: 'orion', encoding: 'linear16', container: 'none', sample_rate: 8000 })
  });
  if (!res.ok) throw new Error(`caller TTS failed: ${res.status}`);
  const pcm = new Int16Array(await res.arrayBuffer());
  return Uint8Array.from(pcm, encodeMulaw);
}

async function transcribe(mulawChunks) {
  const total = mulawChunks.reduce((n, c) => n + c.length, 0);
  if (total < 800) return '';
  const pcm = new Int16Array(total);
  let o = 0;
  for (const c of mulawChunks) for (const b of c) pcm[o++] = DECODE[b];
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.byteLength, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24); header.writeUInt32LE(16000, 28); header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.byteLength, 40);
  const wav = Buffer.concat([header, Buffer.from(pcm.buffer)]);
  const res = await fetch(`${AI}/@cf/openai/whisper-large-v3-turbo`, {
    method: 'POST', headers: auth, body: JSON.stringify({ audio: wav.toString('base64') })
  });
  const body = await res.json().catch(() => ({}));
  return body?.result?.text?.trim() ?? `(transcription failed: ${res.status})`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FRAME = 160; // 20 ms of 8 kHz mu-law
const SILENCE = Buffer.alloc(FRAME, 0xff).toString('base64');

const callerAudio = [];
for (const line of lines) callerAudio.push(await speak(line));

const ws = new WebSocket(url);
let received = [];
let lastMediaAt = 0;
let firstMediaAt = 0;
let outgoing = null; // { frames, index }
let closed = false;
const t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(2).padStart(6);

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.event === 'media') {
    const bytes = Buffer.from(msg.media.payload, 'base64');
    if (!firstMediaAt) firstMediaAt = Date.now();
    lastMediaAt = Date.now() + (bytes.length / 8000) * 1000; // when this chunk would finish playing
    received.push(bytes);
  } else if (msg.event === 'debug') {
    const m = msg.message;
    if (m.type === 'diagnostic') console.log(`[${at()}s]    . ${m.event} ${JSON.stringify(m.data)}`);
    else if (m.type === 'transcript' && m.role === 'user') console.log(`[${at()}s]    . agent heard: "${m.text}"`);
    else if (m.type === 'metrics' || m.type === 'turn_metrics' || m.type === 'error') console.log(`[${at()}s]    . ${m.type} ${JSON.stringify(m)}`);
  } else if (msg.event === 'clear') {
    console.log(`[${at()}s] agent cleared its playback (it heard an interruption)`);
  }
});
ws.on('close', (code) => { closed = true; console.log(`[${at()}s] stream closed (code ${code})`); });
ws.on('error', (err) => { console.error('socket error:', err.message); });
await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });

const callId = `sim-${Date.now()}`;
ws.send(JSON.stringify({ event: 'connected', version: '1.0.0' }));
ws.send(JSON.stringify({ event: 'start', stream_id: callId, start: { call_control_id: callId, media_format: { encoding: 'PCMU', sample_rate: 8000, channels: 1 } } }));

// A phone line never stops sending audio, so pump a frame every 20 ms: speech when
// a line is queued, silence otherwise.
const pump = setInterval(() => {
  if (closed || ws.readyState !== WebSocket.OPEN) return;
  let payload = SILENCE;
  if (outgoing) {
    const start = outgoing.index * FRAME;
    const frame = Buffer.alloc(FRAME, 0xff);
    Buffer.from(outgoing.audio.subarray(start, start + FRAME)).copy(frame);
    payload = frame.toString('base64');
    outgoing.index += 1;
    if (outgoing.index * FRAME >= outgoing.audio.length) { outgoing.done(); outgoing = null; }
  }
  ws.send(JSON.stringify({ event: 'media', stream_id: callId, media: { track: 'inbound', payload } }));
}, 20);

// Waits for the agent to start talking, then for it to finish (no audio left to play).
async function agentTurn(label, sinceMs, timeoutMs = 30000) {
  received = []; firstMediaAt = 0; lastMediaAt = 0;
  const deadline = Date.now() + timeoutMs;
  while (!firstMediaAt && Date.now() < deadline && !closed) await sleep(20);
  if (!firstMediaAt) { console.log(`[${at()}s] ${label}: no audio from the agent within ${timeoutMs / 1000}s`); return null; }
  const gapMs = firstMediaAt - sinceMs;
  while (Date.now() < lastMediaAt + 1200 && !closed) await sleep(50);
  const text = await transcribe(received);
  console.log(`[${at()}s] ${label}: reply started after ${gapMs} ms\n          agent said: "${text}"`);
  return gapMs;
}

const gaps = [];
await agentTurn('greeting', t0);
for (let i = 0; i < lines.length && !closed; i++) {
  console.log(`[${at()}s] caller says: "${lines[i]}"`);
  const finished = new Promise((done) => { outgoing = { audio: callerAudio[i], index: 0, done }; });
  await finished;
  const gap = await agentTurn(`reply ${i + 1}`, Date.now());
  if (gap !== null) gaps.push(gap);
}
clearInterval(pump);
if (!closed) { ws.send(JSON.stringify({ event: 'stop', stream_id: callId })); await sleep(300); ws.close(); }
console.log(`\nreply gaps (ms): ${gaps.join(', ') || 'none'}; call id ${callId}`);
process.exit(0);
