import { type BuiltinToolManifest } from '@lobechat/types';

import { systemPrompt } from './systemRole';
import { ConversationSearchApiName, ConversationSearchIdentifier } from './types';

const scopeProperty = {
  description:
    "'agent' (default) searches only this agent's conversations; 'all' searches every conversation the user has had with any agent. Use 'all' only when the user asks about a conversation with another assistant or the current agent has no match.",
  enum: ['agent', 'all'],
  type: 'string',
} as const;

const limitProperty = {
  description: 'Maximum number of results (1-10, default 5)',
  maximum: 10,
  minimum: 1,
  type: 'number',
} as const;

export const ConversationSearchManifest: BuiltinToolManifest = {
  api: [
    {
      description:
        "Keyword search over the titles of the user's past LobeHub conversations (topics). Returns topic ids, titles, agents and last-updated time. Use it to find where something was discussed before, then call readTopic for the content.",
      name: ConversationSearchApiName.searchTopics,
      parameters: {
        additionalProperties: false,
        properties: {
          limit: limitProperty,
          query: { description: 'Keywords to search for', type: 'string' },
          scope: scopeProperty,
        },
        required: ['query'],
        type: 'object',
      },
    },
    {
      description:
        "Keyword search over the message contents of the user's past LobeHub conversations. Returns short snippets around the match with their topic ids. This searches LobeHub chat history only, not Discord/Slack/Telegram channels.",
      name: ConversationSearchApiName.searchMessages,
      parameters: {
        additionalProperties: false,
        properties: {
          limit: limitProperty,
          query: { description: 'Keywords to search for', type: 'string' },
          scope: scopeProperty,
        },
        required: ['query'],
        type: 'object',
      },
    },
    {
      description:
        'Read a past conversation found by searchTopics or searchMessages. Returns the topic summary if available, otherwise its most recent messages.',
      name: ConversationSearchApiName.readTopic,
      parameters: {
        additionalProperties: false,
        properties: {
          topicId: { description: 'The topic id returned by a search', type: 'string' },
        },
        required: ['topicId'],
        type: 'object',
      },
    },
  ],
  identifier: ConversationSearchIdentifier,
  meta: {
    avatar: '🔎',
    description: "Search and read the user's past conversations",
    title: 'Conversation Search',
  },
  systemRole: systemPrompt,
  type: 'builtin',
};
