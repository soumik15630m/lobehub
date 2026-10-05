import type { BuiltinToolContext, BuiltinToolResult } from '@lobechat/types';
import { BaseExecutor } from '@lobechat/types';

import {
  ConversationSearchApiName,
  ConversationSearchIdentifier,
  type ReadTopicParams,
  type SearchMessagesParams,
  type SearchTopicsParams,
} from '../types';

export interface ConversationSearchExecutionRuntime {
  readTopic: (params: ReadTopicParams, ctx: BuiltinToolContext) => Promise<BuiltinToolResult>;
  searchMessages: (
    params: SearchMessagesParams,
    ctx: BuiltinToolContext,
  ) => Promise<BuiltinToolResult>;
  searchTopics: (params: SearchTopicsParams, ctx: BuiltinToolContext) => Promise<BuiltinToolResult>;
}

export class ConversationSearchExecutor extends BaseExecutor<typeof ConversationSearchApiName> {
  readonly identifier = ConversationSearchIdentifier;
  protected readonly apiEnum = ConversationSearchApiName;
  private runtime: ConversationSearchExecutionRuntime;

  constructor(runtime: ConversationSearchExecutionRuntime) {
    super();
    this.runtime = runtime;
  }

  searchTopics = async (params: SearchTopicsParams, ctx: BuiltinToolContext) =>
    this.runtime.searchTopics(params, ctx);

  searchMessages = async (params: SearchMessagesParams, ctx: BuiltinToolContext) =>
    this.runtime.searchMessages(params, ctx);

  readTopic = async (params: ReadTopicParams, ctx: BuiltinToolContext) =>
    this.runtime.readTopic(params, ctx);
}
