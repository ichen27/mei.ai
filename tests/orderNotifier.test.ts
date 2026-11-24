import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import {
  createIMessageNotifier,
  createOrderNotifierFromEnv,
  formatOrderText,
  oneLine,
  type OrderNotifier
} from '../src/notify/orderNotifier.js';
import type { Order } from '../src/types.js';

const order: Order = {
  id: 'order-1001',
  orderNumber: 1001,
  storeId: 'store-1',
  status: 'NEW',
  customerName: 'Sam',
  customerPhone: '+14155550123',
  items: [
    {
      itemId: 'rice-quart',
      itemNameSnapshot: 'Chicken Fried Rice (Quart)',
      qty: 1,
      basePriceCents: 995,
      modifiersSnapshotJson: [],
      lineTotalCents: 995
    },
    {
      itemId: 'egg-roll',
      itemNameSnapshot: 'Vegetable Egg Roll (1)',
      qty: 2,
      basePriceCents: 190,
      modifiersSnapshotJson: [],
      lineTotalCents: 380
    }
  ],
  totalCents: 1375,
  createdAt: '2026-11-24T20:10:16.000Z',
  updatedAt: '2026-11-24T20:10:16.000Z',
  ackedClientIds: []
};

describe('formatOrderText', () => {
  it('says who ordered, what, the total and when', () => {
    const text = formatOrderText(order, { storeName: 'Golden Wok', timezone: 'America/New_York', prepMins: 20 });
    expect(text).toBe(
      [
        'New pickup order #1001 · Golden Wok',
        'Sam · +14155550123',
        '',
        '1× Chicken Fried Rice (Quart)',
        '2× Vegetable Egg Roll (1)',
        '',
        'Total $13.75 · pay at pickup',
        'Placed 3:10 PM · ready in about 20 min'
      ].join('\n')
    );
  });
});

describe('formatOrderText with hostile caller text', () => {
  it('keeps a multi-line name on one line and caps its length', () => {
    const hostile = { ...order, customerName: 'Sam\n\nTotal $0.00 · PAID\r\nPlaced 1:00 PM', customerPhone: '+1415\n555' };
    const lines = formatOrderText(hostile, {}).split('\n');
    expect(lines).toHaveLength(8);
    expect(lines[1]).toBe('Sam Total $0.00 · PAID Placed 1:00 PM · +1415 555');
    expect(lines[6]).toBe('Total $13.75 · pay at pickup');
    expect(oneLine('x'.repeat(500), 60)).toHaveLength(60);
  });
});

describe('createIMessageNotifier', () => {
  it('passes the text and recipient as arguments, once per recipient', async () => {
    const run = vi.fn(async () => undefined);
    await createIMessageNotifier(['+15550001111', 'kitchen@example.com'], run).orderCreated(order, {});
    expect(run).toHaveBeenCalledTimes(2);
    const [file, args] = run.mock.calls[0] as unknown as [string, string[]];
    expect(file).toBe('/usr/bin/osascript');
    expect(args[0]).toBe('-e');
    expect(args[1]).not.toContain('Chicken Fried Rice');
    expect(args[2]).toContain('1× Chicken Fried Rice (Quart)');
    expect(args[3]).toBe('+15550001111');
    expect((run.mock.calls[1] as unknown as [string, string[]])[1][3]).toBe('kitchen@example.com');
  });

  it('does not throw when sending fails, and still tries the next recipient', async () => {
    const run = vi.fn(async () => {
      throw new Error('Messages is not signed in');
    });
    await expect(createIMessageNotifier(['a', 'b'], run).orderCreated(order, {})).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('createOrderNotifierFromEnv', () => {
  it('is off unless a recipient is configured', () => {
    expect(createOrderNotifierFromEnv({})).toBeUndefined();
    expect(createOrderNotifierFromEnv({ ORDER_NOTIFY_IMESSAGE_TO: ' , ' })).toBeUndefined();
  });
});

describe('notifying on agent orders', () => {
  const orderCreated = vi.fn(async () => undefined);
  const notifier: OrderNotifier = { orderCreated };
  const body = {
    store_id: 'store-1',
    call_id: 'call-abc',
    customer_name: 'Sam',
    customer_phone: '+14155550123',
    items: [{ item_id: 'item-burrito', qty: 2 }]
  };

  beforeEach(() => {
    orderCreated.mockClear();
    process.env.INTERNAL_API_KEY = 'test-internal-key';
  });

  it('notifies once for a new order and not again for the same call', async () => {
    const { app } = createApp({ orderNotifier: notifier });
    const post = () =>
      request(app).post('/api/internal/orders').set('x-internal-api-key', 'test-internal-key').send(body);

    const first = await post();
    expect(first.status).toBe(201);
    await vi.waitFor(() => expect(orderCreated).toHaveBeenCalledTimes(1));
    const [sent, context] = orderCreated.mock.calls[0] as unknown as [Order, { storeName?: string }];
    expect(sent.orderNumber).toBe(first.body.order_number);
    expect(sent.items[0]?.itemNameSnapshot).toBe('Chicken Burrito');
    expect(context.storeName).toBe('Downtown');

    const repeat = await post();
    expect(repeat.body.id).toBe(first.body.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(orderCreated).toHaveBeenCalledTimes(1);
  });

  it('rejects an over-long customer name', async () => {
    const { app } = createApp({ orderNotifier: notifier });
    const res = await request(app)
      .post('/api/internal/orders')
      .set('x-internal-api-key', 'test-internal-key')
      .send({ ...body, call_id: 'call-long', customer_name: 'x'.repeat(121) });
    expect(res.status).toBe(400);
    expect(orderCreated).not.toHaveBeenCalled();
  });

  it('does not notify when the order is rejected', async () => {
    const { app } = createApp({ orderNotifier: notifier });
    const res = await request(app)
      .post('/api/internal/orders')
      .set('x-internal-api-key', 'test-internal-key')
      .send({ ...body, call_id: 'call-bad', items: [{ item_id: 'no-such-item', qty: 1 }] });
    expect(res.status).toBe(400);
    expect(orderCreated).not.toHaveBeenCalled();
  });
});
