import { createHmac } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { CallRecorder } from '../src/voice/call-recorder.js';
import type { OpenAiSipClient, SidebandHandlers } from '../src/voice/openai-sip/client.js';
import {
  buildLiveAcceptBody,
  buildRealtimeAcceptBody,
  readOpenAiSipConfig,
  type OpenAiSipConfig,
  type SipMode
} from '../src/voice/openai-sip/config.js';
import { createOpenAiSipRouter, parseIncomingCall, resolveMode } from '../src/voice/openai-sip/router.js';
import { SipCallSession } from '../src/voice/openai-sip/session.js';
import { verifyWebhook } from '../src/voice/openai-sip/webhook.js';
import type { PromptMenuItem } from '../src/workers/call-prompt.js';

const SECRET = 'whsec_' + Buffer.from('test-signing-key').toString('base64');

function sign(body: string, id = 'msg_1', timestamp = Math.floor(Date.now() / 1000)) {
  const key = Buffer.from(SECRET.replace('whsec_', ''), 'base64');
  const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  return {
    'webhook-id': id,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': `v1,${signature}`
  };
}

function config(overrides: Partial<OpenAiSipConfig> = {}): OpenAiSipConfig {
  return {
    ...readOpenAiSipConfig({ OPENAI_API_KEY: 'sk-test', OPENAI_WEBHOOK_SECRET: SECRET }, 3000),
    hangupDelayMs: 5,
    ...overrides
  };
}

