import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { MenuItem } from '../types.js';

/**
 * A restaurant's menu as a JSON file, used to seed the in-memory store so the
 * real menu can be loaded without code changes. See data/menu.example.json.
 */
const menuFileSchema = z.object({
  store: z
    .object({
      name: z.string().min(1).optional(),
      public_phone: z.string().min(4).optional(),
      timezone: z.string().min(1).optional()
    })
    .optional(),
  items: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        price_cents: z.number().int().nonnegative(),
        category: z.string().min(1).optional(),
        is_available: z.boolean().optional()
      })
    )
    .min(1)
});

export interface MenuSeed {
  store: { name?: string; publicPhone?: string; timezone?: string };
  items: MenuItem[];
}

/** Parses menu file contents. Throws with a readable message when invalid. */
export function parseMenuFile(contents: string, storeId: string): MenuSeed {
  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch {
    throw new Error('menu file is not valid JSON');
  }
  const parsed = menuFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`menu file is invalid at ${issue?.path.join('.') || 'root'}: ${issue?.message ?? 'unknown'}`);
  }

  const seen = new Set<string>();
  const items = parsed.data.items.map((item): MenuItem => {
    if (seen.has(item.id)) throw new Error(`menu file repeats item id "${item.id}"`);
    seen.add(item.id);
    return {
      id: item.id,
      storeId,
      name: item.name,
      basePriceCents: item.price_cents,
      isAvailable: item.is_available ?? true,
      ...(item.category ? { category: item.category } : {})
    };
  });

  const store = parsed.data.store ?? {};
  return {
    store: {
      ...(store.name ? { name: store.name } : {}),
      ...(store.public_phone ? { publicPhone: store.public_phone } : {}),
      ...(store.timezone ? { timezone: store.timezone } : {})
    },
    items
  };
}

export function loadMenuFile(path: string, storeId: string): MenuSeed {
  return parseMenuFile(readFileSync(path, 'utf8'), storeId);
}
