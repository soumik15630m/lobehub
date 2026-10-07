export * from './fromMessages';

/** One completed dialogue or tool-result entry for a fresh native session. */
export interface ConversationHistoryEntry {
  /** Dialogue text or the completed tool result. */
  content: string;
  /** Persisted selection and attachment context, separate from dialogue truncation. */
  context?: string;
  /** Original role, retained so tool output is never presented as a user instruction. */
  role: 'assistant' | 'tool' | 'user';
}

export interface PreviousConversationOptions {
  /**
   * Upper bound for the formatted turns. The newest turns are kept; older turns
   * beyond the budget are replaced by a single omission note.
   */
  maxTotalChars?: number;
}

const USER_MAX = 1024;
const ASSISTANT_MAX = 2048;

const formatEntry = (entry: ConversationHistoryEntry) => {
  const limit = entry.role === 'user' ? USER_MAX : ASSISTANT_MAX;
  const body =
    entry.content.length > limit ? `${entry.content.slice(0, limit)}… [truncated]` : entry.content;
  return `<${entry.role}>\n${[body, entry.context].filter(Boolean).join('\n\n')}\n</${entry.role}>`;
};

/**
 * Formats prior turns for a heterogeneous agent that starts without native history.
 *
 * Per-turn truncation: user turns 1 KB, assistant turns 2 KB.
 *
 * @example
 * formatPreviousConversation([{ content: 'hi', role: 'user' }]);
 * // '<previous_conversation>\n<user>\nhi\n</user>\n</previous_conversation>'
 */
export const formatPreviousConversation = (
  entries: ConversationHistoryEntry[],
  { maxTotalChars }: PreviousConversationOptions = {},
): string | undefined => {
  if (entries.length === 0) return;

  const formatted = entries.map(formatEntry);
  let kept = formatted;
  if (maxTotalChars !== undefined) {
    let total = 0;
    let start = formatted.length;
    while (start > 0 && total + formatted[start - 1].length <= maxTotalChars) {
      start -= 1;
      total += formatted[start].length;
    }
    kept = formatted.slice(start);
    if (start > 0) kept.unshift(`[${start} earlier turns omitted]`);
  }

  return `<previous_conversation>\n${kept.join('\n')}\n</previous_conversation>`;
};