function fakeClient() {
  const sent: unknown[] = [];
  const calls: string[] = [];
  let handlers: SidebandHandlers | null = null;
  const client: OpenAiSipClient = {
    accept: vi.fn(async (mode: SipMode, id: string) => {
      calls.push(`accept:${mode}:${id}`);
    }),
    hangup: vi.fn(async (mode: SipMode, id: string) => {
      calls.push(`hangup:${mode}:${id}`);
    }),
    refer: vi.fn(async (mode: SipMode, id: string, target: string) => {
      calls.push(`refer:${mode}:${id}:${target}`);
    }),
    attach: vi.fn(async (_mode: SipMode, _id: string, h: SidebandHandlers) => {
      handlers = h;
      return { send: (event: unknown) => void sent.push(event), close: () => undefined };
    })
  };
  return { client, sent, calls, emit: (event: Record<string, unknown>) => handlers?.onEvent(event) };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

function liveIncoming(id = 'live_123') {
  return JSON.stringify({
    type: 'live.transport.incoming',
    data: {
      type: 'sip',
      session_id: id,
      sip_headers: [
        { name: 'From', value: 'sip:+14155550123@sip.example.com' },
        { name: 'To', value: 'sip:proj_abc@sip.api.openai.com' }
      ]
    }
  });
}

describe('verifyWebhook', () => {
  it('accepts a correctly signed delivery and returns its id', () => {
    const body = '{"type":"x"}';
    expect(verifyWebhook(Buffer.from(body), sign(body), SECRET)).toBe('msg_1');
  });

  it('rejects a changed body, a wrong secret, and an old timestamp', () => {
    const body = '{"type":"x"}';
    expect(() => verifyWebhook(Buffer.from(body + ' '), sign(body), SECRET)).toThrow('invalid');
    const other = 'whsec_' + Buffer.from('another-key').toString('base64');
    expect(() => verifyWebhook(Buffer.from(body), sign(body), other)).toThrow('invalid');
    const old = Math.floor(Date.now() / 1000) - 3600;
    expect(() => verifyWebhook(Buffer.from(body), sign(body, 'msg_2', old), SECRET)).toThrow('expired');
  });

  it('rejects missing headers', () => {
    expect(() => verifyWebhook(Buffer.from('{}'), {}, SECRET)).toThrow('invalid');
  });
});

describe('accept bodies', () => {
  it('gives GPT-Live the shared prompt and tools through its backend model', () => {
    const body = buildLiveAcceptBody(config({ storeName: 'Golden Wok' })) as {
      session: {
        model: string;
        instructions: string;
        delegation: { type: string; responses: { tools: unknown[]; instructions: string } };
      };
    };
    expect(body.session.model).toBe('gpt-live-1.1');
    expect(body.session.instructions).toContain('Golden Wok');
    expect(body.session.delegation.type).toBe('responses');
    expect(body.session.delegation.responses.tools).toHaveLength(5);
    expect(body.session.delegation.responses.instructions).toContain('PICKUP ONLY');
  });

  it('gives Realtime the same prompt and tools directly', () => {
    const body = buildRealtimeAcceptBody(config({ storeName: 'Golden Wok' })) as {
      type: string;
      model: string;
      instructions: string;
      tools: unknown[];
    };
    expect(body.type).toBe('realtime');
    expect(body.model).toBe('gpt-realtime-2.1');
    expect(body.instructions).toContain('Golden Wok');
    expect(body.tools).toHaveLength(5);
  });

  it('puts the menu in both GPT-Live models and in Realtime when one is given', () => {
    const menu: PromptMenuItem[] = [
      { id: 'soup-1', name: 'Wonton Soup (Pint)', price_cents: 395, category: 'Soup' },
      { id: 'soup-2', name: 'Egg Drop Soup (Pint)', price_cents: 375, category: 'Soup', is_available: false }
    ];
    const live = buildLiveAcceptBody(config(), menu) as {
      session: { instructions: string; delegation: { responses: { instructions: string } } };
    };
    for (const text of [live.session.instructions, live.session.delegation.responses.instructions]) {
      expect(text).toContain('Wonton Soup (Pint) | $3.95 | id: soup-1');
      expect(text).not.toContain('Egg Drop Soup');
    }
    expect(live.session.instructions).toContain('Answer menu questions yourself');
    const realtime = buildRealtimeAcceptBody(config(), menu) as { instructions: string };
    expect(realtime.instructions).toContain('id: soup-1');
  });
});

describe('readOpenAiSipConfig secrets', () => {
  it('reads a key from the file named by NAME_FILE when NAME is unset', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const file = join(mkdtempSync(join(tmpdir(), 'mei-key-')), 'key');
    writeFileSync(file, 'sk-from-file\n');
    expect(readOpenAiSipConfig({ OPENAI_API_KEY_FILE: file }, 3000).apiKey).toBe('sk-from-file');
    expect(readOpenAiSipConfig({ OPENAI_API_KEY: 'sk-direct', OPENAI_API_KEY_FILE: file }, 3000).apiKey).toBe('sk-direct');
    expect(readOpenAiSipConfig({ OPENAI_API_KEY_FILE: join(file, 'missing') }, 3000).apiKey).toBe('');
  });
});

describe('incoming call parsing', () => {
  it('reads both event types and the caller number', () => {
    expect(parseIncomingCall(JSON.parse(liveIncoming()))).toMatchObject({
      mode: 'live',
      id: 'live_123',
      callerPhone: '+14155550123'
    });
    expect(
      parseIncomingCall({ type: 'realtime.call.incoming', data: { call_id: 'rtc_9', sip_headers: [] } })
    ).toMatchObject({ mode: 'realtime', id: 'rtc_9', callerPhone: 'unknown' });
  });

  it('ignores other events and unsafe ids', () => {
    expect(parseIncomingCall({ type: 'response.completed', data: {} })).toBeNull();
    expect(parseIncomingCall({ type: 'realtime.call.incoming', data: { call_id: '../x' } })).toBeNull();
  });

  it('pins a mode to a called number when a header names it', () => {
    const cfg = config({ defaultMode: 'live', numberModes: new Map([['+16075550100', 'realtime']]) });
    const call = parseIncomingCall({
      type: 'realtime.call.incoming',
      data: { call_id: 'rtc_1', sip_headers: [{ name: 'X-Called', value: 'sip:16075550100@carrier' }] }
    });
    expect(call && resolveMode(cfg, call)).toBe('realtime');
    const other = parseIncomingCall(JSON.parse(liveIncoming()));
    expect(other && resolveMode(cfg, other)).toBe('live');
  });
});

