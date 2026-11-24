import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { MenuOrderError, priceMenuOrder } from '../src/menuOrder.js';
import { formatOrderText } from '../src/notify/orderNotifier.js';
import {
  createChangeRulesSource,
  optionsForItem,
  parseChangeRules,
  type ChangeRules
} from '../src/store/changeRules.js';
import type { MenuItem, Order } from '../src/types.js';
import { buildChangeRulesSection, buildSystemPrompt } from '../src/workers/call-prompt.js';

const rulesJson = JSON.stringify({
  rules: [
    {
      applies_to: 'all',
      can_change: [{ id: 'no-onions', label: 'No onions' }],
      cannot_change: ['Half portions']
    },
    {
      applies_to: { categories: ['Fried Rice'] },
      can_change: [{ id: 'extra-meat', label: 'Extra meat', price_cents: 200 }]
    },
    {
      applies_to: { items: ['item-burrito'] },
      can_change: [{ id: 'extra-salsa', label: 'Extra salsa', price_cents: 50 }]
    }
  ]
});

const menu: MenuItem[] = [
  { id: 'rice-1', storeId: 'store-1', name: 'Pork Fried Rice', basePriceCents: 995, isAvailable: true, category: 'Fried Rice' },
  { id: 'soup-1', storeId: 'store-1', name: 'Wonton Soup', basePriceCents: 395, isAvailable: true, category: 'Soup' }
];

describe('parseChangeRules', () => {
  it('reads rules and defaults unlisted requests to the kitchen', () => {
    const rules = parseChangeRules(rulesJson);
    expect(rules.unlisted_requests).toBe('pass_to_kitchen');
    expect(rules.rules).toHaveLength(3);
    expect(rules.rules[1]?.cannot_change).toEqual([]);
    expect(rules.rules[1]?.guidance).toEqual([]);
  });

  it('rejects bad JSON, a bad option id, and one id used for two changes', () => {
    expect(() => parseChangeRules('{')).toThrow('not valid JSON');
    const badId = { rules: [{ applies_to: 'all', can_change: [{ id: 'No Onions', label: 'No onions' }] }] };
    expect(() => parseChangeRules(JSON.stringify(badId))).toThrow('rules.0.can_change.0.id');
    const clash = {
      rules: [
        { applies_to: 'all', can_change: [{ id: 'extra', label: 'Extra meat', price_cents: 200 }] },
        { applies_to: { categories: ['Soup'] }, can_change: [{ id: 'extra', label: 'Extra meat', price_cents: 300 }] }
      ]
    };
    expect(() => parseChangeRules(JSON.stringify(clash))).toThrow('two different changes');
  });
});

describe('optionsForItem', () => {
  it('combines rules for any item, the section, and the item', () => {
    const rules = parseChangeRules(rulesJson);
    expect(optionsForItem(rules, menu[0]!).map((option) => option.id)).toEqual(['no-onions', 'extra-meat']);
    expect(optionsForItem(rules, menu[1]!).map((option) => option.id)).toEqual(['no-onions']);
    expect(optionsForItem(rules, { id: 'item-burrito' }).map((option) => option.id)).toEqual(['no-onions', 'extra-salsa']);
  });
});

describe('priceMenuOrder with options', () => {
  const rules: ChangeRules = parseChangeRules(rulesJson);

  it('adds option prices per unit and records what was chosen', () => {
    const priced = priceMenuOrder(menu, [{ item_id: 'rice-1', qty: 2, options: ['extra-meat', 'no-onions', 'extra-meat'] }], rules);
    expect(priced.totalCents).toBe((995 + 200) * 2);
    expect(priced.items[0]?.basePriceCents).toBe(995);
    expect(priced.items[0]?.modifiersSnapshotJson).toEqual([
      { id: 'extra-meat', label: 'Extra meat', price_cents: 200 },
      { id: 'no-onions', label: 'No onions', price_cents: 0 }
    ]);
  });

  it('refuses an option the item does not accept and names the ones it does', () => {
    const attempt = () => priceMenuOrder(menu, [{ item_id: 'soup-1', qty: 1, options: ['extra-meat'] }], rules);
    expect(attempt).toThrow(MenuOrderError);
    expect(attempt).toThrow('Available option ids: no-onions.');
  });

  it('refuses every option when there are no rules', () => {
    expect(() => priceMenuOrder(menu, [{ item_id: 'soup-1', qty: 1, options: ['no-onions'] }])).toThrow(
      'Available option ids: none.'
    );
  });
});

describe('createChangeRulesSource', () => {
  it('rereads an edited file and keeps the last good rules when an edit is invalid', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mei-rules-')), 'rules.json');
    writeFileSync(file, rulesJson);
    const source = createChangeRulesSource(file);
    expect(source.get().rules).toHaveLength(3);

    writeFileSync(file, JSON.stringify({ unlisted_requests: 'decline', rules: [] }));
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    expect(source.get().unlisted_requests).toBe('decline');

    writeFileSync(file, '{ not json');
    utimesSync(file, new Date(), new Date(Date.now() + 10000));
    expect(source.get().unlisted_requests).toBe('decline');
  });

  it('has no rules without a file, and fails at startup on a bad file', () => {
    expect(createChangeRulesSource(undefined).get().rules).toEqual([]);
    const file = join(mkdtempSync(join(tmpdir(), 'mei-rules-')), 'rules.json');
    writeFileSync(file, '{');
    expect(() => createChangeRulesSource(file)).toThrow('not valid JSON');
  });
});

