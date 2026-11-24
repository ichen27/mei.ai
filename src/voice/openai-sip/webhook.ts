import { createHmac, timingSafeEqual } from 'node:crypto';

const TOLERANCE_SECONDS = 300;

function equalText(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Verifies an OpenAI webhook delivery (Standard Webhooks: HMAC-SHA256 over
 * "<id>.<timestamp>.<raw body>") and returns the delivery id for de-duplication.
 * Throws when the signature is missing, wrong, or older than five minutes.
 */
export function verifyWebhook(
  body: Buffer,
  headers: Record<string, unknown>,
  secret: string,
  now: number = Date.now()
): string {
  const id = headers['webhook-id'];
  const timestamp = headers['webhook-timestamp'];
  const signatures = headers['webhook-signature'];
  if (
    typeof id !== 'string' ||
    !id ||
    typeof timestamp !== 'string' ||
    !/^\d+$/.test(timestamp) ||
    typeof signatures !== 'string' ||
    !secret
  ) {
    throw new Error('invalid webhook signature');
  }
  if (Math.abs(now / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) {
    throw new Error('expired webhook signature');
  }
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  if (!key.length) throw new Error('invalid webhook secret');
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.`).update(body).digest('base64');
  const matches = signatures
    .split(/\s+/)
    .some((candidate) => candidate.startsWith('v1,') && equalText(candidate.slice(3), expected));
  if (!matches) throw new Error('invalid webhook signature');
  return id;
}
