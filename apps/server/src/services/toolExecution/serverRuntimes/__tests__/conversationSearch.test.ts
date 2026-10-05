import { ConversationSearchIdentifier } from '@lobechat/builtin-tool-conversation-search';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type ToolExecutionContext } from '../../types';

const mockSearch = vi.fn();
const mockCreateFtsSearchRepo = vi.fn();
const mockGetTopicContext = vi.fn();
const mockTopicReferenceService = vi.fn();

vi.mock('@/server/services/ftsSearch', () => ({
  createFtsSearchRepo: (...args: any[]) => mockCreateFtsSearchRepo(...args),
}));

vi.mock('@/server/services/topicReference', () => ({
  TopicReferenceService: vi.fn().mockImplementation(function (...args: any[]) {
    mockTopicReferenceService(...args);
    return { getTopicContext: (...params: any[]) => mockGetTopicContext(...params) };
  }),
}));

const { conversationSearchRuntime } = await import('../conversationSearch');

const baseContext: ToolExecutionContext = {
  agentId: 'agt_current',
  serverDB: {} as any,
  toolManifestMap: {},
  userId: 'user-1',
  workspaceId: 'ws-1',
};

describe('conversationSearchRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateFtsSearchRepo.mockResolvedValue({ search: mockSearch });
  });

  it('registers under the conversation search identifier', () => {
    expect(conversationSearchRuntime.identifier).toBe(ConversationSearchIdentifier);
    expect(conversationSearchRuntime.identifier).toBe('lobe-conversation-search');
  });

  it('requires serverDB and userId', () => {
    expect(() =>
      conversationSearchRuntime.factory({ toolManifestMap: {}, userId: 'user-1' }),
    ).toThrow('serverDB is required for ConversationSearch execution');
    expect(() =>
      conversationSearchRuntime.factory({ serverDB: {} as any, toolManifestMap: {} }),
    ).toThrow('userId is required for ConversationSearch execution');
  });

  it('scopes the repo to the run user / workspace and the search to the running agent', async () => {
    mockSearch.mockResolvedValue([
      {
        agent: { title: 'Kimi Code' },
        agentId: 'agt_current',
        id: 'tpc_1',
        title: 'Pulse pricing',
        type: 'topic',
        updatedAt: new Date('2026-09-15T00:00:00Z'),
      },
    ]);

    const runtime = conversationSearchRuntime.factory(baseContext);
    const result = await runtime.searchTopics({ limit: 3, query: '  pulse  ' });

    expect(mockCreateFtsSearchRepo).toHaveBeenCalledWith({
      db: baseContext.serverDB,
      usage: 'conversation_search_tool',
      userId: 'user-1',
      workspaceId: 'ws-1',
    });
    expect(mockSearch).toHaveBeenCalledWith({
      agentId: 'agt_current',
      limitPerType: 3,
      query: 'pulse',
      type: 'topic',
    });
    expect(result.success).toBe(true);
    expect(result.content).toContain('<topic id="tpc_1" title="Pulse pricing"');
  });

  it('drops the agent filter only for scope all', async () => {
    mockSearch.mockResolvedValue([]);
    const runtime = conversationSearchRuntime.factory(baseContext);

    await runtime.searchTopics({ query: 'pulse', scope: 'all' });

    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: undefined, type: 'topic' }),
    );
  });

  it('returns trimmed message snippets instead of full bodies', async () => {
    const body = `${'a'.repeat(19_000)} Railway 微服务 ${'b'.repeat(2000)}`;
    mockSearch.mockResolvedValue([
      {
        agentId: 'agt_current',
        content: body,
        id: 'msg_1',
        role: 'assistant',
        topicId: 'tpc_1',
        type: 'message',
        updatedAt: new Date('2026-09-15T00:00:00Z'),
      },
    ]);

    const runtime = conversationSearchRuntime.factory(baseContext);
    const result = await runtime.searchMessages({ limit: 2, query: 'Railway 微服务' });

    expect(mockSearch).toHaveBeenCalledWith({
      agentId: 'agt_current',
      limitPerType: 6,
      query: 'Railway 微服务',
      type: 'message',
    });
    expect(result.success).toBe(true);
    expect(result.content).toContain('topicId="tpc_1"');
    expect(result.content).toContain('Railway 微服务');
    expect(result.content.length).toBeLessThan(1000);
  });

  it('rejects an empty query without hitting the backend', async () => {
    const runtime = conversationSearchRuntime.factory(baseContext);
    const result = await runtime.searchMessages({ query: '   ' });

    expect(result).toEqual({ content: 'query is required', success: false });
    expect(mockCreateFtsSearchRepo).not.toHaveBeenCalled();
  });

  it('reports backend failures as a failed tool result', async () => {
    mockSearch.mockRejectedValue(new Error('pg_search unavailable'));
    const runtime = conversationSearchRuntime.factory(baseContext);
    const result = await runtime.searchTopics({ query: 'pulse' });

    expect(result.success).toBe(false);
    expect(result.content).toBe('Failed to search topics: pg_search unavailable');
  });

  it('reads a topic through the user-scoped topic reference service', async () => {
    mockGetTopicContext.mockResolvedValue({ content: 'summary', success: true });
    const runtime = conversationSearchRuntime.factory(baseContext);

    const result = await runtime.readTopic({ topicId: 'tpc_1' });

    expect(mockTopicReferenceService).toHaveBeenCalledWith(baseContext.serverDB, 'user-1', 'ws-1');
    expect(mockGetTopicContext).toHaveBeenCalledWith({ topicId: 'tpc_1' });
    expect(result).toEqual({ content: 'summary', success: true });
  });
});
