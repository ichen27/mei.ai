import { oneLine } from './text.js';
import type { MenuItem, OrderItemInput } from './types.js';

export class MenuOrderError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export const ITEM_NOTE_MAX = 140;

/**
 * Model output supplies item IDs, quantities and an optional free-text note per
 * item; the menu owns prices and availability. A note never changes a price.
 */
export function priceMenuOrder(
  menu: MenuItem[],
  requested: Array<{ item_id: string; qty: number; note?: string | undefined }>
) {
  if (requested.length === 0) throw new MenuOrderError('EMPTY_ORDER', 'Choose at least one item.');
  const items: OrderItemInput[] = requested.map((item) => {
    if (!Number.isInteger(item.qty) || item.qty < 1 || item.qty > 100) {
      throw new MenuOrderError('INVALID_QUANTITY', 'Quantity must be between 1 and 100.');
    }
    const entry = menu.find((candidate) => candidate.id === item.item_id);
    if (!entry) throw new MenuOrderError('ITEM_NOT_FOUND', 'Menu item not found.');
    if (!entry.isAvailable)
      throw new MenuOrderError('ITEM_UNAVAILABLE', entry.name + ' is currently unavailable.');
    const note = item.note ? oneLine(item.note, ITEM_NOTE_MAX) : '';
    return {
      itemId: entry.id,
      itemNameSnapshot: entry.name,
      qty: item.qty,
      basePriceCents: entry.basePriceCents,
      modifiersSnapshotJson: [],
      ...(note ? { specialInstructions: note } : {}),
      lineTotalCents: entry.basePriceCents * item.qty
    };
  });
  return { items, totalCents: items.reduce((total, item) => total + item.lineTotalCents, 0) };
}
