import {
  NO_CHANGE_RULES,
  comesWithForItem,
  optionsForItem,
  swapSectionsForItem,
  type ChangeRules
} from './store/changeRules.js';
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
  /** Something the item comes with, swapped for another menu item. Charged from the two menu prices. */
  swaps?: Array<{ out_item_id: string; in_item_id: string }> | undefined;
}

/**
 * Model output supplies item IDs, quantities, option ids and an optional
 * free-text note. The menu owns prices and availability, and the change rules
 * own which options an item accepts and what they cost. A swap replaces
 * something the rules say the item comes with; it costs the new item's menu
 * price minus the old one's, and nothing when the new one is not dearer. What
 * comes out is limited to the rules' list so that a caller cannot name a dear
 * item as the thing replaced to make a swap free.
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
    const swapSections = swapSectionsForItem(rules, entry).map((name) => name.toLowerCase());
    const comesWith = comesWithForItem(rules, entry);
    const swappedOut = new Set<string>();
    const swaps = (item.swaps ?? []).map((swap) => {
      if (swapSections.length === 0 || comesWith.length === 0) {
        throw new MenuOrderError(
          'SWAP_NOT_ALLOWED',
          `Swaps are not priced for ${entry.name}. Put the request in the item's note instead.`
        );
      }
      const out = comesWith.includes(swap.out_item_id)
        ? menu.find((candidate) => candidate.id === swap.out_item_id)
        : undefined;
      if (!out) {
        throw new MenuOrderError(
          'SWAP_NOT_ALLOWED',
          `out_item_id must be something ${entry.name} comes with: ${comesWith.join(', ')}.`
        );
      }
      if (swappedOut.has(out.id)) {
        throw new MenuOrderError('SWAP_NOT_ALLOWED', `${out.name} can only be swapped out once on ${entry.name}.`);
      }
      swappedOut.add(out.id);
      const into = menu.find((candidate) => candidate.id === swap.in_item_id);
      if (!into) {
        throw new MenuOrderError(
          'SWAP_ITEM_NOT_FOUND',
          `"${oneLine(swap.in_item_id, 60)}" is not a menu item id. A swap needs the menu item id of what goes in.`
        );
      }
      if (out.id === into.id) throw new MenuOrderError('SWAP_NOT_ALLOWED', 'A swap needs two different menu items.');
      if (!swapSections.includes((into.category ?? '').toLowerCase())) {
        throw new MenuOrderError(
          'SWAP_NOT_ALLOWED',
          `${into.name} cannot go in on a swap on ${entry.name}. Put the request in the item's note instead.`
        );
      }
      if (!into.isAvailable) throw new MenuOrderError('ITEM_UNAVAILABLE', into.name + ' is currently unavailable.');
      return {
        id: 'swap',
        label: `${into.name} instead of ${out.name}`,
        price_cents: Math.max(0, into.basePriceCents - out.basePriceCents)
      };
    });
    const unitCents =
      entry.basePriceCents +
      chosen.reduce((sum, option) => sum + (option.price_cents ?? 0), 0) +
      swaps.reduce((sum, swap) => sum + swap.price_cents, 0);
    return {
      itemId: entry.id,
      itemNameSnapshot: entry.name,
      qty: item.qty,
      basePriceCents: entry.basePriceCents,
      modifiersSnapshotJson: [
        ...chosen.map((option) => ({ id: option.id, label: option.label, price_cents: option.price_cents ?? 0 })),
        ...swaps
      ],
      ...(note ? { specialInstructions: note } : {}),
      lineTotalCents: unitCents * item.qty
    };
  });
  return { items, totalCents: items.reduce((total, item) => total + item.lineTotalCents, 0) };
}
