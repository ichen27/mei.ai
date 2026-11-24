import { execFile } from 'node:child_process';
import { safeLog } from '../logger.js';
import type { Order } from '../types.js';

/** Tells someone that a new order has arrived. Must not throw. */
export interface OrderNotifier {
  orderCreated(order: Order, context: OrderNotifyContext): Promise<void>;
}

export interface OrderNotifyContext {
  storeName?: string;
  timezone?: string;
  prepMins?: number;
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Caller-supplied text on one line: the name is whatever the caller said, so
 * line breaks and control characters are removed and the length is capped.
 * Otherwise a "name" could add its own lines to the message, such as a total.
 */
export function oneLine(value: string, max: number): string {
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

/** The order as a short text message: who, what, how much, when. */
export function formatOrderText(order: Order, context: OrderNotifyContext = {}): string {
  const placed = new Date(order.createdAt).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    ...(context.timezone ? { timeZone: context.timezone } : {})
  });
  const lines = [
    `New pickup order #${order.orderNumber}${context.storeName ? ` · ${oneLine(context.storeName, 60)}` : ''}`,
    `${oneLine(order.customerName, 60)} · ${oneLine(order.customerPhone, 24)}`,
    '',
    ...order.items.map((item) => `${item.qty}× ${oneLine(item.itemNameSnapshot, 80)}`),
    '',
    `Total ${dollars(order.totalCents)} · pay at pickup`,
    `Placed ${placed}${context.prepMins ? ` · ready in about ${context.prepMins} min` : ''}`
  ];
  return lines.join('\n');
}

export type RunCommand = (file: string, args: string[]) => Promise<void>;

// Long enough for someone to answer the one-time macOS permission prompt.
const SEND_TIMEOUT_MS = 60_000;

// The default error text is the whole command line, which would put the order
// in the log. Report only why it failed.
const runCommand: RunCommand = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: SEND_TIMEOUT_MS }, (error, _stdout, stderr) => {
      if (!error) return resolve();
      const reason = error.killed
        ? `timed out after ${SEND_TIMEOUT_MS / 1000}s (macOS may be waiting for permission to control Messages)`
        : stderr.trim().split('\n').pop() || `exit ${String(error.code ?? 'unknown')}`;
      reject(new Error(reason));
    });
  });

// The message and the recipient are passed as arguments, never spliced into
// the script, so order text cannot change what the script does.
const SEND_SCRIPT = `on run argv
  tell application "Messages"
    set theAccount to 1st account whose service type = iMessage
    send (item 1 of argv) to participant (item 2 of argv) of theAccount
  end tell
end run`;

/**
 * Sends each new order as an iMessage from this Mac's Messages app. macOS only:
 * Messages must be signed in, and macOS asks once for permission to let this
 * process control Messages.
 */
export function createIMessageNotifier(recipients: string[], run: RunCommand = runCommand): OrderNotifier {
  return {
    async orderCreated(order, context) {
      const text = formatOrderText(order, context);
      for (const to of recipients) {
        try {
          await run('/usr/bin/osascript', ['-e', SEND_SCRIPT, text, to]);
          safeLog('info', 'order_notify_sent', { channel: 'imessage', orderId: order.id });
        } catch (err) {
          safeLog('error', 'order_notify_failed', {
            channel: 'imessage',
            orderId: order.id,
            error: err instanceof Error ? err.message.slice(0, 200) : 'unknown'
          });
        }
      }
    }
  };
}

/** ORDER_NOTIFY_IMESSAGE_TO: comma-separated phone numbers or Apple ID emails. */
export function createOrderNotifierFromEnv(env: NodeJS.ProcessEnv): OrderNotifier | undefined {
  const recipients = (env.ORDER_NOTIFY_IMESSAGE_TO ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (recipients.length === 0) return undefined;
  if (process.platform !== 'darwin') {
    safeLog('warn', 'order_notify_unavailable', { channel: 'imessage', reason: 'macOS only' });
    return undefined;
  }
  return createIMessageNotifier(recipients);
}
