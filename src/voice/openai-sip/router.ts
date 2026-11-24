import express, { type Router } from 'express';
import { safeLog } from '../../logger.js';
import type { PromptChangeRules, PromptMenuItem } from '../../workers/call-prompt.js';
import { CallToolHandler } from '../../workers/call-tools.js';
import { CallRecorder } from '../call-recorder.js';
import type { OpenAiSipClient } from './client.js';
import {
  buildLiveAcceptBody,
  buildRealtimeAcceptBody,
  type OpenAiSipConfig,
  type SipMode
} from './config.js';
import { SipCallSession, type ToolRunner } from './session.js';
import { verifyWebhook } from './webhook.js';

const MAX_REMEMBERED_DELIVERIES = 2000;

export interface IncomingCall {
  mode: SipMode;
  id: string;
  callerPhone: string;
  headers: Array<{ name: string; value: string }>;
}

export interface OpenAiSipRouterDeps {
  config: OpenAiSipConfig;
  client: OpenAiSipClient;
  /** Override the order tools; defaults to the internal ordering API. */
  createTools?: (call: IncomingCall) => ToolRunner;
  /**
   * Menu to put in the agent's instructions; defaults to the internal ordering
   * API. Return undefined to leave the menu out and rely on search_menu.
   */
  loadMenu?: () => Promise<LoadedMenu | undefined>;
}

/** The menu and the restaurant's change rules, as the prompt needs them. */
export interface LoadedMenu {
  items: PromptMenuItem[];
  changeRules?: PromptChangeRules;
}

const MENU_CACHE_MS = 60_000;
const MENU_TIMEOUT_MS = 2000;

/**
 * Loads the menu from the internal ordering API, cached briefly so a burst of
 * calls does not refetch it. A failure never blocks answering the call.
 */