describe('webhook route', () => {
  function app(cfg = config(), fake = fakeClient(), menu?: PromptMenuItem[]) {
    const tools = { execute: vi.fn(async () => '{"ok":true}') };
    const { router, activeCalls } = createOpenAiSipRouter({
      config: cfg,
      client: fake.client,
      createTools: () => tools,
      loadMenu: async () => menu
    });
    const server = express();
    server.use('/api/webhooks/openai', router);
    return { server, fake, activeCalls };
  }

  it('answers a signed call once and ignores a repeated delivery', async () => {
    const { server, fake } = app();
    const body = liveIncoming();
    const headers = sign(body);
    const first = await request(server).post('/api/webhooks/openai').set(headers).type('json').send(body);
    expect(first.status).toBe(200);
    await tick();
    const second = await request(server).post('/api/webhooks/openai').set(headers).type('json').send(body);
    expect(second.body.duplicate).toBe(true);
    expect(fake.calls).toEqual(['accept:live:live_123']);
    expect(fake.client.attach).toHaveBeenCalledTimes(1);
  });

  it('answers with the loaded menu in the instructions', async () => {
    const menu: PromptMenuItem[] = [{ id: 'rice-1', name: 'Pork Fried Rice (Quart)', price_cents: 1095 }];
    const { server, fake } = app(config(), fakeClient(), menu);
    const body = liveIncoming();
    await request(server).post('/api/webhooks/openai').set(sign(body)).type('json').send(body);
    await tick();
    const accepted = vi.mocked(fake.client.accept).mock.calls[0]?.[2] as { session: { instructions: string } };
    expect(accepted.session.instructions).toContain('id: rice-1');
  });

  it('rejects an unsigned request without answering', async () => {
    const { server, fake } = app();
    const response = await request(server).post('/api/webhooks/openai').type('json').send(liveIncoming());
    expect(response.status).toBe(400);
    expect(fake.calls).toEqual([]);
  });

  it('leaves a call alone when it arrives through the other API', async () => {
    const { server, fake } = app(config({ defaultMode: 'realtime' }));
    const body = liveIncoming();
    const response = await request(server).post('/api/webhooks/openai').set(sign(body)).type('json').send(body);
    expect(response.body.ignored).toBe(true);
    expect(fake.calls).toEqual([]);
  });

  it('reports not configured when the secret is missing', async () => {
    const { server } = app(config({ webhookSecret: '' }));
    const body = liveIncoming();
    const response = await request(server).post('/api/webhooks/openai').set(sign(body)).type('json').send(body);
    expect(response.status).toBe(503);
  });

  it('hangs up when the call cannot be accepted', async () => {
    const fake = fakeClient();
    fake.client.accept = vi.fn(async () => {
      throw new Error('boom');
    });
    const { server, activeCalls } = app(config(), fake);
    const body = liveIncoming('live_fail');
    await request(server).post('/api/webhooks/openai').set(sign(body, 'msg_f')).type('json').send(body);
    await tick();
    expect(fake.calls).toEqual(['hangup:live:live_fail']);
    expect(activeCalls.size).toBe(0);
  });
});

