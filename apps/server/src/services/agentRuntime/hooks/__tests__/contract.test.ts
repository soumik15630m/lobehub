import type { SerializedAgentHook } from '@lobechat/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HookDispatcher } from '../HookDispatcher';
import { matchesHook } from '../matcher';
import type { AgentHook, AgentHookEvent } from '../types';

const { safeFetch, queueMode } = vi.hoisted(() => ({ safeFetch: vi.fn(), queueMode: vi.fn() }));
vi.mock('@lobechat/ssrf-safe-fetch', () => ({ ssrfSafeFetch: safeFetch }));
vi.mock('@/server/services/queue/impls', () => ({ isQueueAgentRuntimeEnabled: queueMode }));
vi.mock('@/libs/qstash', () => ({ OtelQstashClient: class {} }));

const event: AgentHookEvent = {
  operationId: 'op',
  userId: 'user',
  agentId: 'agent',
  status: 'done',
};
const hook: AgentHook = {
  id: 'notification',
  type: 'onComplete',
  webhook: { url: 'https://example.com/hooks' },
};

describe('hook registration and restoration', () => {
  beforeEach(() => {
    safeFetch.mockReset().mockImplementation(async () => new Response('{}'));
    queueMode.mockReturnValue(false);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it.each([false, true])('sends webhook-only hooks in queue=%s', async (queue) => {
    queueMode.mockReturnValue(queue);
    const dispatcher = new HookDispatcher();
    dispatcher.register('op', [hook]);
    await dispatcher.dispatch('op', 'onComplete', event);
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(safeFetch.mock.calls[0][1].body)).toMatchObject({
      operationId: 'op',
      hookId: 'notification',
    });
  });
  it.each([false, true])(
    'restores and validates notifications in a new worker queue=%s',
    async (queue) => {
      queueMode.mockReturnValue(queue);
      const dispatcher = new HookDispatcher();
      dispatcher.register('op', [hook]);
      const restored = new HookDispatcher();
      const persisted = JSON.stringify(dispatcher.getSerializedHooks('op'));
      await restored.dispatch('op', 'onComplete', event, JSON.parse(persisted));
      expect(safeFetch).toHaveBeenCalledTimes(1);
    },
  );
  it('rejects dual registrations atomically', () => {
    const dispatcher = new HookDispatcher();
    expect(() =>
      dispatcher.register('op', [
        hook,
        { ...hook, id: 'dual', handler: vi.fn() } as unknown as AgentHook,
      ]),
    ).toThrow(/exactly one/);
    expect(dispatcher.hasHooks('op')).toBe(false);
  });
  it.each([false, true])('executes an explicit handler independent of queue=%s', async (queue) => {
    queueMode.mockReturnValue(queue);
    const dispatcher = new HookDispatcher();
    const handler = vi.fn();
    dispatcher.register('op', [{ id: 'callback', type: 'onComplete', handler }]);
    expect(dispatcher.canDeliver('op', 'onComplete')).toBe(true);
    await dispatcher.dispatch('op', 'onComplete', event);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(safeFetch).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    'uses the durable webhook snapshot alongside process callbacks queue=%s',
    async (queue) => {
      queueMode.mockReturnValue(queue);
      const dispatcher = new HookDispatcher();
      const handler = vi.fn();
      dispatcher.register('op', [hook, { id: 'callback', type: 'onComplete', handler }]);
      const snapshot = [
        { ...hook, webhook: { url: 'https://example.com/durable' } },
      ] as SerializedAgentHook[];
      await dispatcher.dispatch('op', 'onComplete', event, snapshot);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(safeFetch).toHaveBeenCalledTimes(1);
      expect(safeFetch.mock.calls[0][0]).toBe('https://example.com/durable');
      expect(dispatcher.getContinuationHooks('op', snapshot)).toEqual([
        snapshot[0],
        { id: 'callback', type: 'onComplete', handler },
      ]);
    },
  );
  it('honors an explicitly empty durable webhook snapshot without dropping handlers', async () => {
    const dispatcher = new HookDispatcher();
    const handler = vi.fn();
    dispatcher.register('op', [hook, { id: 'callback', type: 'onComplete', handler }]);
    await dispatcher.dispatch('op', 'onComplete', event, []);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(safeFetch).not.toHaveBeenCalled();
  });
  it('rejects conflicting callback and durable webhook ids before side effects', async () => {
    const dispatcher = new HookDispatcher();
    const handler = vi.fn();
    dispatcher.register('op', [{ id: hook.id, type: 'onComplete', handler }]);
    await expect(
      dispatcher.dispatch('op', 'onComplete', event, [hook as SerializedAgentHook]),
    ).rejects.toThrow(/Duplicate hook id/);
    expect(handler).not.toHaveBeenCalled();
    expect(safeFetch).not.toHaveBeenCalled();
  });
  it('restores controls from the durable list even when a worker has its own callback', async () => {
    const dispatcher = new HookDispatcher();
    dispatcher.register('op', [{ id: 'worker', type: 'onComplete', handler: vi.fn() }]);
    safeFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: 'beforeToolCall', permissionDecision: 'deny' },
        }),
      ),
    );
    const snapshot: SerializedAgentHook[] = [
      {
        id: 'control',
        type: 'beforeToolCall',
        webhook: { url: 'https://example.com/control', responseHandling: 'toolCall' },
      },
    ];
    const decision = await dispatcher.prepareToolCall(
      'op',
      {
        operationId: 'op',
        apiName: 'write',
        identifier: 'fs',
        args: {},
        callIndex: 0,
        stepIndex: 0,
      },
      snapshot,
    );
    expect(decision.status).toBe('blocked');
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(dispatcher.getContinuationHooks('op', snapshot, false)).toEqual(snapshot);
  });

  it('retains matcher and fallback:none through serialization', () => {
    const dispatcher = new HookDispatcher();
    const serialized = {
      id: 'tool',
      type: 'afterToolCall' as const,
      matcher: '^fs/',
      webhook: { url: '/hook', fallback: 'none' as const },
    };
    dispatcher.register('op', [serialized]);
    expect(dispatcher.getSerializedHooks('op')).toEqual([serialized]);
  });
  it('registers/restores controls but ordinary dispatch never delivers them', async () => {
    const dispatcher = new HookDispatcher();
    const control: AgentHook = {
      id: 'control',
      type: 'beforeToolCall',
      webhook: { url: '/hook', responseHandling: 'toolCall' },
    };
    dispatcher.register('op', [control]);
    expect(dispatcher.getSerializedHooks('op')).toEqual([control]);
    for (const queue of [false, true]) {
      queueMode.mockReturnValue(queue);
      await dispatcher.dispatch('op', 'beforeToolCall', event, [control as SerializedAgentHook]);
    }
    expect(safeFetch).not.toHaveBeenCalled();
  });
  it.each([
    { id: 'empty', type: 'onComplete' },
    { ...hook, handler: 'not a function' },
    { ...hook, matcher: '' },
    { ...hook, matcher: '*' },
    { ...hook, type: 'beforeToolCall', matcher: { identifier: '^fs$' } },
    { ...hook, type: 'beforeToolCall', matcher: '[' },
    {
      ...hook,
      type: 'beforeToolCall',
      handler: async () => {},
      webhook: { url: '/hook', responseHandling: 'toolCall' },
    },
  ])('rejects invalid registration %#', (invalid) => {
    expect(() => new HookDispatcher().register('op', [invalid as AgentHook])).toThrow();
  });
  it('rejects corrupt restored configurations instead of stripping controls', async () => {
    await expect(
      new HookDispatcher().dispatch('op', 'onComplete', event, [
        {
          ...hook,
          webhook: { url: '/hook', responseHandling: 'futureControl' },
        } as unknown as SerializedAgentHook,
      ]),
    ).rejects.toThrow();
  });
  it('matches a restored queue webhook against the combined tool name', async () => {
    queueMode.mockReturnValue(true);
    const dispatcher = new HookDispatcher();
    const stored: SerializedAgentHook[] = [
      {
        id: 'tool',
        type: 'beforeToolCall',
        matcher: '^fs/readFile$',
        webhook: { url: 'https://example.com/hook' },
      },
    ];
    const tool = {
      apiName: 'readFile',
      args: {},
      callIndex: 0,
      identifier: 'other',
      operationId: 'op',
      stepIndex: 0,
    };
    await dispatcher.dispatch('op', 'beforeToolCall', tool, stored);
    expect(safeFetch).not.toHaveBeenCalled();
    await dispatcher.dispatch('op', 'beforeToolCall', { ...tool, identifier: 'fs' }, stored);
    expect(safeFetch).toHaveBeenCalledTimes(1);
    await expect(
      dispatcher.dispatch('op', 'beforeToolCall', tool, [{ ...stored[0], matcher: '[' }]),
    ).rejects.toThrow();
  });
  it('matches local handlers, HTTP notifications and mock callbacks', async () => {
    const dispatcher = new HookDispatcher();
    const handler = vi.fn();
    dispatcher.register('op', [
      {
        id: 'mock',
        type: 'beforeToolCall',
        matcher: '^fs/read',
        handler,
      },
      { ...hook, type: 'beforeToolCall', matcher: '^fs/' },
    ]);
    const tool = { apiName: 'readFile', args: {}, callIndex: 0, identifier: 'other', stepIndex: 0 };
    await dispatcher.dispatchBeforeToolCall('op', tool);
    await dispatcher.dispatch('op', 'beforeToolCall', { ...tool, operationId: 'op' });
    expect(handler).not.toHaveBeenCalled();
    expect(safeFetch).not.toHaveBeenCalled();
    await dispatcher.dispatch('op', 'beforeToolCall', {
      ...tool,
      identifier: 'fs',
      operationId: 'op',
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(safeFetch).toHaveBeenCalledTimes(1);
  });
});

