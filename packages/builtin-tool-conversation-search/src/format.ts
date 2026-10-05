import type {
  ConversationSearchMessageHit,
  ConversationSearchScope,
  ConversationSearchTopicHit,
} from './types';

export const DEFAULT_SEARCH_LIMIT = 5;
export const MAX_SEARCH_LIMIT = 10;
/** Hard cap for one message snippet, in characters. */
export const SNIPPET_MAX_CHARS = 280;
/** Hard cap for the whole tool result, in characters (~2k tokens). */
export const RESULT_BUDGET_CHARS = 6000;

/**
 * Roles whose content is conversation the user would recognise. Tool results
 * and system injections are verbose machine payloads that drown real hits.
 */
const SEARCHABLE_ROLES = new Set(['assistant', 'user']);

export const clampSearchLimit = (limit?: number) => {
  if (!limit || !Number.isFinite(limit)) return DEFAULT_SEARCH_LIMIT;
  return Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.floor(limit)));
};

/** Resolve the agent filter from run context; the model only chooses the breadth. */
export const resolveAgentFilter = (scope: ConversationSearchScope | undefined, agentId?: string) =>
  scope === 'all' ? undefined : agentId;

const escapeAttr = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');

const escapeText = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;');

const toIso = (value: Date | string) =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

/**
 * Cut a window of `maxChars` around the first occurrence of the query (or of
 * any of its whitespace-separated terms), so a 20k-char message becomes a
 * short excerpt that still shows why it matched.
 */
export const buildSnippet = (content: string, query: string, maxChars = SNIPPET_MAX_CHARS) => {
  const text = content.replaceAll(/\s+/g, ' ').trim();
  if (text.length <= maxChars) return text;

  const lower = text.toLowerCase();
  const terms = [query, ...query.split(/\s+/)]
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean);
  const matchIndex = terms.reduce<number>((found, term) => {
    if (found !== -1) return found;
    return lower.indexOf(term);
  }, -1);

  const center = matchIndex === -1 ? 0 : matchIndex;
  const start = Math.max(0, Math.min(center - Math.floor(maxChars / 3), text.length - maxChars));
  const end = start + maxChars;

  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
};

/** Append blocks until the character budget is spent; report how many were dropped. */
const fitBudget = (blocks: string[], budget: number) => {
  const kept: string[] = [];
  let used = 0;
  for (const block of blocks) {
    if (used + block.length > budget) break;
    kept.push(block);
    used += block.length;
  }
  return { kept, omitted: blocks.length - kept.length };
};

const scopeLabel = (agentFilter?: string) => (agentFilter ? 'agent' : 'all');

export const formatTopicResults = (
  hits: ConversationSearchTopicHit[],
  { agentFilter, query }: { agentFilter?: string; query: string },
) => {
  if (hits.length === 0) {
    return `No conversations found for "${query}" (scope: ${scopeLabel(agentFilter)}).${
      agentFilter ? ' Try scope "all" or searchMessages.' : ' Try searchMessages.'
    }`;
  }

  const blocks = hits.map((hit) => {
    const agentTitle = hit.agent?.title ? ` agent="${escapeAttr(hit.agent.title)}"` : '';
    const agentId = hit.agentId ? ` agentId="${hit.agentId}"` : '';
    return `<topic id="${hit.id}" title="${escapeAttr(hit.title)}"${agentId}${agentTitle} updatedAt="${toIso(hit.updatedAt)}" />`;
  });
  const { kept, omitted } = fitBudget(blocks, RESULT_BUDGET_CHARS);

  return [
    `<topics query="${escapeAttr(query)}" scope="${scopeLabel(agentFilter)}" count="${kept.length}"${omitted ? ` omitted="${omitted}"` : ''}>`,
    ...kept,
    '</topics>',
    'Call readTopic with a topic id to read that conversation.',
  ].join('\n');
};

export const formatMessageResults = (
  hits: ConversationSearchMessageHit[],
  { agentFilter, limit, query }: { agentFilter?: string; limit: number; query: string },
) => {
  const relevant = hits
    .filter((hit) => SEARCHABLE_ROLES.has(hit.role) && hit.topicId)
    .slice(0, limit);

  if (relevant.length === 0) {
    return `No messages found for "${query}" (scope: ${scopeLabel(agentFilter)}).${
      agentFilter ? ' Try scope "all".' : ''
    }`;
  }

  const blocks = relevant.map(
    (hit) =>
      `<message id="${hit.id}" topicId="${hit.topicId}" role="${hit.role}"${
        hit.agentId ? ` agentId="${hit.agentId}"` : ''
      } updatedAt="${toIso(hit.updatedAt)}">${escapeText(buildSnippet(hit.content, query))}</message>`,
  );
  const { kept, omitted } = fitBudget(blocks, RESULT_BUDGET_CHARS);

  return [
    `<messages query="${escapeAttr(query)}" scope="${scopeLabel(agentFilter)}" count="${kept.length}"${omitted ? ` omitted="${omitted}"` : ''}>`,
    ...kept,
    '</messages>',
    'Snippets are excerpts. Call readTopic with a topicId before relying on them.',
  ].join('\n');
};

/**
 * Message search over-fetches because tool / system rows are dropped after
 * retrieval; the backend cannot filter by role.
 */
export const messageFetchLimit = (limit: number) => Math.min(limit * 3, 30);
