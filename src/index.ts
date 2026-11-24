import { createServer } from 'node:http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { createApp } from './app.js';
import { RealtimeGateway } from './realtime/gateway.js';
import { handleNewTwilioConnection, type CallWorkerConfig } from './workers/call.js';
import type { CallSession } from './workers/call-session.js';
import { safeLog } from './logger.js';
import { createOpenAiSipClient } from './voice/openai-sip/client.js';
import { readOpenAiSipConfig } from './voice/openai-sip/config.js';
import { createOpenAiSipRouter } from './voice/openai-sip/router.js';
import { createStaffWebRouter } from './http/staffWeb.js';

const port = Number(process.env.PORT ?? 3000);
const realtimeGateway = new RealtimeGateway();
const { app, authService } = createApp({ realtimeGateway });

// --- OpenAI phone calls over SIP ---
// OpenAI carries the call audio and notifies this webhook when a call arrives.
// It is mounted ahead of the app so the signature check sees the raw body.
const openAiSipConfig = readOpenAiSipConfig(process.env, port);
const openAiSip = createOpenAiSipRouter({
  config: openAiSipConfig,
  client: createOpenAiSipClient(openAiSipConfig.apiKey)
});
const root = express();
root.use('/api/webhooks/openai', openAiSip.router);

// --- Staff dashboard ---
// Served from this process when it has been built (npm run staff:web:build).
const staffWeb = createStaffWebRouter(process.env.STAFF_WEB_DIR ?? 'apps/staff-web/dist');
if (staffWeb) root.use(staffWeb);

root.use(app);
const server = createServer(root);

// --- Media Stream WebSocket for Twilio calls ---
const callWorkerConfig: CallWorkerConfig = {
  port,
  apiBaseUrl: `http://localhost:${port}`,
  internalApiKey: process.env.INTERNAL_API_KEY ?? '',
  openaiApiKey: process.env.OPENAI_API_KEY ?? '',
  openaiModel: process.env.OPENAI_REALTIME_MODEL ?? 'gpt-4o-realtime-preview',
  openaiVoice: process.env.OPENAI_VOICE ?? 'alloy',
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID ?? '',
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN ?? '',
};
const activeSessions = new Map<string, CallSession>();
const mediaWss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', `http://localhost:${port}`);

  if (url.pathname === '/media-stream') {
    mediaWss.handleUpgrade(request, socket, head, (ws) => {
      handleNewTwilioConnection(ws, callWorkerConfig, activeSessions);
    });
    return;
  }

  // Realtime gateway handles /ws
  const headers: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    headers[key.toLowerCase()] = value;
  }
  realtimeGateway.attachUpgrade(request.url, headers, socket, authService);
});

// HOST limits which interface accepts connections, e.g. 127.0.0.1 behind a proxy.
const host = process.env.HOST;
const onListening = () => console.log(`mei.ai listening on ${host ?? '*'}:${port}`);
if (host) server.listen(port, host, onListening);
else server.listen(port, onListening);
