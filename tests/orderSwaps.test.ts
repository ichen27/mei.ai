import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { priceMenuOrder } from '../src/menuOrder.js';
import { comesWithForItem, parseChangeRules, swapSectionsForItem } from '../src/store/changeRules.js';
import type { MenuItem } from '../src/types.js';
import { buildChangeRulesSection } from '../src/workers/call-prompt.js';

const item = (id: string, name: string, cents: number, category: string, isAvailable = true): MenuItem => ({
  id,
  storeId: 'store-1',
  name,
  basePriceCents: cents,
  isAvailable,
  category
});

const menu: MenuItem[] = [
  item('combo-1', 'Sesame Chicken (Combination Plate)', 1115, 'Combination Plates'),
  item('rice-pint', 'Roast Pork Fried Rice (Pint)', 595, 'Fried Rice'),
  item('lomein-pint', 'Roast Pork Lo Mein (Pint)', 775, 'Lo Mein'),
  item('lomein-shrimp', 'Shrimp Lo Mein (Pint)', 795, 'Lo Mein', false),
  item('white-rice', 'White Rice (Small)', 300, 'Sides'),
  item('duck', 'Special Duck', 1795, 'Chef’s Specialties'),
  item('soup-1', 'Wonton Soup (Pint)', 395, 'Soup')
];

const rules = parseChangeRules(
  JSON.stringify({
    rules: [
      {
        applies_to: { categories: ['Combination Plates'] },
        can_change: [{ id: 'extra-meat', label: 'Extra meat', price_cents: 200 }],
        comes_with: ['rice-pint'],
        swap_sections: ['Fried Rice', 'Lo Mein', 'Sides']
      }
    ]
  })
);

const order = (swaps: Array<{ out_item_id: string; in_item_id: string }>, itemId = 'combo-1', qty = 1) =>
  priceMenuOrder(menu, [{ item_id: itemId, qty, swaps }], rules);

describe('swap sections in the rules', () => {
  it('defaults to none and applies to the items the rule covers', () => {
    expect(parseChangeRules(JSON.stringify({ rules: [{ applies_to: 'all' }] })).rules[0]?.swap_sections).toEqual([]);
    expect(parseChangeRules(JSON.stringify({ rules: [{ applies_to: 'all' }] })).rules[0]?.comes_with).toEqual([]);
    expect(swapSectionsForItem(rules, menu[0]!)).toEqual(['Fried Rice', 'Lo Mein', 'Sides']);
    expect(comesWithForItem(rules, menu[0]!)).toEqual(['rice-pint']);
    expect(swapSectionsForItem(rules, menu[6]!)).toEqual([]);
    expect(comesWithForItem(rules, menu[6]!)).toEqual([]);
  });
});

describe('priceMenuOrder with swaps', () => {
  it('charges the difference in menu price for each unit and records the swap', () => {
    const priced = priceMenuOrder(
      menu,
      [{ item_id: 'combo-1', qty: 2, options: ['extra-meat'], swaps: [{ out_item_id: 'rice-pint', in_item_id: 'lomein-pint' }] }],
      rules
    );
    expect(priced.totalCents).toBe((1115 + 200 + 180) * 2);
    expect(priced.items[0]?.basePriceCents).toBe(1115);
    expect(priced.items[0]?.modifiersSnapshotJson).toEqual([
      { id: 'extra-meat', label: 'Extra meat', price_cents: 200 },
      { id: 'swap', label: 'Roast Pork Lo Mein (Pint) instead of Roast Pork Fried Rice (Pint)', price_cents: 180 }
    ]);
  });

  it('charges nothing when the new item is not dearer', () => {
    const priced = order([{ out_item_id: 'rice-pint', in_item_id: 'white-rice' }]);
    expect(priced.totalCents).toBe(1115);
    expect(priced.items[0]?.modifiersSnapshotJson[0]?.price_cents).toBe(0);
  });

  it('refuses a swap on an item whose rules list none', () => {
    expect(() => order([{ out_item_id: 'rice-pint', in_item_id: 'lomein-pint' }], 'soup-1')).toThrow(
      'Swaps are not priced for Wonton Soup (Pint)'
    );
    expect(() => priceMenuOrder(menu, [{ item_id: 'combo-1', qty: 1, swaps: [{ out_item_id: 'rice-pint', in_item_id: 'lomein-pint' }] }])).toThrow(
      'Swaps are not priced'
    );
  });

  it('only lets out what the item comes with, so a dear item cannot be named to make a swap free', () => {
    expect(() => order([{ out_item_id: 'duck', in_item_id: 'lomein-pint' }])).toThrow(
      'out_item_id must be something Sesame Chicken (Combination Plate) comes with: rice-pint.'
    );
    // In a listed section, but not something the plate comes with.
    expect(() => order([{ out_item_id: 'lomein-pint', in_item_id: 'rice-pint' }])).toThrow('out_item_id must be something');
  });

  it('lets each thing out once, and only lets in items from the listed sections', () => {
    expect(() =>
      order([
        { out_item_id: 'rice-pint', in_item_id: 'lomein-pint' },
        { out_item_id: 'rice-pint', in_item_id: 'white-rice' }
      ])
    ).toThrow('can only be swapped out once');
    expect(() => order([{ out_item_id: 'rice-pint', in_item_id: 'duck' }])).toThrow('Special Duck cannot go in on a swap');
  });

  it('needs both a comes-with list and sections before any swap is priced', () => {
    const noComesWith = parseChangeRules(
      JSON.stringify({ rules: [{ applies_to: 'all', swap_sections: ['Fried Rice', 'Lo Mein'] }] })
    );
    expect(() =>
      priceMenuOrder(menu, [{ item_id: 'combo-1', qty: 1, swaps: [{ out_item_id: 'rice-pint', in_item_id: 'lomein-pint' }] }], noComesWith)
    ).toThrow('Swaps are not priced');
  });

  it('refuses unknown ids, a swap of an item for itself, and an unavailable new item', () => {
    expect(() => order([{ out_item_id: 'rice-pint', in_item_id: 'nope' }])).toThrow('"nope" is not a menu item id');
    expect(() => order([{ out_item_id: 'rice-pint', in_item_id: 'rice-pint' }])).toThrow('two different menu items');
    expect(() => order([{ out_item_id: 'rice-pint', in_item_id: 'lomein-shrimp' }])).toThrow('currently unavailable');
  });
});

