/** A menu item as the prompt needs it; matches the internal menu endpoint. */
export interface PromptMenuItem {
  id: string;
  name: string;
  price_cents: number;
  is_available?: boolean;
  category?: string;
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * The menu as prompt text, grouped by section. Unavailable items are left out
 * so the agent does not offer them. Returns '' when there is nothing to list.
 */
export function buildMenuSection(menu: PromptMenuItem[]): string {
  const sections = new Map<string, string[]>();
  for (const item of menu) {
    if (item.is_available === false) continue;
    const section = item.category ?? 'Menu';
    const lines = sections.get(section) ?? [];
    lines.push(`- ${item.name} | ${dollars(item.price_cents)} | id: ${item.id}`);
    sections.set(section, lines);
  }
  if (sections.size === 0) return '';
  const body = [...sections].map(([section, lines]) => `### ${section}\n${lines.join('\n')}`).join('\n\n');
  return `

## Menu
This is the full current menu. Each line is: name | price | id.
- Offer only these items, and use the exact id in create_order.
- Many dishes come in more than one size or style, each on its own line with its own id. Ask which one the caller wants before adding it.
- When the caller asks what you have, name a section or a few items instead of reading the list.
- Prices here are for answering questions. The order total comes from create_order.
- If the caller asks for something not listed, say it is not on the menu and offer something close.

${body}`;
}

/** The restaurant's change rules as the prompt needs them; matches the menu endpoint. */
export interface PromptChangeRules {
  unlisted_requests: 'pass_to_kitchen' | 'decline';
  rules: Array<{
    applies_to: 'all' | { categories: string[] } | { items: string[] };
    can_change: Array<{ id: string; label: string; price_cents?: number | undefined }>;
    cannot_change: string[];
    guidance?: string[] | undefined;
    comes_with?: string[] | undefined;
    swap_sections?: string[] | undefined;
  }>;
}

export function hasChangeRules(rules: PromptChangeRules | undefined): rules is PromptChangeRules {
  return rules !== undefined && (rules.rules.length > 0 || rules.unlisted_requests === 'decline');
}

/**
 * What callers may and may not change, as prompt text. Item rules show the
 * item's name when the menu is known. Returns '' when there are no rules.
 */
export function buildChangeRulesSection(rules: PromptChangeRules | undefined, menu: PromptMenuItem[] = []): string {
  if (!hasChangeRules(rules)) return '';
  const nameOf = (id: string) => menu.find((item) => item.id === id)?.name ?? id;
  const blocks = rules.rules.map((rule) => {
    const scope =
      rule.applies_to === 'all'
        ? 'Any item'
        : 'categories' in rule.applies_to
          ? `Section: ${rule.applies_to.categories.join(', ')}`
          : `Item: ${rule.applies_to.items.map((id) => `${nameOf(id)} (id: ${id})`).join('; ')}`;
    const allowed = rule.can_change.map(
      (option) =>
        `- ${option.label} | ${option.price_cents ? `+${dollars(option.price_cents)}` : 'no charge'} | option: ${option.id}`
    );
    const refused = rule.cannot_change.map((text) => `- ${text}`);
    const guidance = (rule.guidance ?? []).map((text) => `- ${text}`);
    const swapSections = rule.swap_sections ?? [];
    const comesWith = (rule.comes_with ?? []).map((id) => `${nameOf(id)} (id: ${id})`);
    return [
      `### ${scope}`,
      ...(allowed.length ? ['Allowed:', ...allowed] : []),
      ...(swapSections.length && comesWith.length
        ? [
            'Swaps:',
            `- Comes with, and can be swapped out: ${comesWith.join('; ')}.`,
            `- Can go in: any menu item in these sections: ${swapSections.join(', ')}.`
          ]
        : []),
      ...(guidance.length ? ['Guidance:', ...guidance] : []),
      ...(refused.length ? ['Not allowed:', ...refused] : [])
    ].join('\n');
  });
  const unlisted =
    rules.unlisted_requests === 'decline'
      ? '- A request that is not listed here: say politely that the kitchen cannot take that change over the phone. Do not put it in a note.'
      : '- A request that is not listed here: accept it, put it in that item\'s note, and say you will pass it to the kitchen. Do not promise it can be done. If it adds something or swaps something in, say there may be an extra charge that the restaurant confirms at pickup.';
  const swapLine = rules.rules.some((rule) => (rule.swap_sections ?? []).length > 0 && (rule.comes_with ?? []).length > 0)
    ? `- A swap listed under "Swaps": add it to that item's "swaps" in create_order, with out_item_id (one of the things the item comes with) and in_item_id (the menu item that goes in). The system charges the new item's menu price minus the old one's when the new one costs more, and nothing otherwise. Do not work that amount out yourself: call price_order with the item and its swap, and tell the caller the charge it returns. Do not also write the swap in the note. A swap of anything else is a request that is not listed here.
`
    : '';
  return `

## Changes callers can ask for
The restaurant set these rules. Follow them exactly.
- An allowed change: add its option id to that item's "options" in create_order. The system adds any charge. Tell the caller the extra cost when there is one.
${swapLine}- A "Guidance" line is the restaurant's own instruction for that kind of request. Follow it. A change it allows has no option id, so write it in that item's note in a few words for the kitchen.
- A change marked not allowed: say politely that it is not available. Do not put it in a note and do not offer a workaround.
${unlisted}
- A rule for an item overrides a rule for its section, which overrides a rule for any item.

${blocks.join('\n\n')}`;
}

export function buildSystemPrompt(storeName: string, menu?: PromptMenuItem[], changeRules?: PromptChangeRules): string {
  const menuSection = menu ? buildMenuSection(menu) : '';
  const rulesSection = buildChangeRulesSection(changeRules, menu);
  return basePrompt(storeName, menuSection !== '', rulesSection !== '') + menuSection + rulesSection;
}

function basePrompt(storeName: string, hasMenu: boolean, hasRules: boolean): string {
  const changeRule = hasRules
    ? `- If the caller asks to change an item, follow the "Changes callers can ask for" section below. Do not use transfer_to_staff for a change request.`
    : `- If the caller asks to change an item (no onions, extra spicy, add something, swap a side), accept it and put it in that item's note in create_order. Say you will pass the request to the kitchen. Do not promise it can be done, and if they are adding something, say the price may change at pickup. Do not use transfer_to_staff for a change like this.`;
  const menuRules = hasMenu
    ? `- You can ONLY offer items in the Menu section below. You already have the menu, so you do not need search_menu to answer what is available; use it only to double-check an item you are unsure about.`
    : `- You can ONLY offer items that exist in the menu. Use the search_menu tool to look up items.
- If the caller asks what is on the menu or what you have, call search_menu with an empty query to get the full menu, then name a few items instead of reading the whole list.`;
  const takeOrderStep = hasMenu
    ? `3. Take their order — ask what they'd like and match each item to the Menu section, including size or style.`
    : `3. Take their order — ask what they'd like. Use search_menu to validate each item.`;
  return `You are a friendly phone ordering assistant for ${storeName}. You help callers place pickup orders.

## Rules
- This is a PICKUP ONLY restaurant. If a caller asks about delivery, politely explain that only pickup is available. If they insist on delivery, use the transfer_to_staff tool.
- Payment is at pickup. Do not ask for payment information.
- You MUST collect the caller's name before taking their order.
${menuRules}
${changeRule}
- An allergy or a request about the whole order goes in the order's notes. For an allergy, also say you cannot guarantee the kitchen is free of that ingredient.
- Before submitting an order, read it back, including any requested changes, to the caller and get explicit confirmation ("yes", "that's right", etc.). Do NOT submit until they confirm.
- Keep responses concise and natural — you're on a phone call, not writing an essay.

## Store Mode Behavior
- Call get_store_mode at the start of every call.
- If the store is OPEN: greet the caller and offer to take their order.
- If the store is BUSY: inform the caller that wait times may be longer than usual, but still take orders.
- If the store is CLOSED: apologize, let them know the store is closed, and use end_call.

## Conversation Flow
1. Greet the caller warmly. Check the store mode.
2. Ask for their name.
${takeOrderStep}
4. When they're done ordering, read back the full order and ask for confirmation.
5. On confirmation, use create_order to submit.
6. Thank them and let them know their order is in. Use end_call.

## Escalation
- If the caller asks for a staff member, human, or manager, use transfer_to_staff immediately.
- If you cannot understand the caller after 2-3 attempts, use transfer_to_staff.
- If the situation is outside your scope (complaints, refunds, etc.), use transfer_to_staff.

## Tools Available
- get_store_mode: Check if the store is OPEN, BUSY, or CLOSED.
- search_menu: Search for menu items by name, or pass an empty query to list the full menu. Returns items with prices.
- create_order: Submit a confirmed order. Requires customer_name and items with item_id and qty. Each item may carry a note with the caller's requested change.
- transfer_to_staff: Transfer the call to a staff member. Provide a reason.
- end_call: End the call. Use after completing an order or when the store is closed.`;
}

/** The order lines create_order and price_order both take. */
const ORDER_ITEMS_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      item_id: { type: 'string', description: 'Menu item ID from the menu or search_menu results' },
      qty: { type: 'integer', description: 'Quantity ordered' },
      options: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Option ids for this item, taken from the "Changes callers can ask for" section. Use these for listed changes. Leave out when there are none.'
      },
      swaps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            out_item_id: { type: 'string', description: 'Menu item ID of the thing the item comes with that is taken out' },
            in_item_id: { type: 'string', description: 'Menu item ID of what goes in' }
          },
          required: ['out_item_id', 'in_item_id']
        },
        description:
          'Swaps of one menu item for another on this item, only where the "Changes callers can ask for" section lists swaps. Leave out when there are none.'
      },
      note: {
        type: 'string',
        description:
          'A requested change that has no option id, in a few words for the kitchen, e.g. "sauce on the side". Leave out when there is none.'
      }
    },
    required: ['item_id', 'qty']
  },
  description: 'List of items to order'
};

