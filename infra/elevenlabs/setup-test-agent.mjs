// Creates (or updates) the mei.ai test agent on ElevenLabs Agents: one stored
// secret, three webhook tools that call the order API, and the agent itself.
// It looks everything up by name, so running it twice changes nothing new and
// never touches other agents in the account.
//
// Run `npm run build` first; the prompt is read from dist/.
//
//   ELEVENLABS_API_KEY=... INTERNAL_API_KEY=... \
//   ORDER_API_BASE_URL=https://orders.example.com \
//   node infra/elevenlabs/setup-test-agent.mjs
import { buildSystemPrompt } from '../../dist/workers/call-prompt.js';

const API = 'https://api.elevenlabs.io/v1/convai';
const env = process.env;

function required(name) {
  const value = env[name];
  if (!value) {
    console.error(`Missing ${name}`);
    process.exit(2);
  }
  return value;
}

const apiKey = required('ELEVENLABS_API_KEY');
const internalApiKey = required('INTERNAL_API_KEY');
const orderApi = required('ORDER_API_BASE_URL').replace(/\/$/, '');
const storeId = env.STORE_ID || 'store-1';
const storeName = env.STORE_NAME || 'Mei Test Kitchen';
const agentName = env.ELEVENLABS_AGENT_NAME || 'mei.ai test';
const secretName = env.ELEVENLABS_SECRET_NAME || 'mei_ai_test_order_api_key';

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 600)}`);
  return text ? JSON.parse(text) : {};
}

async function ensureSecret() {
  const { secrets = [] } = await call('GET', '/secrets');
  const found = secrets.find((secret) => secret.name === secretName);
  if (found) {
    await call('PATCH', `/secrets/${found.secret_id}`, { type: 'update', name: secretName, value: internalApiKey });
    return found.secret_id;
  }
  const created = await call('POST', '/secrets', { type: 'new', name: secretName, value: internalApiKey });
  return created.secret_id;
}

function toolConfigs(secretId) {
  const headers = { 'x-internal-api-key': { secret_id: secretId } };
  return [
    {
      type: 'webhook',
      name: 'get_store_mode',
      description: 'Check if the store is currently OPEN, BUSY, or CLOSED. Call this at the start of every conversation.',
      response_timeout_secs: 10,
      api_schema: { url: `${orderApi}/api/internal/stores/${storeId}`, method: 'GET', request_headers: headers }
    },
    {
      type: 'webhook',
      name: 'search_menu',
      description:
        'Search the menu by item name, or list the full menu by leaving q out. q is matched against item names only, so words like "menu" or "food" match nothing. Returns item names, ids, prices in cents, and availability.',
      response_timeout_secs: 10,
      api_schema: {
        url: `${orderApi}/api/internal/stores/${storeId}/menu`,
        method: 'GET',
        request_headers: headers,
        query_params_schema: {
          properties: {
            q: { type: 'string', description: 'Part of an item name, for example "burrito". Leave out to list every item.' }
          },
          required: []
        }
      }
    },
    {
      type: 'webhook',
      name: 'create_order',
      description: 'Submit a confirmed pickup order. Only call this AFTER the caller has confirmed the order readback.',
      response_timeout_secs: 15,
      api_schema: {
        url: `${orderApi}/api/internal/orders`,
        method: 'POST',
        request_headers: headers,
        request_body_schema: {
          type: 'object',
          description: 'The confirmed order.',
          required: ['store_id', 'call_id', 'customer_name', 'customer_phone', 'items'],
          properties: {
            store_id: { type: 'string', constant_value: storeId },
            call_id: { type: 'string', dynamic_variable: 'system__conversation_id' },
            customer_name: { type: 'string', description: "The caller's name." },
            customer_phone: { type: 'string', dynamic_variable: 'system__caller_id' },
            items: {
              type: 'array',
              description: 'Items in the order.',
              items: {
                type: 'object',
                description: 'One line of the order.',
                required: ['item_id', 'qty'],
                properties: {
                  item_id: { type: 'string', description: 'Menu item id from the menu or search_menu results.' },
                  qty: { type: 'integer', description: 'Quantity ordered.' },
                  options: {
                    type: 'array',
                    description: 'Option ids for this item from the "Changes callers can ask for" section. Leave empty when there are none.',
                    items: { type: 'string', description: 'One option id.' }
                  },
                  swaps: {
                    type: 'array',
                    description:
                      'Swaps of one menu item for another on this item, only where the "Changes callers can ask for" section lists swaps. Leave empty when there are none.',
                    items: {
                      type: 'object',
                      description: 'One swap.',
                      required: ['out_item_id', 'in_item_id'],
                      properties: {
                        out_item_id: { type: 'string', description: 'Menu item id of what comes out.' },
                        in_item_id: { type: 'string', description: 'Menu item id of what goes in, in the same size.' }
                      }
                    }
                  },
                  note: {
                    type: 'string',
                    description:
                      "A requested change that has no option id, in a few words for the kitchen, e.g. sauce on the side. Leave empty when there is none."
                  }
                }
              }
            },
            notes: {
              type: 'string',
              description: 'A request about the whole order, e.g. extra napkins or an allergy. Leave empty when there is none.'
            }
          }
        }
      }
    }
  ];
}

async function ensureTools(secretId) {
  const { tools = [] } = await call('GET', '/tools');
  const ids = [];
  for (const config of toolConfigs(secretId)) {
    const found = tools.find((tool) => tool.tool_config?.name === config.name);
    if (found) {
      await call('PATCH', `/tools/${found.id}`, { tool_config: config });
      ids.push(found.id);
    } else {
      const created = await call('POST', '/tools', { tool_config: config });
      ids.push(created.id);
    }
  }
  return ids;
}

const PROMPT_ADDENDUM = `