describe('SipCallSession', () => {
  async function start(mode: SipMode, staffPhone = '') {
    const fake = fakeClient();
    const tools = { execute: vi.fn(async (name: string) => JSON.stringify({ tool: name })) };
    const recorder = new CallRecorder(`openai-${mode}`, 'call_1', '');
    const session = new SipCallSession({
      mode,
      id: 'call_1',
      client: fake.client,
      tools,
      recorder,
      staffPhone,
      hangupDelayMs: 5
    });
    await session.start();
    return { fake, tools, session, recorder };
  }

  const call = (name: string, id = 'c1') => ({ type: 'function_call', call_id: id, name, arguments: '{}' });

  it('returns a GPT-Live tool result and continues only after the response completes', async () => {
    const { fake, tools } = await start('live');
    fake.emit({
      type: 'response.event',
      event_id: 'e1',
      event: { type: 'response.output_item.done', item: call('search_menu') }
    });
    await tick();
    expect(tools.execute).toHaveBeenCalledWith('search_menu', '{}');
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]).toMatchObject({
      type: 'response.item.create',
      item: { type: 'function_call_output', call_id: 'c1' }
    });
    fake.emit({ type: 'response.event', event_id: 'e2', event: { type: 'response.completed' } });
    expect(fake.sent[1]).toMatchObject({ type: 'response.create' });
  });

  it('runs a replayed GPT-Live event only once', async () => {
    const { fake, tools } = await start('live');
    const event = {
      type: 'response.event',
      event_id: 'e1',
      event: { type: 'response.output_item.done', item: call('search_menu') }
    };
    fake.emit(event);
    fake.emit(event);
    await tick();
    expect(tools.execute).toHaveBeenCalledTimes(1);
  });

  it('greets on Realtime, then returns a tool result after the response is done', async () => {
    const { fake } = await start('realtime');
    expect(fake.sent).toEqual([{ type: 'response.create' }]);
    fake.emit({ type: 'response.created' });
    fake.emit({ type: 'response.output_item.done', item: call('get_store_mode') });
    await tick();
    expect(fake.sent[1]).toMatchObject({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: 'c1' }
    });
    expect(fake.sent).toHaveLength(2);
    fake.emit({ type: 'response.done', response: { usage: { total_tokens: 10 } } });
    expect(fake.sent[2]).toEqual({ type: 'response.create' });
  });

  it('hangs up after end_call', async () => {
    const { fake } = await start('realtime');
    fake.emit({ type: 'response.output_item.done', item: call('end_call') });
    fake.emit({ type: 'response.done', response: {} });
    await tick();
    await tick();
    expect(fake.calls).toContain('hangup:realtime:call_1');
  });

  it('transfers to the staff line when one is configured', async () => {
    const { fake } = await start('live', '+16075550199');
    fake.emit({
      type: 'response.event',
      event_id: 'e1',
      event: { type: 'response.output_item.done', item: call('transfer_to_staff') }
    });
    await tick();
    await tick();
    expect(fake.calls).toContain('refer:live:call_1:tel:+16075550199');
  });

  it('tells the model a transfer is unavailable when no staff line is set', async () => {
    const { fake } = await start('live');
    fake.emit({
      type: 'response.event',
      event_id: 'e1',
      event: { type: 'response.output_item.done', item: call('transfer_to_staff') }
    });
    await tick();
    const sent = fake.sent[0] as { item: { output: string } };
    expect(JSON.parse(sent.item.output).status).toBe('unavailable');
    expect(fake.calls).toEqual([]);
  });

  it('measures the gap between the caller stopping and the assistant answering', async () => {
    const { fake, session, recorder } = await start('live');
    fake.emit({ type: 'session.input_transcript.delta', event_id: 'a', delta: 'one burrito', start_ms: 1000, end_ms: 2000 });
    fake.emit({ type: 'session.output_transcript.delta', event_id: 'b', delta: 'Sure.', start_ms: 2900, end_ms: 3200 });
    const finish = vi.spyOn(recorder, 'finish');
    fake.emit({ type: 'session.closed', event_id: 'c', reason: 'remote_hangup', usage: { seconds: 12 } });
    await tick();
    const summary = await finish.mock.results[0]?.value;
    expect(summary).toMatchObject({
      endReason: 'remote_hangup',
      responseGapsMs: [900],
      callerTranscript: 'one burrito',
      assistantTranscript: 'Sure.',
      usage: [{ seconds: 12 }]
    });
    await session.finish('again');
    expect(finish).toHaveBeenCalledTimes(1);
  });
});