describe('change rules in the prompt', () => {
  const rules = parseChangeRules(rulesJson);
  const promptMenu = [{ id: 'item-burrito', name: 'Chicken Burrito', price_cents: 1299 }];

  it('lists allowed changes with price and option id, and what is not allowed', () => {
    const section = buildChangeRulesSection(rules, promptMenu);
    expect(section).toContain('### Any item\nAllowed:\n- No onions | no charge | option: no-onions\nNot allowed:\n- Half portions');
    expect(section).toContain('### Section: Fried Rice\nAllowed:\n- Extra meat | +$2.00 | option: extra-meat');
    expect(section).toContain('### Item: Chicken Burrito (id: item-burrito)');
    expect(section).toContain('put it in that item\'s note');
  });

  it('passes the restaurant\'s guidance through, on one line, between allowed and not allowed', () => {
    const withGuidance = parseChangeRules(
      JSON.stringify({
        rules: [
          {
            applies_to: { categories: ['Fried Rice'] },
            can_change: [{ id: 'extra-spicy', label: 'Extra spicy' }],
            cannot_change: ['Half portions'],
            guidance: ['Leaving out an ingredient: allowed, no charge.\nPut it in the note.']
          }
        ]
      })
    );
    expect(withGuidance.rules[0]?.guidance).toEqual(['Leaving out an ingredient: allowed, no charge. Put it in the note.']);
    const section = buildChangeRulesSection(withGuidance);
    expect(section).toContain(
      'Allowed:\n- Extra spicy | no charge | option: extra-spicy\nGuidance:\n- Leaving out an ingredient: allowed, no charge. Put it in the note.\nNot allowed:\n- Half portions'
    );
    expect(section).toContain('A "Guidance" line is the restaurant\'s own instruction');
    expect(section).toContain('there may be an extra charge that the restaurant confirms at pickup');
  });

  it('tells the agent to decline unlisted requests when the restaurant says so', () => {
    const section = buildChangeRulesSection({ unlisted_requests: 'decline', rules: [] });
    expect(section).toContain('cannot take that change over the phone');
  });

  it('keeps the general guidance when there are no rules', () => {
    expect(buildChangeRulesSection({ unlisted_requests: 'pass_to_kitchen', rules: [] })).toBe('');
    expect(buildSystemPrompt('Golden Wok')).toContain('Say you will pass the request to the kitchen');
    const withRules = buildSystemPrompt('Golden Wok', promptMenu, rules);
    expect(withRules).toContain('follow the "Changes callers can ask for" section');
    expect(withRules).not.toContain('the price may change at pickup');
  });
});

describe('orders with options through the API', () => {
  beforeEach(() => {
    const file = join(mkdtempSync(join(tmpdir(), 'mei-rules-')), 'rules.json');
    writeFileSync(file, rulesJson);
    process.env.CHANGE_RULES_FILE = file;
    process.env.INTERNAL_API_KEY = 'test-internal-key';
  });
  afterEach(() => {
    delete process.env.CHANGE_RULES_FILE;
  });

  const post = (app: ReturnType<typeof createApp>['app'], items: unknown, callId: string) =>
    request(app)
      .post('/api/internal/orders')
      .set('x-internal-api-key', 'test-internal-key')
      .send({ store_id: 'store-1', call_id: callId, customer_name: 'Sam', customer_phone: '+14155550123', items });

  it('charges for a chosen option and returns the rules with the menu', async () => {
    const { app } = createApp();
    const res = await post(app, [{ item_id: 'item-burrito', qty: 2, options: ['extra-salsa'] }], 'call-opt-1');
    expect(res.status).toBe(201);
    expect(res.body.total_cents).toBe((1299 + 50) * 2);

    const menuRes = await request(app).get('/api/internal/stores/store-1/menu').set('x-internal-api-key', 'test-internal-key');
    expect(menuRes.body.change_rules.rules).toHaveLength(3);
  });

  it('rejects an option that is not allowed, with a message the agent can act on', async () => {
    const { app } = createApp();
    const res = await post(app, [{ item_id: 'item-bowl', qty: 1, options: ['extra-salsa'] }], 'call-opt-2');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('OPTION_NOT_ALLOWED');
    expect(res.body.error.message).toContain('no-onions');
  });
});

describe('formatOrderText with options', () => {
  it('lists chosen options under the item with their price', () => {
    const order: Order = {
      id: 'order-1',
      orderNumber: 1,
      storeId: 'store-1',
      status: 'NEW',
      customerName: 'Sam',
      customerPhone: '+14155550123',
      items: [
        {
          itemId: 'rice-1',
          itemNameSnapshot: 'Pork Fried Rice',
          qty: 1,
          basePriceCents: 995,
          modifiersSnapshotJson: [
            { id: 'extra-meat', label: 'Extra meat', price_cents: 200 },
            { id: 'no-onions', label: 'No onions', price_cents: 0 }
          ],
          specialInstructions: 'well done',
          lineTotalCents: 1195
        }
      ],
      totalCents: 1195,
      createdAt: '2026-11-24T20:10:16.000Z',
      updatedAt: '2026-11-24T20:10:16.000Z',
      ackedClientIds: []
    };
    expect(formatOrderText(order, {}).split('\n').slice(3, 7)).toEqual([
      '1× Pork Fried Rice',
      '   + Extra meat (+$2.00)',
      '   + No onions',
      '   → well done'
    ]);
  });
});
