import {
  clampSearchLimit,
  ConversationSearchIdentifier,
  formatMessageResults,
  formatTopicResults,
  messageFetchLimit,
  type ReadTopicParams,
  resolveAgentFilter,
  type SearchMessagesParams,
  type SearchTopicsParams,
} from '@lobechat/builtin-tool-conversation-search';
import type { BuiltinServerRuntimeOutput } from '@lobechat/types';

import type {
  FtsSearchMessageResult,
  FtsSearchTopicResult,
} from '@/database/repositories/ftsSearch';
import { createFtsSearchRepo } from '@/server/services/ftsSearch';
import { TopicReferenceService } from '@/server/services/topicReference';

import type { ServerRuntimeRegistration } from './types';

const toFailure = (action: string, error: unknown): BuiltinServerRuntimeOutput => {
  const errorMessage = error instanceof Error ? error.message : String(error);
  return { content: `Failed to ${action}: ${errorMessage}`, error, success: false };
};

/**
 * Agent-side conversation search. A thin wrapper over the unified FTS repo so
 * share-visitor filtering and workspace scoping are inherited from the backend;
 * user / workspace / agent scope always comes from the run context.
 */
export const conversationSearchRuntime: ServerRuntimeRegistration = {
  factory: (context) => {
    if (!context.serverDB) {
      throw new Error('serverDB is required for ConversationSearch execution');
    }
    if (!context.userId) {
      throw new Error('userId is required for ConversationSearch execution');
    }

    const db = context.serverDB;
    const userId = context.userId;
    const workspaceId = context.workspaceId;

    const createRepo = () =>
      createFtsSearchRepo({ db, usage: 'conversation_search_tool', userId, workspaceId });

    return {
      readTopic: async (params: ReadTopicParams): Promise<BuiltinServerRuntimeOutput> => {
        if (!params.topicId) return { content: 'topicId is required', success: false };
        try {
          return await new TopicReferenceService(db, userId, workspaceId).getTopicContext(params);
        } catch (error) {
          return toFailure('read topic', error);
        }
      },

      searchMessages: async (params: SearchMessagesParams): Promise<BuiltinServerRuntimeOutput> => {
        const query = params.query?.trim();
        if (!query) return { content: 'query is required', success: false };

        const limit = clampSearchLimit(params.limit);
        const agentFilter = resolveAgentFilter(params.scope, context.agentId);
        try {
          const repo = await createRepo();
          const hits = (await repo.search({
            agentId: agentFilter,
            limitPerType: messageFetchLimit(limit),
            query,
            type: 'message',
          })) as FtsSearchMessageResult[];
          return {
            content: formatMessageResults(hits, { agentFilter, limit, query }),
            success: true,
          };
        } catch (error) {
          return toFailure('search messages', error);
        }
      },

      searchTopics: async (params: SearchTopicsParams): Promise<BuiltinServerRuntimeOutput> => {
        const query = params.query?.trim();
        if (!query) return { content: 'query is required', success: false };

        const agentFilter = resolveAgentFilter(params.scope, context.agentId);
        try {
          const repo = await createRepo();
          const hits = (await repo.search({
            agentId: agentFilter,
            limitPerType: clampSearchLimit(params.limit),
            query,
            type: 'topic',
          })) as FtsSearchTopicResult[];
          return { content: formatTopicResults(hits, { agentFilter, query }), success: true };
        } catch (error) {
          return toFailure('search topics', error);
        }
      },
    };
  },
  identifier: ConversationSearchIdentifier,
};