export function buildToolDefinitions(): Array<{
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}> {
  return [
    {
      type: 'function',
      name: 'get_store_mode',
      description: 'Check if the store is currently OPEN, BUSY, or CLOSED. Call this at the start of every conversation.',
      parameters: { type: 'object', properties: {}, required: [] }
    },
    {
      type: 'function',
      name: 'search_menu',
      description: 'Search the menu by item name, or list the full menu with an empty query. The query is matched against item names only, so words like "menu" or "food" match nothing. Returns item names, IDs, prices, and availability.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Part of an item name (e.g. "burger", "fries"). Use an empty string to list every item.' }
        },
        required: ['query']
      }
    },
    {
      type: 'function',
      name: 'create_order',
      description: 'Submit a confirmed pickup order. Only call this AFTER the caller has confirmed the order readback.',
      parameters: {
        type: 'object',
        properties: {
          customer_name: { type: 'string', description: 'The caller\'s name' },
          items: ORDER_ITEMS_SCHEMA,
          notes: {
            type: 'string',
            description: 'A request about the whole order, e.g. "extra napkins" or an allergy. Leave out when there is none.'
          }
        },
        required: ['customer_name', 'items']
      }
    },
    {
      type: 'function',
      name: 'price_order',
      description:
        'Price items without placing an order. Use it to tell the caller the exact cost of a swap or a paid change, or the total, before they confirm. Takes the same items as create_order and returns each line with its charges and the total, in cents.',
      parameters: {
        type: 'object',
        properties: { items: ORDER_ITEMS_SCHEMA },
        required: ['items']
      }
    },
    {
      type: 'function',
      name: 'transfer_to_staff',
      description: 'Transfer the call to a staff member. Use when the caller requests a human, or the situation is outside your scope.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Why the call is being transferred' }
        },
        required: ['reason']
      }
    },
    {
      type: 'function',
      name: 'end_call',
      description: 'End the phone call. Use after successfully completing an order, or when the store is closed.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Why the call is ending' }
        },
        required: ['reason']
      }
    }
  ];
}