## This phone line
- transfer_to_staff is not available on this line. If the caller asks for a person, apologize and offer to keep helping.
- search_menu takes q, part of an item name. Prices from tools come back in cents; say them as dollars and cents.
- Use end_call to hang up after the order is placed or when the caller says goodbye.`;

/**
 * The menu and the restaurant's change rules go into the agent's prompt, so
 * they are fixed when this script runs. Run it again after either changes.
 */
async function fetchMenu() {
  const res = await fetch(`${orderApi}/api/internal/stores/${storeId}/menu`, {
    headers: { 'x-internal-api-key': internalApiKey, Accept: 'application/json' }
  });
  if (!res.ok) throw new Error(`menu request returned ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body.items) || body.items.length === 0) throw new Error('menu is empty');
  return { items: body.items, changeRules: body.change_rules };
}

function agentBody(toolIds, menu) {
  const prompt = {
    prompt: buildSystemPrompt(storeName, menu.items, menu.changeRules) + PROMPT_ADDENDUM,
    temperature: 0,
    tool_ids: toolIds,
    built_in_tools: {
      end_call: { type: 'system', name: 'end_call', description: '', params: { system_tool_type: 'end_call' } }
    }
  };
  if (env.ELEVENLABS_LLM) prompt.llm = env.ELEVENLABS_LLM;

  const tts = {};
  if (env.ELEVENLABS_TTS_MODEL) tts.model_id = env.ELEVENLABS_TTS_MODEL;
  if (env.ELEVENLABS_VOICE_ID) tts.voice_id = env.ELEVENLABS_VOICE_ID;

  return {
    name: agentName,
    conversation_config: {
      agent: {
        language: 'en',
        first_message: `Hi, thanks for calling ${storeName}. I'm an AI assistant and I can take your pickup order. What can I get for you?`,
        prompt
      },
      ...(Object.keys(tts).length > 0 ? { tts } : {})
    }
  };
}

async function ensureAgent(toolIds, menu) {
  const { agents = [] } = await call('GET', `/agents?page_size=100&search=${encodeURIComponent(agentName)}`);
  const found = agents.find((agent) => agent.name === agentName);
  if (found) {
    await call('PATCH', `/agents/${found.agent_id}`, agentBody(toolIds, menu));
    return found.agent_id;
  }
  const created = await call('POST', '/agents/create', agentBody(toolIds, menu));
  return created.agent_id;
}

const menu = await fetchMenu();
const secretId = await ensureSecret();
const toolIds = await ensureTools(secretId);
const agentId = await ensureAgent(toolIds, menu);
console.log(
  JSON.stringify(
    {
      agent_id: agentId,
      tool_ids: toolIds,
      secret_id: secretId,
      menu_items: menu.items.length,
      change_rules: menu.changeRules?.rules?.length ?? 0
    },
    null,
    2
  )
);