export function createMenuLoader(config: OpenAiSipConfig): () => Promise<LoadedMenu | undefined> {
  let cached: { at: number; menu: LoadedMenu } | undefined;
  return async () => {
    if (cached && Date.now() - cached.at < MENU_CACHE_MS) return cached.menu;
    try {
      const res = await fetch(`${config.apiBaseUrl}/api/internal/stores/${encodeURIComponent(config.storeId)}/menu`, {
        headers: { 'x-internal-api-key': config.internalApiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(MENU_TIMEOUT_MS)
      });
      if (!res.ok) throw new Error(`menu request returned ${res.status}`);
      const body = (await res.json()) as { items?: PromptMenuItem[]; change_rules?: PromptChangeRules };
      if (!Array.isArray(body.items)) throw new Error('menu response has no items');
      cached = {
        at: Date.now(),
        menu: { items: body.items, ...(body.change_rules ? { changeRules: body.change_rules } : {}) }
      };
      return cached.menu;
    } catch (err) {
      safeLog('warn', 'voice_menu_load_failed', { error: err instanceof Error ? err.message : 'unknown' });
      return cached?.menu;
    }
  };
}

function sipHeaders(data: Record<string, unknown>): Array<{ name: string; value: string }> {
  if (!Array.isArray(data.sip_headers)) return [];
  return data.sip_headers.flatMap((header: unknown) => {
    const record = header && typeof header === 'object' ? (header as Record<string, unknown>) : null;
    return record && typeof record.name === 'string' && typeof record.value === 'string'
      ? [{ name: record.name, value: record.value }]
      : [];
  });
}

/** Reads an incoming-call event. SIP header values come from the caller's network: untrusted. */
export function parseIncomingCall(event: unknown): IncomingCall | null {
  const record = event && typeof event === 'object' ? (event as Record<string, unknown>) : null;
  const data = record?.data && typeof record.data === 'object' ? (record.data as Record<string, unknown>) : null;
  if (!record || !data) return null;

  let mode: SipMode;
  let id: unknown;
  if (record.type === 'live.transport.incoming' && data.type === 'sip') {
    mode = 'live';
    id = data.session_id;
  } else if (record.type === 'live.call.incoming') {
    mode = 'live';
    id = data.session_id;
  } else if (record.type === 'realtime.call.incoming') {
    mode = 'realtime';
    id = data.call_id;
  } else {
    return null;
  }
  if (typeof id !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(id)) return null;

  const headers = sipHeaders(data);
  const from = headers.find((header) => header.name.toLowerCase() === 'from')?.value ?? '';
  const callerPhone = /sip:(\+?\d{7,15})@/.exec(from)?.[1] ?? 'unknown';
  return { mode, id, callerPhone, headers };
}

/**
 * OpenAI may announce one phone call through both the GPT-Live and the Realtime
 * event. Exactly one may answer, so each call resolves to a single mode: the one
 * pinned to the called number if any header names it, else the default.
 */
export function resolveMode(config: OpenAiSipConfig, call: IncomingCall): SipMode {
  for (const [number, mode] of config.numberModes) {
    const digits = number.replace(/^\+/, '');
    const named = call.headers.some(
      (header) => header.name.toLowerCase() !== 'from' && header.value.includes(digits)
    );
    if (named) return mode;
  }
  return config.defaultMode;
}

export function createOpenAiSipRouter(deps: OpenAiSipRouterDeps): {
  router: Router;
  activeCalls: Map<string, SipCallSession>;
} {
  const { config, client } = deps;
  const router = express.Router();
  const activeCalls = new Map<string, SipCallSession>();
  const deliveries = new Set<string>();

  const createTools =
    deps.createTools ??
    ((call: IncomingCall): ToolRunner =>
      new CallToolHandler({
        apiBaseUrl: config.apiBaseUrl,
        internalApiKey: config.internalApiKey,
        storeId: config.storeId,
        callerPhone: call.callerPhone,
        callSid: call.id
      }));

  const loadMenu = deps.loadMenu ?? createMenuLoader(config);

  async function answer(call: IncomingCall): Promise<void> {
    const recorder = new CallRecorder(`openai-${call.mode}`, call.id, config.recordDir);
    recorder.note('incoming', {
      model: call.mode === 'live' ? config.liveModel : config.realtimeModel,
      header_names: call.headers.map((header) => header.name)
    });
    const session = new SipCallSession({
      mode: call.mode,
      id: call.id,
      client,
      tools: createTools(call),
      recorder,
      staffPhone: config.staffPhone,
      hangupDelayMs: config.hangupDelayMs,
      onEnded: () => activeCalls.delete(call.id)
    });
    activeCalls.set(call.id, session);
    const startedAt = Date.now();
    try {
      const menu = await loadMenu();
      await client.accept(
        call.mode,
        call.id,
        call.mode === 'live'
          ? buildLiveAcceptBody(config, menu?.items, menu?.changeRules)
          : buildRealtimeAcceptBody(config, menu?.items, menu?.changeRules)
      );
      recorder.note('accepted', {
        ms: Date.now() - startedAt,
        menu_items: menu?.items.length ?? 0,
        change_rules: menu?.changeRules?.rules.length ?? 0
      });
      await session.start();
      safeLog('info', 'voice_call_started', { provider: `openai-${call.mode}`, callId: call.id });
    } catch (err) {
      safeLog('error', 'voice_call_setup_failed', {
        provider: `openai-${call.mode}`,
        callId: call.id,
        error: err instanceof Error ? err.message : 'unknown'
      });
      await client.hangup(call.mode, call.id).catch(() => undefined);
      await session.finish('setup_failed');
    }
  }

  router.post('/', express.raw({ type: () => true, limit: '256kb' }), (req, res) => {
    if (!config.apiKey || !config.webhookSecret) {
      res.status(503).json({ error: { code: 'VOICE_NOT_CONFIGURED', message: 'voice provider is not configured' } });
      return;
    }
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    let deliveryId: string;
    try {
      deliveryId = verifyWebhook(body, req.headers, config.webhookSecret);
    } catch {
      res.status(400).json({ error: { code: 'INVALID_SIGNATURE', message: 'invalid webhook signature' } });
      return;
    }
    if (deliveries.has(deliveryId)) {
      res.json({ ok: true, duplicate: true });
      return;
    }
    deliveries.add(deliveryId);
    if (deliveries.size > MAX_REMEMBERED_DELIVERIES) {
      const oldest = deliveries.values().next().value;
      if (oldest !== undefined) deliveries.delete(oldest);
    }

    let call: IncomingCall | null = null;
    try {
      call = parseIncomingCall(JSON.parse(body.toString('utf8')));
    } catch {
      call = null;
    }
    if (!call || call.mode !== resolveMode(config, call) || activeCalls.has(call.id)) {
      res.json({ ok: true, ignored: true });
      return;
    }
    // Acknowledge first: OpenAI retries slow or failed deliveries, and the call
    // itself is answered through a separate request.
    res.json({ ok: true });
    void answer(call);
  });

  return { router, activeCalls };
}
