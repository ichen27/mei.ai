import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createStaffWebRouter } from '../src/http/staffWeb.js';
import { createRepository } from '../src/store/factory.js';
import { MemoryStore } from '../src/store/memory.js';
import { parseMenuFile } from '../src/store/menuFile.js';
import { buildMenuSection, buildSystemPrompt } from '../src/workers/call-prompt.js';

const menuJson = JSON.stringify({
  store: { name: 'Golden Wok' },
  items: [
    { id: 'soup-1-pint', name: 'Wonton Soup (Pint)', price_cents: 395, category: 'Soup' },
    { id: 'soup-1-quart', name: 'Wonton Soup (Quart)', price_cents: 695, category: 'Soup' },
    { id: 'soda', name: 'Soda (Can)', price_cents: 130, is_available: false }
  ]
});

describe('parseMenuFile', () => {
  it('turns the file into menu items for the store', () => {
    const seed = parseMenuFile(menuJson, 'store-1');
    expect(seed.store.name).toBe('Golden Wok');
    expect(seed.items).toHaveLength(3);
    expect(seed.items[0]).toEqual({
      id: 'soup-1-pint',
      storeId: 'store-1',
      name: 'Wonton Soup (Pint)',
      basePriceCents: 395,
      isAvailable: true,
      category: 'Soup'
    });
    expect(seed.items[2]?.isAvailable).toBe(false);
  });

  it('rejects bad JSON, a missing price, and a repeated id', () => {
    expect(() => parseMenuFile('{', 'store-1')).toThrow('not valid JSON');
    expect(() => parseMenuFile(JSON.stringify({ items: [{ id: 'a', name: 'A' }] }), 'store-1')).toThrow(
      'items.0.price_cents'
    );
    const twice = { items: [{ id: 'a', name: 'A', price_cents: 1 }, { id: 'a', name: 'B', price_cents: 2 }] };
    expect(() => parseMenuFile(JSON.stringify(twice), 'store-1')).toThrow('repeats item id "a"');
  });
});

describe('MemoryStore with a menu seed', () => {
  it('replaces the sample menu and names the store', async () => {
    const store = new MemoryStore(parseMenuFile(menuJson, 'store-1'));
    const menu = await store.getMenu('store-1');
    expect(menu.map((item) => item.id)).toEqual(['soup-1-pint', 'soup-1-quart', 'soda']);
    expect((await store.getStoreById('store-1'))?.name).toBe('Golden Wok');
  });

  it('keeps the sample menu without a seed', async () => {
    const menu = await new MemoryStore().getMenu('store-1');
    expect(menu.map((item) => item.id)).toContain('item-burrito');
  });
});

describe('createRepository with MENU_FILE', () => {
  afterEach(() => {
    delete process.env.MENU_FILE;
  });

  it('loads the file, and refuses to start on a bad one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mei-menu-'));
    process.env.MENU_FILE = join(dir, 'menu.json');
    writeFileSync(process.env.MENU_FILE, menuJson);
    const { repository } = createRepository();
    expect(await repository.getMenu('store-1')).toHaveLength(3);

    writeFileSync(process.env.MENU_FILE, '{"items":[]}');
    expect(() => createRepository()).toThrow('menu file is invalid');
  });
});

describe('menu in the prompt', () => {
  const menu = [
    { id: 'soup-1-pint', name: 'Wonton Soup (Pint)', price_cents: 395, category: 'Soup' },
    { id: 'rice-2', name: 'Pork Fried Rice', price_cents: 1095, category: 'Fried Rice' },
    { id: 'soda', name: 'Soda (Can)', price_cents: 130, is_available: false }
  ];

  it('lists available items by section with price and id', () => {
    const section = buildMenuSection(menu);
    expect(section).toContain('### Soup\n- Wonton Soup (Pint) | $3.95 | id: soup-1-pint');
    expect(section).toContain('### Fried Rice\n- Pork Fried Rice | $10.95 | id: rice-2');
    expect(section).not.toContain('Soda');
  });

  it('tells the agent it already has the menu', () => {
    const prompt = buildSystemPrompt('Golden Wok', menu);
    expect(prompt).toContain('You already have the menu');
    expect(prompt).not.toContain('empty query to get the full menu');
    expect(prompt).toContain('id: rice-2');
  });

  it('falls back to search when the menu is missing or empty', () => {
    for (const prompt of [buildSystemPrompt('Golden Wok'), buildSystemPrompt('Golden Wok', [])]) {
      expect(prompt).toContain('empty query to get the full menu');
      expect(prompt).not.toContain('## Menu');
    }
  });
});

describe('createStaffWebRouter', () => {
  it('returns null when the dashboard is not built', () => {
    expect(createStaffWebRouter(join(tmpdir(), 'mei-no-such-build'))).toBeNull();
  });

  it('serves the dashboard at /staff and sends the root there', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mei-staff-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>staff</title>');
    writeFileSync(join(dir, 'app.js'), 'console.log(1)');
    const router = createStaffWebRouter(dir);
    expect(router).not.toBeNull();
    const app = express().use(router!);
    app.get('/health', (_req, res) => res.json({ ok: true }));

    const root = await request(app).get('/');
    expect(root.status).toBe(302);
    expect(root.headers.location).toBe('/staff');
    expect((await request(app).get('/staff')).text).toContain('<title>staff</title>');
    expect((await request(app).get('/staff/orders/1')).text).toContain('<title>staff</title>');
    expect((await request(app).get('/app.js')).text).toContain('console.log');
    expect((await request(app).get('/health')).body.ok).toBe(true);
  });
});