describe('swaps in the prompt', () => {
  it('lists what comes out and what can go in, and sends the agent to price_order for the charge', () => {
    const section = buildChangeRulesSection(rules, [{ id: 'rice-pint', name: 'Roast Pork Fried Rice (Pint)', price_cents: 595 }]);
    expect(section).toContain(
      'Swaps:\n- Comes with, and can be swapped out: Roast Pork Fried Rice (Pint) (id: rice-pint).\n- Can go in: any menu item in these sections: Fried Rice, Lo Mein, Sides.'
    );
    expect(section).toContain('out_item_id (one of the things the item comes with)');
    expect(section).toContain('Do not work that amount out yourself: call price_order');
  });

  it('says nothing about swaps when no rule lists any', () => {
    const none = parseChangeRules(JSON.stringify({ rules: [{ applies_to: 'all', cannot_change: ['Half portions'] }] }));
    expect(buildChangeRulesSection(none)).not.toContain('out_item_id');
  });
});

describe('orders with swaps through the API', () => {
  beforeEach(() => {
    const file = join(mkdtempSync(join(tmpdir(), 'mei-swaps-')), 'rules.json');
    writeFileSync(
      file,
      JSON.stringify({
        rules: [{ applies_to: 'all', can_change: [{ id: 'extra-salsa', label: 'Extra salsa', price_cents: 50 }], swap_sections: ['Mains'] }]
      })
    );
    process.env.CHANGE_RULES_FILE = file;
    process.env.INTERNAL_API_KEY = 'test-internal-key';
  });
  afterEach(() => {
    delete process.env.CHANGE_RULES_FILE;
  });

  it('adds the swap charge to the total, or says why the swap was refused', async () => {
    const { app } = createApp();
    const menuRes = await request(app).get('/api/internal/stores/store-1/menu').set('x-internal-api-key', 'test-internal-key');
    const items = menuRes.body.items as Array<{ id: string; price_cents: number }>;
    const [first, second] = [...items].sort((a, b) => a.price_cents - b.price_cents);
    expect(menuRes.body.change_rules.rules[0].swap_sections).toEqual(['Mains']);

    const send = (callId: string, swaps: unknown) =>
      request(app)
        .post('/api/internal/orders')
        .set('x-internal-api-key', 'test-internal-key')
        .send({
          store_id: 'store-1',
          call_id: callId,
          customer_name: 'Sam',
          customer_phone: '+14155550123',
          items: [{ item_id: first!.id, qty: 1, swaps }]
        });

    // The seeded menu has no sections, so no item is in "Mains".
    const refused = await send('call-swap-1', [{ out_item_id: first!.id, in_item_id: second!.id }]);
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('SWAP_NOT_ALLOWED');

    const malformed = await send('call-swap-2', [{ out_item_id: first!.id }]);
    expect(malformed.status).toBe(400);
  });

  it('prices items without placing an order when asked for a quote', async () => {
    const { app } = createApp();
    const quote = (body: Record<string, unknown>) =>
      request(app).post('/api/internal/orders').set('x-internal-api-key', 'test-internal-key').send(body);

    const res = await quote({ store_id: 'store-1', quote_only: true, items: [{ item_id: 'item-burrito', qty: 2, options: ['extra-salsa'] }] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      quote_only: true,
      total_cents: (1299 + 50) * 2,
      items: [
        {
          item_id: 'item-burrito',
          name: 'Chicken Burrito',
          qty: 2,
          base_price_cents: 1299,
          charges: [{ label: 'Extra salsa', price_cents: 50 }],
          line_total_cents: (1299 + 50) * 2
        }
      ]
    });

    // The hosted agent's tool sends the flag as a string.
    const asString = await quote({ store_id: 'store-1', quote_only: 'true', items: [{ item_id: 'item-burrito', qty: 1 }] });
    expect(asString.status).toBe(200);
    expect(asString.body.total_cents).toBe(1299);

    const refused = await quote({ store_id: 'store-1', quote_only: true, items: [{ item_id: 'item-burrito', qty: 1, options: ['nope'] }] });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('OPTION_NOT_ALLOWED');

    // Nothing was stored: the same call id still places a fresh order.
    const placed = await quote({
      store_id: 'store-1',
      call_id: 'call-quote-1',
      customer_name: 'Sam',
      customer_phone: '+14155550123',
      items: [{ item_id: 'item-burrito', qty: 1 }]
    });
    expect(placed.status).toBe(201);
    expect(placed.body.order_number).toBeDefined();
  });
});
