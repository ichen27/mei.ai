import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CallToolHandler } from '../src/workers/call-tools.js';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('CallToolHandler', () => {
  let handler: CallToolHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new CallToolHandler({
      apiBaseUrl: 'http://localhost:3000',
      internalApiKey: 'test-key',
      storeId: 'store-1',
      callerPhone: '+15559876543',
      callSid: 'CA123'
    });
  });

  describe('get_store_mode', () => {
    it('fetches store info and returns mode', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'store-1',
          name: 'Test Store',
          mode: 'OPEN',
          default_prep_mins: 15
        })
      });

      const result = await handler.execute('get_store_mode', '{}');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/internal/stores/store-1',
        expect.objectContaining({
          headers: expect.objectContaining({ 'x-internal-api-key': 'test-key' })
        })
      );
      const parsed = JSON.parse(result);
      expect(parsed.mode).toBe('OPEN');
    });
  });

  describe('search_menu', () => {
    it('fetches menu with query param', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [
            { id: 'item-1', name: 'Cheeseburger', basePriceCents: 999, isAvailable: true }
          ]
        })
      });

      const result = await handler.execute('search_menu', JSON.stringify({ query: 'burger' }));
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/internal/stores/store-1/menu?q=burger',
        expect.any(Object)
      );
      const parsed = JSON.parse(result);
      expect(parsed.items).toHaveLength(1);
      expect(parsed.items[0].name).toBe('Cheeseburger');
    });

    it('lists the full menu when the query is empty or missing', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ items: [] }) });

      await handler.execute('search_menu', JSON.stringify({ query: '' }));
      await handler.execute('search_menu', '{}');

      for (const call of mockFetch.mock.calls.slice(-2)) {
        expect(call[0]).toBe('http://localhost:3000/api/internal/stores/store-1/menu?q=');
      }
    });
  });

  describe('price_order', () => {
    it('asks the order endpoint for a quote and passes the server\'s reason back on a refusal', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ quote_only: true, total_cents: 1295 }) });
      const items = [{ item_id: 'combo-1', qty: 1, swaps: [{ out_item_id: 'rice', in_item_id: 'lomein' }] }];
      const result = await handler.execute('price_order', JSON.stringify({ items }));
      expect(JSON.parse(result)).toEqual({ quote_only: true, total_cents: 1295 });
      const [url, init] = mockFetch.mock.calls[0] as [string, { body: string }];
      expect(url).toBe('http://localhost:3000/api/internal/orders');
      expect(JSON.parse(init.body)).toEqual({ store_id: 'store-1', quote_only: true, items });

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ error: { code: 'SWAP_NOT_ALLOWED', message: 'out_item_id must be something it comes with: rice.' } })
      });
      const refused = JSON.parse(await handler.execute('price_order', JSON.stringify({ items })));
      expect(refused.error).toBe('API /api/internal/orders returned 400: out_item_id must be something it comes with: rice.');
    });
  });

  describe('create_order', () => {
    it('posts simplified order to internal endpoint', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'order-1',
          order_number: 42,
          status: 'NEW'
        })
      });

      const args = JSON.stringify({
        customer_name: 'Alice',
        items: [{ item_id: 'item-1', qty: 2 }]
      });
      const result = await handler.execute('create_order', args);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/internal/orders',
        expect.objectContaining({
          method: 'POST',
          body: expect.any(String)
        })
      );
      const parsed = JSON.parse(result);
      expect(parsed.order_number).toBe(42);
    });

    it('passes item notes and the order note through', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'order-2' }) });
      await handler.execute(
        'create_order',
        JSON.stringify({
          customer_name: 'Alice',
          notes: 'Peanut allergy',
          items: [{ item_id: 'item-1', qty: 1, note: 'no onions' }]
        })
      );
      const sent = JSON.parse((mockFetch.mock.calls.at(-1)?.[1] as { body: string }).body);
      expect(sent.notes).toBe('Peanut allergy');
      expect(sent.items).toEqual([{ item_id: 'item-1', qty: 1, note: 'no onions' }]);
    });
  });

  describe('unknown tool', () => {
    it('returns an error string', async () => {
      const result = await handler.execute('nonexistent', '{}');
      expect(result).toContain('error');
    });
  });
});
