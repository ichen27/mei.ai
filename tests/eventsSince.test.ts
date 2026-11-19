import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

describe('GET /api/stores/:storeId/events since_id', () => {
  it.each(['abc', '-5', '1.5', '1e30'])('treats invalid since_id %s as 0', async (value) => {
    const { app } = createApp();
    const res = await request(app).get('/api/stores/store-1/events').query({ since_id: value }).expect(200);
    expect(res.body.events).toEqual([]);
    expect(res.body.next_since_id).toBe(0);
  });
});
