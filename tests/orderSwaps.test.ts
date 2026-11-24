import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { priceMenuOrder } from '../src/menuOrder.js';
import { parseChangeRules, swapSectionsForItem } from '../src/store/changeRules.js';
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
    expect(swapSectionsForItem(rules, menu[0]!)).toEqual(['Fried Rice', 'Lo Mein', 'Sides']);
    expect(swapSectionsForItem(rules, menu[6]!)).toEqual([]);
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

  it('refuses a swap that reaches outside the listed sections, in either direction', () => {
    expect(() => order([{ out_item_id: 'rice-pint', in_item_id: 'duck' }])).toThrow('Special Duck cannot be part of a swap');
    expect(() => order([{ out_item_id: 'duck', in_item_id: 'lomein-pint' }])).toThrow('Special Duck cannot be part of a swap');
  });

  it('refuses unknown ids, a swap of an item for itself, and an unavailable new item', () => {
    expect(() => order([{ out_item_id: 'rice-pint', in_item_id: 'nope' }])).toThrow('"nope" is not a menu item id');
    expect(() => order([{ out_item_id: 'rice-pint', in_item_id: 'rice-pint' }])).toThrow('two different menu items');
    expect(() => order([{ out_item_id: 'rice-pint', in_item_id: 'lomein-shrimp' }])).toThrow('currently unavailable');
  });
});

describe('swaps in the prompt', () => {
  it('lists the sections and explains how a swap is ordered and charged', () => {
    const section = buildChangeRulesSection(rules);
    expect(section).toContain(
      'Swaps:\n- One menu item for another, when both are in these sections: Fried Rice, Lo Mein, Sides.'
    );
    expect(section).toContain('out_item_id (the menu item that comes out)');
    expect(section).toContain("the new item's menu price minus the old one's");
  });

  it('says nothing about swaps when no rule lists any', () => {
    const none = parseChangeRules(JSON.stringify({ rules: [{ applies_to: 'all', cannot_change: ['Half portions'] }] }));
    expect(buildChangeRulesSection(none)).not.toContain('out_item_id');
  });
});

describe('orders with swaps through the API', () => {
  beforeEach(() => {
    const file = join(mkdtempSync(join(tmpdir(), 'mei-swaps-')), 'rules.json');
    writeFileSync(file, JSON.stringify({ rules: [{ applies_to: 'all', swap_sections: ['Mains'] }] }));
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
});
