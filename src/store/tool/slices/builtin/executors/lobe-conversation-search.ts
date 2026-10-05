import {
  clampSearchLimit,
  formatMessageResults,
  formatTopicResults,
  messageFetchLimit,
  type ReadTopicParams,
  resolveAgentFilter,
  type SearchMessagesParams,
  type SearchTopicsParams,
} from '@lobechat/builtin-tool-conversation-search';
import {
  type ConversationSearchExecutionRuntime,
  ConversationSearchExecutor,
} from '@lobechat/builtin-tool-conversation-search/executor';
import type { BuiltinToolContext, BuiltinToolResult } from '@lobechat/types';

import { lambdaClient } from '@/libs/trpc/client';

const toFailure = (action: string, error: unknown): BuiltinToolResult => {
  const errorMessage = error instanceof Error ? error.message : String(error);
  return { content: `Failed to ${action}: ${errorMessage}`, success: false };
};

class ConversationSearchClientRuntime implements ConversationSearchExecutionRuntime {
  searchTopics = async (
    params: SearchTopicsParams,
    ctx: BuiltinToolContext,
  ): Promise<BuiltinToolResult> => {
    const query = params.query?.trim();
    if (!query) return { content: 'query is required', success: false };

    const agentFilter = resolveAgentFilter(params.scope, ctx.agentId);
    try {
      const hits = await lambdaClient.search.query.query({
        agentId: agentFilter,
        limitPerType: clampSearchLimit(params.limit),
        query,
        type: 'topic',
      });
      return {
        content: formatTopicResults(hits, { agentFilter, query }),
        success: true,
      };
    } catch (error) {
      return toFailure('search topics', error);
    }
  };

  searchMessages = async (
    params: SearchMessagesParams,
    ctx: BuiltinToolContext,
  ): Promise<BuiltinToolResult> => {
    const query = params.query?.trim();
    if (!query) return { content: 'query is required', success: false };

    const limit = clampSearchLimit(params.limit);
    const agentFilter = resolveAgentFilter(params.scope, ctx.agentId);
    try {
      const hits = await lambdaClient.search.query.query({
        agentId: agentFilter,
        limitPerType: messageFetchLimit(limit),
        query,
        type: 'message',
      });
      return {
        content: formatMessageResults(hits, { agentFilter, limit, query }),
        success: true,
      };
    } catch (error) {
      return toFailure('search messages', error);
    }
  };

  readTopic = async (params: ReadTopicParams): Promise<BuiltinToolResult> => {
    if (!params.topicId) return { content: 'topicId is required', success: false };
    try {
      const result = await lambdaClient.topic.getTopicContext.query({ topicId: params.topicId });
      return { content: result.content, success: result.success };
    } catch (error) {
      return toFailure('read topic', error);
    }
  };
}

export const conversationSearchExecutor = new ConversationSearchExecutor(
  new ConversationSearchClientRuntime(),
);
