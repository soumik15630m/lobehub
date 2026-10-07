import { LOADING_FLAT } from '@lobechat/const';
import type { ChatImageItem, UIChatMessage } from '@lobechat/types';

import { formatContextSelections } from '../../agents/contextSelectionContext';
import { formatPageSelections } from '../../agents/pageSelectionContext';
import { filesPrompts } from '../files';
import type { ConversationHistoryEntry } from './index';

/** Durable context for a fresh heterogeneous run anchored at an existing user message. */
export interface HeterogeneousConversationContext {
  /** Persisted selections and attachment descriptions belonging to the current prompt. */
  currentContext?: string;
  /** Completed ancestors only; the current prompt is delivered separately. */
  history: ConversationHistoryEntry[];
  /** Vision inputs from the retained ancestors and current prompt, deduplicated by file id. */
  imageList: Array<Pick<ChatImageItem, 'id' | 'url'>>;
}

/** Formats persisted user context using the same selection and file formats as ordinary sends. */
const messageContext = (message: UIChatMessage): string => {
  const selections = message.metadata?.contextSelections;
  const pages = message.metadata?.pageSelections;
  return [
    selections?.length
      ? formatContextSelections(selections)
      : pages?.length
        ? formatPageSelections(pages)
        : '',
    filesPrompts({
      fileList: message.fileList,
      imageList: message.imageList,
      messageId: message.id,
    }),
  ]
    .filter(Boolean)
    .join('\n\n');
};

/**
 * Builds fresh-run context from the persisted ancestry before a user-message boundary.
 *
 * Use when:
 * - An edited user message starts a new native session on Desktop or a connected device.
 * - Native-session recovery needs the same durable history after a refresh or failed run.
 *
 * Expects:
 * - Authorized raw messages, including their parent ids and resolved attachment URLs.
 * - The id of the prompt being executed; unrelated branches are never inferred by time.
 *
 * Returns:
 * - Up to thirty ancestral rows, their completed tool batches, selections and vision inputs.
 * - No current prompt, later reply, unrelated branch, or mutation of the supplied messages.
 */
export const buildHeterogeneousConversationContext = (
  messages: readonly UIChatMessage[] | undefined,
  currentMessageId: string | undefined,
): HeterogeneousConversationContext => {
  const empty: HeterogeneousConversationContext = { history: [], imageList: [] };
  if (!messages?.length || !currentMessageId) return empty;
  const byId = new Map(messages.map((message) => [message.id, message]));
  const current = byId.get(currentMessageId);
  if (!current) return empty;

  const ancestors: UIChatMessage[] = [];
  const visited = new Set<string>(current.role === 'user' ? [currentMessageId] : []);
  let id = current.role === 'user' ? current.parentId : current.id;
  while (id && !visited.has(id)) {
    visited.add(id);
    const message = byId.get(id);
    if (!message || (message.threadId ?? null) !== (current.threadId ?? null)) break;
    ancestors.push(message);
    id = message.parentId;
  }
  ancestors.reverse();

  // A completed parallel tool batch has siblings under the same assistant.
  // Include only calls owned by that ancestor, never a sibling assistant attempt.
  const ordered = new Map<string, UIChatMessage>();
  for (const message of ancestors) {
    ordered.set(message.id, message);
    if (message.role !== 'assistant') continue;
    const calls = new Set(message.tools?.map((tool) => tool.id));
    for (const tool of messages) {
      if (
        tool.role === 'tool' &&
        tool.parentId === message.id &&
        (tool.threadId ?? null) === (current.threadId ?? null) &&
        tool.tool_call_id &&
        calls.has(tool.tool_call_id)
      ) {
        ordered.set(tool.id, tool);
      }
    }
  }
  const retained = [...ordered.values()]
    .filter(
      (message) =>
        ['user', 'assistant', 'tool'].includes(message.role) && message.content !== LOADING_FLAT,
    )
    .slice(-30);
  const history: ConversationHistoryEntry[] = retained.flatMap((message) => {
    const role = message.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'tool') return [];
    // Tool completion order can differ from call order. Carry the result's ID
    // outside the truncated body so replay keeps parallel call attribution.
    const context =
      role === 'user'
        ? messageContext(message)
        : role === 'tool' && message.tool_call_id
          ? `Tool call ID: ${message.tool_call_id}`
          : undefined;
    const calls =
      role === 'assistant' && message.tools?.length
        ? `<tool_calls>\n${JSON.stringify(message.tools)}\n</tool_calls>`
        : '';
    const content = [message.content, calls].filter(Boolean).join('\n');
    return content || context ? [{ content, role, ...(context ? { context } : {}) }] : [];
  });
  const images = new Map<string, Pick<ChatImageItem, 'id' | 'url'>>();
  for (const message of [...retained, current]) {
    for (const image of message.imageList ?? [])
      images.set(image.id, { id: image.id, url: image.url });
  }
  return {
    currentContext: current.role === 'user' ? messageContext(current) || undefined : undefined,
    history,
    imageList: [...images.values()],
  };
};
