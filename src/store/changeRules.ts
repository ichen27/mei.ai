import { readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
import { safeLog } from '../logger.js';
import { oneLine } from '../text.js';
import type { MenuItem } from '../types.js';

/**
 * What callers may and may not change about an order, set by the restaurant in
 * a JSON file. See data/change-rules.example.json.
 *
 * A rule covers every item, some menu sections, or some items. Each rule lists
 * changes that are allowed, with an optional price, and changes that are not.
 * A rule can also carry guidance: the restaurant's own instructions for
 * open-ended requests, such as leaving an ingredient out or swapping a side,
 * that a fixed list of options cannot cover. A rule can also name menu
 * sections whose items may be swapped for one another on the items it covers;
 * the server prices such a swap from the two menu prices.
 */
const optionSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'use lowercase letters, digits and hyphens'),
  label: z.string().min(1).max(80),
  price_cents: z.number().int().nonnegative().max(100_000).optional()
});

const ruleSchema = z.object({
  applies_to: z.union([
    z.literal('all'),
    z.object({ categories: z.array(z.string().min(1)).min(1) }).strict(),
    z.object({ items: z.array(z.string().min(1)).min(1) }).strict()
  ]),
  can_change: z.array(optionSchema).default([]),
  cannot_change: z.array(z.string().min(1).max(160)).default([]),
  guidance: z.array(z.string().min(1).max(400)).max(20).default([]),
  /** Sections whose items may be swapped for one another on the covered items. */
  swap_sections: z.array(z.string().min(1).max(80)).max(40).default([])
});

const fileSchema = z.object({
  /** What to do with a request no rule mentions. */
  unlisted_requests: z.enum(['pass_to_kitchen', 'decline']).default('pass_to_kitchen'),
  rules: z.array(ruleSchema).default([])
});

export type ChangeOption = z.infer<typeof optionSchema>;
export type ChangeRule = z.infer<typeof ruleSchema>;
export type ChangeRules = z.infer<typeof fileSchema>;

export const NO_CHANGE_RULES: ChangeRules = { unlisted_requests: 'pass_to_kitchen', rules: [] };

/** Parses rules file contents. Throws with a readable message when invalid. */
export function parseChangeRules(contents: string): ChangeRules {
  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch {
    throw new Error('change rules file is not valid JSON');
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `change rules file is invalid at ${issue?.path.join('.') || 'root'}: ${issue?.message ?? 'unknown'}`
    );
  }
  // One id must mean one thing, or an order could be priced by the wrong rule.
  const seen = new Map<string, string>();
  for (const rule of parsed.data.rules) {
    for (const option of rule.can_change) {
      const signature = `${option.label}|${option.price_cents ?? 0}`;
      const earlier = seen.get(option.id);
      if (earlier !== undefined && earlier !== signature) {
        throw new Error(`change rules file uses option id "${option.id}" for two different changes`);
      }
      seen.set(option.id, signature);
    }
  }
  return {
    unlisted_requests: parsed.data.unlisted_requests,
    rules: parsed.data.rules.map((rule) => ({
      applies_to: rule.applies_to,
      can_change: rule.can_change.map((option) => ({ ...option, label: oneLine(option.label, 80) })),
      cannot_change: rule.cannot_change.map((text) => oneLine(text, 160)),
      guidance: rule.guidance.map((text) => oneLine(text, 400)),
      swap_sections: rule.swap_sections.map((name) => oneLine(name, 80))
    }))
  };
}

function applies(rule: ChangeRule, item: Pick<MenuItem, 'id' | 'category'>): boolean {
  if (rule.applies_to === 'all') return true;
  if ('categories' in rule.applies_to) {
    const category = (item.category ?? '').toLowerCase();
    return rule.applies_to.categories.some((name) => name.toLowerCase() === category);
  }
  return rule.applies_to.items.includes(item.id);
}

/** The changes a caller may make to one menu item, most specific rule last. */
export function optionsForItem(rules: ChangeRules, item: Pick<MenuItem, 'id' | 'category'>): ChangeOption[] {
  const byId = new Map<string, ChangeOption>();
  for (const rule of rules.rules) {
    if (!applies(rule, item)) continue;
    for (const option of rule.can_change) byId.set(option.id, option);
  }
  return [...byId.values()];
}

/** The menu sections whose items may be swapped in or out on one menu item. */
export function swapSectionsForItem(rules: ChangeRules, item: Pick<MenuItem, 'id' | 'category'>): string[] {
  const names = new Map<string, string>();
  for (const rule of rules.rules) {
    if (!applies(rule, item)) continue;
    for (const name of rule.swap_sections) names.set(name.toLowerCase(), name);
  }
  return [...names.values()];
}

export interface ChangeRulesSource {
  get(): ChangeRules;
}

/**
 * Reads the rules file and rereads it whenever it changes on disk, so the
 * restaurant's edits apply to the next call without a restart. If an edit
 * leaves the file invalid, the last good rules stay in force and the problem
 * is logged; a bad file at startup is an error.
 */
export function createChangeRulesSource(path: string | undefined): ChangeRulesSource {
  if (!path) return { get: () => NO_CHANGE_RULES };

  let current = parseChangeRules(readFileSync(path, 'utf8'));
  let loadedMtime = statSync(path).mtimeMs;

  return {
    get() {
      try {
        const mtime = statSync(path).mtimeMs;
        if (mtime !== loadedMtime) {
          loadedMtime = mtime;
          current = parseChangeRules(readFileSync(path, 'utf8'));
          safeLog('info', 'change_rules_reloaded', { rules: current.rules.length });
        }
      } catch (err) {
        safeLog('error', 'change_rules_reload_failed', {
          error: err instanceof Error ? err.message : 'unknown'
        });
      }
      return current;
    }
  };
}
