export const ConversationSearchIdentifier = 'lobe-conversation-search';

export const ConversationSearchApiName = {
  readTopic: 'readTopic',
  searchMessages: 'searchMessages',
  searchTopics: 'searchTopics',
} as const;

export type ConversationSearchApiNameType =
  (typeof ConversationSearchApiName)[keyof typeof ConversationSearchApiName];

/**
 * `agent` narrows the search to conversations of the agent running this turn;
 * `all` widens it to every conversation the user owns. Ownership itself is
 * never a model argument — it always comes from the run context.
 */
export type ConversationSearchScope = 'agent' | 'all';

export interface SearchTopicsParams {
  limit?: number;
  query: string;
  scope?: ConversationSearchScope;
}

export interface SearchMessagesParams {
  limit?: number;
  query: string;
  scope?: ConversationSearchScope;
}

export interface ReadTopicParams {
  topicId: string;
}

/** Minimal topic hit shape shared by the server runtime and the client executor. */
export interface ConversationSearchTopicHit {
  agent?: { title: string | null } | null;
  agentId: string | null;
  id: string;
  title: string;
  updatedAt: Date | string;
}

/** Minimal message hit shape shared by the server runtime and the client executor. */
export interface ConversationSearchMessageHit {
  agentId: string | null;
  content: string;
  id: string;
  role: string;
  topicId: string | null;
  updatedAt: Date | string;
}