describe('matcher semantics', () => {
  it.each([undefined, '', '*'])('matches wildcard %#', (matcher) => {
    expect(matchesHook(matcher, { identifier: 'any', apiName: 'any' })).toBe(true);
  });
  it('matches the combined tool name and never retains regex state', () => {
    const matcher = '^fs/read';
    for (let i = 0; i < 3; i++)
      expect(matchesHook(matcher, { identifier: 'fs', apiName: 'readFile' })).toBe(true);
    expect(matchesHook(matcher, { identifier: 'fs', apiName: 'writeFile' })).toBe(false);
    expect(matchesHook(matcher, { identifier: 'http', apiName: 'readFile' })).toBe(false);
    expect(matchesHook(matcher, {})).toBe(false);
  });
  it('supports alternation across the combined identifier/apiName boundary', () => {
    const matcher = '^(fs/readFile|http/get)$';
    expect(matchesHook(matcher, { identifier: 'fs', apiName: 'readFile' })).toBe(true);
    expect(matchesHook(matcher, { identifier: 'http', apiName: 'get' })).toBe(true);
    expect(matchesHook(matcher, { identifier: 'fs', apiName: 'get' })).toBe(false);
    expect(matchesHook(matcher, { identifier: 'http', apiName: 'readFile' })).toBe(false);
    expect(matchesHook('undefined/readFile', { apiName: 'readFile' })).toBe(false);
  });
});

describe('registration snapshots', () => {
  it('snapshots the matcher value and webhook configuration', async () => {
    queueMode.mockReturnValue(false);
    safeFetch.mockReset().mockImplementation(async () => new Response('{}'));
    const dispatcher = new HookDispatcher();
    const source: AgentHook = {
      id: 'snapshot',
      type: 'beforeToolCall',
      matcher: '^fs/',
      webhook: { url: 'https://example.com/original', headers: { 'X-Version': 'original' } },
    };
    dispatcher.register('op', [source]);
    source.matcher = '^other/';
    source.webhook!.url = 'https://example.com/changed';
    source.webhook!.headers!['X-Version'] = 'changed';
    await dispatcher.dispatch('op', 'beforeToolCall', {
      apiName: 'read',
      args: {},
      callIndex: 0,
      identifier: 'fs',
      operationId: 'op',
      stepIndex: 0,
    });
    expect(safeFetch.mock.calls[0][0]).toBe('https://example.com/original');
    expect(safeFetch.mock.calls[0][1].headers['x-version']).toBe('original');
  });
});
