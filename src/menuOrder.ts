import { NO_CHANGE_RULES, optionsForItem, type ChangeRules } from './store/changeRules.js';
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

export interface RequestedItem {
  item_id: string;
  qty: number;
  /** Free text for the kitchen. Never changes a price. */
  note?: string | undefined;
  /** Ids of changes from the restaurant's change rules. These can add to the price. */
  options?: string[] | undefined;
}

/**
 * Model output supplies item IDs, quantities, option ids and an optional
 * free-text note. The menu owns prices and availability, and the change rules
 * own which options an item accepts and what they cost.
 */
export function priceMenuOrder(menu: MenuItem[], requested: RequestedItem[], rules: ChangeRules = NO_CHANGE_RULES) {
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
    const available = optionsForItem(rules, entry);
    const chosen = [...new Set(item.options ?? [])].map((id) => {
      const option = available.find((candidate) => candidate.id === id);
      if (!option) {
        const list = available.map((candidate) => candidate.id).join(', ') || 'none';
        throw new MenuOrderError(
          'OPTION_NOT_ALLOWED',
          `"${oneLine(id, 60)}" is not an available change for ${entry.name}. Available option ids: ${list}.`
        );
      }
      return option;
    });
    const unitCents = entry.basePriceCents + chosen.reduce((sum, option) => sum + (option.price_cents ?? 0), 0);
    return {
      itemId: entry.id,
      itemNameSnapshot: entry.name,
      qty: item.qty,
      basePriceCents: entry.basePriceCents,
      modifiersSnapshotJson: chosen.map((option) => ({
        id: option.id,
        label: option.label,
        price_cents: option.price_cents ?? 0
      })),
      ...(note ? { specialInstructions: note } : {}),
      lineTotalCents: unitCents * item.qty
    };
  });
  return { items, totalCents: items.reduce((total, item) => total + item.lineTotalCents, 0) };
}
