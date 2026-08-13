import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildCodexAppServerArgs,
  buildCodexAppServerInput,
  buildCodexAppServerThreadParams,
  CodexAppServerSession,
  getCodexAppServerUnsupportedArgs,
} from './codexAppServerSession';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, spawn: spawnMock };
});

interface RpcMessage {
  error?: unknown;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
}

const createAppServerProcess = ({ autoComplete = true, requestApproval = false } = {}) => {
  const child = new EventEmitter() as any;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const requests: RpcMessage[] = [];

  const send = (message: Record<string, unknown>) => {
    stdout.write(`${JSON.stringify(message)}\n`);
  };

  child.pid = 987_654;
  child.killed = false;
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  child.stdin = {
    on: vi.fn(),
    write: vi.fn((chunk: string) => {
      const message = JSON.parse(chunk.trim()) as RpcMessage;
      requests.push(message);

      queueMicrotask(() => {
        switch (message.method) {
          case 'initialize': {
            send({ id: message.id, result: { userAgent: 'codex-test' } });
            return;
          }
          case 'thread/start':
          case 'thread/resume': {
            send({
              id: message.id,
              result: { model: 'gpt-5.5-codex', thread: { id: 'thread-1' } },
            });
            return;
          }
          case 'turn/start': {
            send({ id: message.id, result: { turn: { id: 'turn-1' } } });
            if (requestApproval) {
              send({
                id: 'approval-1',
                method: 'item/commandExecution/requestApproval',
                params: {
                  command: 'pwd',
                  itemId: 'command-1',
                  threadId: 'thread-1',
                  turnId: 'turn-1',
                },
              });
            }
            send({
              method: 'turn/started',
              params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'inProgress' } },
            });
            if (!autoComplete) return;
            send({
              method: 'item/started',
              params: {
                item: {
                  aggregatedOutput: null,
                  command: 'pwd',
                  exitCode: null,
                  id: 'command-1',
                  status: 'inProgress',
                  type: 'commandExecution',
                },
                threadId: 'thread-1',
                turnId: 'turn-1',
              },
            });
            send({
              method: 'item/commandExecution/outputDelta',
              params: {
                delta: '/work',
                itemId: 'command-1',
                threadId: 'thread-1',
                turnId: 'turn-1',
              },
            });
            send({
              method: 'item/commandExecution/outputDelta',
              params: {
                delta: 'space\n',
                itemId: 'command-1',
                threadId: 'thread-1',
                turnId: 'turn-1',
              },
            });
            send({
              method: 'item/completed',
              params: {
                item: {
                  aggregatedOutput: '/workspace\n',
                  command: 'pwd',
                  exitCode: 0,
                  id: 'command-1',
                  status: 'completed',
                  type: 'commandExecution',
                },
                threadId: 'thread-1',
                turnId: 'turn-1',
              },
            });
            send({
              method: 'turn/plan/updated',
              params: {
                explanation: null,
                plan: [
                  { status: 'completed', step: 'Inspect' },
                  { status: 'inProgress', step: 'Implement' },
                ],
                threadId: 'thread-1',
                turnId: 'turn-1',
              },
            });
            send({
              method: 'item/started',
              params: {
                item: {
                  changes: [],
                  id: 'file-1',
                  status: 'inProgress',
                  type: 'fileChange',
                },
                threadId: 'thread-1',
                turnId: 'turn-1',
              },
            });
            send({
              method: 'turn/diff/updated',
              params: {
                diff: '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
                threadId: 'thread-1',
                turnId: 'turn-1',
              },
            });
            send({
              method: 'item/completed',
              params: {
                item: {
                  changes: [
                    {
                      diff: '@@ -1 +1 @@\n-old\n+new\n',
                      kind: { type: 'update' },
                      path: 'a.ts',
                    },
                  ],
                  id: 'file-1',
                  status: 'completed',
                  type: 'fileChange',
                },
                threadId: 'thread-1',
                turnId: 'turn-1',
              },
            });
            send({
              method: 'item/agentMessage/delta',
              params: {
                delta: 'hello ',
                itemId: 'message-1',
                threadId: 'thread-1',
                turnId: 'turn-1',
              },
            });
            send({
              method: 'item/agentMessage/delta',
              params: {
                delta: 'world',
                itemId: 'message-1',
                threadId: 'thread-1',
                turnId: 'turn-1',
              },
            });
            send({
              method: 'item/completed',
              params: {
                item: {
                  id: 'message-1',
                  text: 'hello world',
                  type: 'agentMessage',
                },
                threadId: 'thread-1',
                turnId: 'turn-1',
              },
            });
            send({
              method: 'thread/tokenUsage/updated',
              params: {
                threadId: 'thread-1',
                tokenUsage: {
                  total: {
                    cachedInputTokens: 2,
                    inputTokens: 10,
                    outputTokens: 4,
                    reasoningOutputTokens: 1,
                    totalTokens: 14,
                  },
                },
                turnId: 'turn-1',
              },
            });
            send({
              method: 'turn/completed',
              params: {
                threadId: 'thread-1',
                turn: { id: 'turn-1', status: 'completed' },
              },
            });
            return;
          }
          case 'turn/interrupt': {
            send({ id: message.id, result: {} });
            send({
              method: 'turn/completed',
              params: {
                threadId: 'thread-1',
                turn: { id: 'turn-1', status: 'interrupted' },
              },
            });
          }
        }
      });
      return true;
    }),
  };

  return { child, requests, send };
};

afterEach(() => {
  vi.restoreAllMocks();
  spawnMock.mockReset();
});

describe('CodexAppServerSession', () => {
  it('maps app-server notifications through the existing Codex event pipeline', async () => {
    const { child, requests } = createAppServerProcess();
    spawnMock.mockReturnValue(child);
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    const events: any[] = [];
    const statuses: any[] = [];
    const sessionIds: string[] = [];

    const session = new CodexAppServerSession({
      args: [
        '--model',
        'gpt-5.5-codex',
        '--cd',
        'nested',
        '--ephemeral',
        '-c',
        'model_reasoning_effort="high"',
      ],
      clientVersion: '1.0.0',
      commandPath: 'codex',
      cwd: '/workspace',
      env: process.env,
      input: [{ text: 'hello', text_elements: [], type: 'text' }],
      onEvents: (batch) => {
        events.push(...batch);
      },
      onRawMessage: vi.fn(),
      onRuntimeStatus: (status) => statuses.push(status),
      onSessionId: (sessionId) => sessionIds.push(sessionId),
      onStderr: vi.fn(),
      operationId: 'operation-1',
      sessionId: 'session-1',
    });

    await session.run();

    expect(spawnMock).toHaveBeenCalledWith(
      'codex',
      ['-c', 'model_reasoning_effort="high"', 'app-server'],
      expect.objectContaining({ cwd: '/workspace', stdio: ['pipe', 'pipe', 'pipe'] }),
    );
    expect(requests.map(({ method }) => method).filter(Boolean)).toEqual([
      'initialize',
      'initialized',
      'thread/start',
      'turn/start',
    ]);
    expect(requests).toContainEqual({
      id: expect.any(Number),
      method: 'initialize',
      params: {
        capabilities: { experimentalApi: true },
        clientInfo: {
          name: 'lobehub-desktop',
          title: 'LobeHub Desktop',
          version: '1.0.0',
        },
      },
    });
    expect(requests).toContainEqual({
      id: expect.any(Number),
      method: 'thread/start',
      params: {
        approvalPolicy: 'never',
        cwd: '/workspace/nested',
        ephemeral: true,
        model: 'gpt-5.5-codex',
        sandbox: 'danger-full-access',
      },
    });
    expect(sessionIds).toEqual([]);
    expect(
      events
        .filter((event) => event.type === 'stream_chunk' && event.data?.chunkType === 'text')
        .map((event) => event.data.content),
    ).toEqual(['hello ', 'world']);
    expect(events.some((event) => event.type === 'tool_start')).toBe(true);
    expect(events.some((event) => event.type === 'tool_result')).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === 'stream_chunk' &&
          event.data?.chunkType === 'tool_state' &&
          event.data?.pluginState?.stdout === '/workspace\n',
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === 'tool_result' && event.data?.pluginState?.changes?.[0]?.kind === 'update',
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === 'stream_chunk' &&
          event.data?.pluginState?.todos?.items?.[1]?.text === 'Implement',
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === 'stream_chunk' &&
          event.data?.pluginState?.changes?.[0]?.diffText?.includes('+++ b/a.ts'),
      ),
    ).toBe(true);
    expect(events.some((event) => event.type === 'agent_runtime_end')).toBe(true);
    expect(
      events.some(
        (event) => event.type === 'step_complete' && event.data?.usage?.totalTokens === 14,
      ),
    ).toBe(true);
    expect(statuses.map(({ state }) => state)).toEqual(['starting', 'running', 'idle', 'closed']);
    expect(statuses.every(({ transport }) => transport === 'codex-app-server')).toBe(true);
  });

  it('interrupts an active turn through RPC instead of killing the process', async () => {
    const { child, requests } = createAppServerProcess({ autoComplete: false });
    spawnMock.mockReturnValue(child);
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    const events: any[] = [];
    const statuses: any[] = [];
    const session = new CodexAppServerSession({
      args: [],
      clientVersion: '1.0.0',
      commandPath: 'codex',
      cwd: '/workspace',
      env: process.env,
      input: [{ text: 'wait', text_elements: [], type: 'text' }],
      onEvents: (batch) => {
        events.push(...batch);
      },
      onRawMessage: vi.fn(),
      onRuntimeStatus: (status) => statuses.push(status),
      onSessionId: vi.fn(),
      onStderr: vi.fn(),
      operationId: 'operation-1',
      sessionId: 'session-1',
    });

    const run = session.run();
    await vi.waitFor(() => expect(statuses.some(({ state }) => state === 'running')).toBe(true));
    await session.interrupt();
    await run;

    expect(requests).toContainEqual({
      id: expect.any(Number),
      method: 'turn/interrupt',
      params: { threadId: 'thread-1', turnId: 'turn-1' },
    });
    expect(child.kill).not.toHaveBeenCalled();
    expect(events).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({ reason: 'interrupted' }),
        type: 'agent_runtime_end',
      }),
    );
  });

  it('surfaces a process exit that races between thread setup and turn start', async () => {
    const { child } = createAppServerProcess({ autoComplete: false });
    spawnMock.mockReturnValue(child);
    vi.spyOn(process, 'kill').mockImplementation(() => true);

    const session = new CodexAppServerSession({
      args: [],
      clientVersion: '1.0.0',
      commandPath: 'codex',
      cwd: '/workspace',
      env: process.env,
      input: [{ text: 'hello', text_elements: [], type: 'text' }],
      onEvents: vi.fn(),
      onRawMessage: vi.fn(),
      onRuntimeStatus: vi.fn(),
      onSessionId: () => child.emit('exit', 1, null),
      onStderr: vi.fn(),
      operationId: 'operation-1',
      sessionId: 'session-1',
    });

    await expect(session.run()).rejects.toThrow(
      'Codex app-server exited before the turn completed (code 1, signal null)',
    );
  });

  it('resumes a non-interactive thread and cancels unexpected approval requests', async () => {
    const { child, requests } = createAppServerProcess({ requestApproval: true });
    spawnMock.mockReturnValue(child);
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    const onSessionId = vi.fn();

    const session = new CodexAppServerSession({
      args: ['-s', 'read-only', '-a', 'never'],
      clientVersion: '1.0.0',
      commandPath: 'codex',
      cwd: '/workspace',
      env: process.env,
      input: [{ text: 'continue', text_elements: [], type: 'text' }],
      onEvents: vi.fn(),
      onRawMessage: vi.fn(),
      onRuntimeStatus: vi.fn(),
      onSessionId,
      onStderr: vi.fn(),
      operationId: 'operation-1',
      resumeSessionId: 'thread-existing',
      sessionId: 'session-1',
    });

    await session.run();

    expect(requests).toContainEqual({
      id: expect.any(Number),
      method: 'thread/resume',
      params: {
        approvalPolicy: 'never',
        cwd: '/workspace',
        sandbox: 'read-only',
        threadId: 'thread-existing',
      },
    });
    expect(requests).toContainEqual({ id: 'approval-1', result: { decision: 'decline' } });
    expect(onSessionId).toHaveBeenCalledWith('thread-1');
  });

  it('maps reasoning, plan, progress, patch, retry, diagnostics, and final-item fallbacks', async () => {
    const { child, send } = createAppServerProcess({ autoComplete: false });
    spawnMock.mockReturnValue(child);
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    const events: any[] = [];
    const statuses: any[] = [];
    const onStderr = vi.fn();
    const session = new CodexAppServerSession({
      args: [],
      clientVersion: '1.0.0',
      commandPath: 'codex',
      cwd: '/workspace',
      env: process.env,
      input: [{ text: 'hello', text_elements: [], type: 'text' }],
      onEvents: (batch) => {
        events.push(...batch);
      },
      onRawMessage: vi.fn(),
      onRuntimeStatus: (status) => statuses.push(status),
      onSessionId: vi.fn(),
      onStderr,
      operationId: 'operation-1',
      sessionId: 'session-1',
    });

    const run = session.run();
    await vi.waitFor(() => expect(statuses.some(({ state }) => state === 'running')).toBe(true));
    const scope = { threadId: 'thread-1', turnId: 'turn-1' };
    send({
      method: 'item/started',
      params: {
        ...scope,
        item: { content: [], id: 'reasoning-1', summary: [], type: 'reasoning' },
      },
    });
    send({
      method: 'item/reasoning/summaryTextDelta',
      params: { ...scope, delta: 'Inspecting', itemId: 'reasoning-1', summaryIndex: 0 },
    });
    send({
      method: 'item/reasoning/summaryPartAdded',
      params: { ...scope, itemId: 'reasoning-1', summaryIndex: 1 },
    });
    send({
      method: 'item/reasoning/summaryTextDelta',
      params: { ...scope, delta: 'Deciding', itemId: 'reasoning-1', summaryIndex: 1 },
    });
    send({
      method: 'item/reasoning/textDelta',
      params: { ...scope, contentIndex: 0, delta: 'private raw', itemId: 'reasoning-1' },
    });
    send({
      method: 'item/completed',
      params: {
        ...scope,
        item: {
          content: ['private raw'],
          id: 'reasoning-1',
          summary: ['Inspecting', 'Deciding'],
          type: 'reasoning',
        },
      },
    });
    send({
      method: 'item/plan/delta',
      params: { ...scope, delta: '# ', itemId: 'plan-1' },
    });
    send({
      method: 'item/plan/delta',
      params: { ...scope, delta: 'Plan', itemId: 'plan-1' },
    });
    send({
      method: 'item/completed',
      params: { ...scope, item: { id: 'plan-1', text: '# Plan', type: 'plan' } },
    });
    send({
      method: 'item/started',
      params: {
        ...scope,
        item: {
          aggregatedOutput: null,
          command: 'cat',
          commandActions: [],
          cwd: '/workspace',
          durationMs: null,
          exitCode: null,
          id: 'command-1',
          pluginId: null,
          processId: 'process-1',
          scriptPath: null,
          source: 'agent',
          status: 'inProgress',
          type: 'commandExecution',
        },
      },
    });
    send({
      method: 'item/commandExecution/terminalInteraction',
      params: { ...scope, itemId: 'command-1', processId: 'process-1', stdin: 'yes\n' },
    });
    send({
      method: 'item/started',
      params: {
        ...scope,
        item: {
          appContext: null,
          arguments: {},
          durationMs: null,
          error: null,
          id: 'mcp-1',
          pluginId: null,
          readOnlyHint: true,
          result: null,
          server: 'apps',
          status: 'inProgress',
          tool: 'read',
          type: 'mcpToolCall',
        },
      },
    });
    send({
      method: 'item/mcpToolCall/progress',
      params: { ...scope, itemId: 'mcp-1', message: 'Loading issue' },
    });
    send({
      method: 'item/started',
      params: {
        ...scope,
        item: { changes: [], id: 'file-1', status: 'inProgress', type: 'fileChange' },
      },
    });
    send({
      method: 'item/fileChange/patchUpdated',
      params: {
        ...scope,
        changes: [{ diff: '+new', kind: { type: 'add' }, path: 'new.ts' }],
        itemId: 'file-1',
      },
    });
    send({
      method: 'error',
      params: { ...scope, error: { message: 'connection reset' }, willRetry: true },
    });
    send({ method: 'warning', params: { ...scope, message: 'Using fallback config' } });
    send({
      method: 'item/completed',
      params: {
        ...scope,
        item: { clientId: 'desktop', content: [], id: 'user-1', type: 'userMessage' },
      },
    });
    send({
      method: 'item/completed',
      params: {
        ...scope,
        item: { fragments: [], id: 'hook-1', type: 'hookPrompt' },
      },
    });
    send({ method: 'account/updated', params: { account: null } });
    send({ method: 'future/notification', params: scope });
    send({
      method: 'item/completed',
      params: { ...scope, item: { id: 'future-1', type: 'futureItem' } },
    });
    send({
      method: 'item/started',
      params: {
        ...scope,
        item: {
          agentsStates: {},
          id: 'spawn-1',
          model: 'gpt-5.5-codex',
          prompt: 'Inspect the child task',
          reasoningEffort: 'medium',
          receiverThreadIds: [],
          senderThreadId: 'thread-1',
          status: 'inProgress',
          tool: 'spawnAgent',
          type: 'collabAgentToolCall',
        },
      },
    });
    send({
      method: 'item/completed',
      params: {
        ...scope,
        item: {
          agentPath: '/root/worker',
          agentThreadId: 'child-thread-1',
          id: 'spawn-1',
          kind: 'started',
          type: 'subAgentActivity',
        },
      },
    });
    send({
      method: 'turn/started',
      params: {
        threadId: 'child-thread-1',
        turn: { id: 'child-turn-1', status: 'inProgress' },
      },
    });
    send({
      method: 'item/agentMessage/delta',
      params: {
        delta: 'Child result',
        itemId: 'child-message-1',
        threadId: 'child-thread-1',
        turnId: 'child-turn-1',
      },
    });
    send({
      method: 'item/completed',
      params: {
        item: {
          id: 'child-message-1',
          memoryCitation: null,
          phase: 'final_answer',
          text: 'Child result',
          type: 'agentMessage',
        },
        threadId: 'child-thread-1',
        turnId: 'child-turn-1',
      },
    });
    send({
      method: 'model/rerouted',
      params: {
        fromModel: 'gpt-5.5-codex',
        reason: 'highRiskCyberActivity',
        threadId: 'child-thread-1',
        toModel: 'gpt-5.5-codex-safe',
        turnId: 'child-turn-1',
      },
    });
    send({
      method: 'turn/plan/updated',
      params: {
        explanation: null,
        plan: [{ status: 'inProgress', step: 'Inspect child files' }],
        threadId: 'child-thread-1',
        turnId: 'child-turn-1',
      },
    });
    send({
      method: 'item/started',
      params: {
        item: {
          changes: [],
          id: 'child-file-1',
          status: 'inProgress',
          type: 'fileChange',
        },
        threadId: 'child-thread-1',
        turnId: 'child-turn-1',
      },
    });
    send({
      method: 'turn/diff/updated',
      params: {
        diff: '--- a/child.ts\n+++ b/child.ts\n',
        threadId: 'child-thread-1',
        turnId: 'child-turn-1',
      },
    });
    send({
      method: 'item/fileChange/outputDelta',
      params: {
        delta: '+legacy child delta',
        itemId: 'child-file-1',
        threadId: 'child-thread-1',
        turnId: 'child-turn-1',
      },
    });
    send({
      method: 'item/completed',
      params: {
        item: {
          changes: [{ diff: '+done', kind: { type: 'update' }, path: 'child.ts' }],
          id: 'child-file-1',
          status: 'completed',
          type: 'fileChange',
        },
        threadId: 'child-thread-1',
        turnId: 'child-turn-1',
      },
    });
    send({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'child-thread-1',
        tokenUsage: { total: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } },
        turnId: 'child-turn-1',
      },
    });
    send({
      method: 'turn/completed',
      params: {
        threadId: 'child-thread-1',
        turn: { id: 'child-turn-1', status: 'completed' },
      },
    });
    send({
      method: 'turn/started',
      params: {
        threadId: 'child-thread-1',
        turn: { id: 'child-turn-2', status: 'inProgress' },
      },
    });
    send({
      method: 'item/agentMessage/delta',
      params: {
        delta: 'Follow-up',
        itemId: 'child-message-2',
        threadId: 'child-thread-1',
        turnId: 'child-turn-2',
      },
    });
    send({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'child-thread-1',
        tokenUsage: { total: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } },
        turnId: 'child-turn-2',
      },
    });
    send({
      method: 'turn/completed',
      params: {
        threadId: 'child-thread-1',
        turn: { id: 'child-turn-2', status: 'completed' },
      },
    });
    send({
      method: 'item/completed',
      params: {
        ...scope,
        item: {
          agentsStates: { 'child-thread-1': { message: null, status: 'completed' } },
          id: 'spawn-1',
          model: 'gpt-5.5-codex',
          prompt: 'Inspect the child task',
          reasoningEffort: 'medium',
          receiverThreadIds: ['child-thread-1'],
          senderThreadId: 'thread-1',
          status: 'completed',
          tool: 'spawnAgent',
          type: 'collabAgentToolCall',
        },
      },
    });
    send({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-1',
          items: [
            {
              id: 'final-message',
              memoryCitation: null,
              phase: 'final_answer',
              text: 'Fallback final',
              type: 'agentMessage',
            },
          ],
          status: 'completed',
        },
      },
    });
    await run;

    expect(
      events
        .filter(
          (event) =>
            event.type === 'stream_chunk' &&
            event.data?.chunkType === 'reasoning' &&
            !event.data?.subagent,
        )
        .map((event) => event.data.reasoning),
    ).toEqual(['Inspecting', '\n\n', 'Deciding']);
    expect(
      events
        .filter(
          (event) =>
            event.type === 'stream_chunk' &&
            event.data?.chunkType === 'text' &&
            !event.data?.subagent,
        )
        .map((event) => event.data.content),
    ).toEqual(['# ', '# Plan', 'Fallback final']);
    expect(events).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          chunkType: 'text',
          content: 'Child result',
          subagent: {
            parentToolCallId: 'spawn-1',
            spawnMetadata: {
              description: 'worker',
              prompt: 'Inspect the child task',
              subagentType: 'gpt-5.5-codex',
            },
            subagentMessageId: 'child-turn-1',
          },
        }),
        type: 'stream_chunk',
      }),
    );
    expect(
      events.some(
        (event) =>
          event.data?.subagent?.parentToolCallId === 'spawn-1' &&
          event.data?.pluginState?.changes?.[0]?.diffText === '--- a/child.ts\n+++ b/child.ts\n',
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.data?.subagent?.parentToolCallId === 'spawn-1' &&
          event.data?.pluginState?.changes?.[0]?.diffText === '+legacy child delta',
      ),
    ).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          model: 'gpt-5.5-codex-safe',
          subagent: expect.objectContaining({ parentToolCallId: 'spawn-1' }),
        }),
        type: 'step_complete',
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          subagent: expect.objectContaining({ parentToolCallId: 'spawn-1' }),
          toolCallId: 'turn-plan-child-turn-1',
        }),
        type: 'tool_result',
      }),
    );
    expect(
      events
        .filter(
          (event) =>
            event.type === 'step_complete' &&
            event.data?.subagent?.parentToolCallId === 'spawn-1' &&
            event.data?.usage,
        )
        .map((event) => event.data.usage?.totalTokens),
    ).toEqual([6, 4]);
    const parentSpawnResultIndex = events.findIndex(
      (event) => event.type === 'tool_result' && event.data?.toolCallId === 'spawn-1',
    );
    const childChunkIndex = events.findIndex(
      (event) =>
        event.type === 'stream_chunk' && event.data?.subagent?.parentToolCallId === 'spawn-1',
    );
    expect(parentSpawnResultIndex).toBeGreaterThan(-1);
    expect(childChunkIndex).toBeGreaterThan(parentSpawnResultIndex);
    expect(events).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({ message: 'connection reset' }),
        type: 'stream_retry',
      }),
    );
    expect(
      events.some(
        (event) => event.data?.pluginState?.terminalInteractions?.[0]?.processId === 'process-1',
      ),
    ).toBe(true);
    expect(events.some((event) => event.data?.pluginState?.progress === 'Loading issue')).toBe(
      true,
    );
    expect(events.some((event) => event.data?.pluginState?.changes?.[0]?.path === 'new.ts')).toBe(
      true,
    );
    expect(onStderr).toHaveBeenCalledWith(expect.stringContaining('raw reasoning is omitted'));
    expect(onStderr).toHaveBeenCalledWith(
      expect.stringContaining('warning: Using fallback config'),
    );
    expect(onStderr).toHaveBeenCalledWith(
      expect.stringContaining('item acknowledged without an exec JSON equivalent: userMessage'),
    );
    expect(onStderr).toHaveBeenCalledWith(
      expect.stringContaining('item acknowledged without an exec JSON equivalent: hookPrompt'),
    );
    expect(onStderr).toHaveBeenCalledWith(
      expect.stringContaining('acknowledged without an exec JSON equivalent: account/updated'),
    );
    expect(onStderr).toHaveBeenCalledWith(
      expect.stringContaining('Unknown Codex app-server notification: future/notification'),
    );
    expect(onStderr).toHaveBeenCalledWith(expect.stringContaining('futureItem'));
  });

  it('round-trips user-input and MCP form server requests through interventions', async () => {
    const { child, requests, send } = createAppServerProcess({ autoComplete: false });
    spawnMock.mockReturnValue(child);
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    const statuses: any[] = [];
    const invalidAnswers: Record<string, string> = {
      invalidBoolean: 'yes',
      invalidEnum: 'Other',
      invalidInteger: 'not-a-number',
      invalidLength: 'x',
    };
    const onIntervention = vi.fn(async ({ arguments: { questions } }) => ({
      result:
        questions[0].id === 'scope'
          ? { __freeform__: 'Do everything', scope: 'All' }
          : invalidAnswers[questions[0].id]
            ? { [questions[0].id]: invalidAnswers[questions[0].id] }
            : {
                cache: 'true',
                name: 'Lobe',
                scope: 'All files',
                tags: ['Source', 'Tests'],
              },
    }));
    const session = new CodexAppServerSession({
      args: [],
      clientVersion: '1.0.0',
      commandPath: 'codex',
      cwd: '/workspace',
      env: process.env,
      input: [{ text: 'hello', text_elements: [], type: 'text' }],
      onEvents: vi.fn(),
      onIntervention,
      onRawMessage: vi.fn(),
      onRuntimeStatus: (status) => statuses.push(status),
      onSessionId: vi.fn(),
      onStderr: vi.fn(),
      operationId: 'operation-1',
      sessionId: 'session-1',
    });

    const run = session.run();
    await vi.waitFor(() => expect(statuses.some(({ state }) => state === 'running')).toBe(true));
    send({
      id: 'input-1',
      method: 'item/tool/requestUserInput',
      params: {
        autoResolutionMs: null,
        isBlocking: true,
        itemId: 'ask-1',
        questions: [
          {
            header: 'Scope',
            id: 'scope',
            isOther: true,
            isSecret: false,
            options: [
              { description: 'Everything', label: 'All' },
              { description: 'Only this file', label: 'File' },
            ],
            question: 'Choose scope',
          },
          {
            header: 'Target',
            id: 'target',
            isOther: false,
            isSecret: false,
            options: [{ description: 'Current file', label: 'File' }],
            question: 'Choose scope',
          },
        ],
        threadId: 'thread-1',
        turnId: 'turn-1',
      },
    });
    await vi.waitFor(() =>
      expect(requests).toContainEqual({
        id: 'input-1',
        result: {
          answers: { scope: { answers: ['All'] }, target: { answers: [] } },
        },
      }),
    );
    send({
      id: 'elicitation-1',
      method: 'mcpServer/elicitation/request',
      params: {
        _meta: null,
        message: 'Configure connector',
        mode: 'form',
        requestedSchema: {
          properties: {
            cache: { description: 'Enable cache', type: 'boolean' },
            name: { title: 'Name', type: 'string' },
            scope: {
              description: 'Choose deployment scope',
              oneOf: [
                { const: 'all', title: 'All files' },
                { const: 'changed', title: 'Changed files' },
              ],
              type: 'string',
            },
            tags: {
              description: 'Pick labels',
              items: {
                anyOf: [
                  { const: 'src', title: 'Source' },
                  { const: 'test', title: 'Tests' },
                ],
                type: 'string',
              },
              type: 'array',
            },
          },
          required: ['name'],
          type: 'object',
        },
        serverName: 'connector',
        threadId: 'thread-1',
        turnId: 'turn-1',
      },
    });
    await vi.waitFor(() =>
      expect(requests).toContainEqual({
        id: 'elicitation-1',
        result: {
          _meta: null,
          action: 'accept',
          content: { cache: true, name: 'Lobe', scope: 'all', tags: ['src', 'test'] },
        },
      }),
    );
    for (const [id, fieldSchema] of Object.entries({
      invalidBoolean: { type: 'boolean' },
      invalidEnum: { enum: ['First', 'Second'], type: 'string' },
      invalidInteger: { type: 'integer' },
      invalidLength: { minLength: 2, type: 'string' },
    })) {
      send({
        id,
        method: 'mcpServer/elicitation/request',
        params: {
          message: 'Invalid value test',
          mode: 'form',
          requestedSchema: {
            properties: { [id]: fieldSchema },
            required: [id],
            type: 'object',
          },
          serverName: 'connector',
          threadId: 'thread-1',
          turnId: 'turn-1',
        },
      });
      await vi.waitFor(() =>
        expect(requests).toContainEqual({
          error: {
            code: -32_000,
            message: expect.stringContaining(
              id === 'invalidLength'
                ? 'Invalid MCP elicitation response'
                : `Invalid MCP elicitation value for '${id}'`,
            ),
          },
          id,
        }),
      );
    }
    send({
      id: 'permissions-1',
      method: 'item/permissions/requestApproval',
      params: { itemId: 'permissions', threadId: 'thread-1', turnId: 'turn-1' },
    });
    send({
      id: 'dynamic-1',
      method: 'item/tool/call',
      params: { arguments: {}, callId: 'call-1', threadId: 'thread-1', tool: 'missing' },
    });
    send({ id: 'current-time-1', method: 'currentTime/read', params: {} });
    send({
      id: 'legacy-patch-1',
      method: 'applyPatchApproval',
      params: { callId: 'patch-1', conversationId: 'thread-1' },
    });
    send({
      id: 'legacy-command-1',
      method: 'execCommandApproval',
      params: { callId: 'command-1', conversationId: 'thread-1' },
    });
    send({
      id: 'auth-refresh-1',
      method: 'account/chatgptAuthTokens/refresh',
      params: { previousAccountId: null },
    });
    send({ id: 'attestation-1', method: 'attestation/generate', params: {} });
    await vi.waitFor(() => {
      expect(requests).toContainEqual({
        error: {
          code: -32_000,
          message: 'Permission approval is unavailable in this client.',
        },
        id: 'permissions-1',
      });
      expect(requests).toContainEqual({
        id: 'dynamic-1',
        result: {
          contentItems: [
            { text: "Dynamic tool 'missing' is not registered by LobeHub.", type: 'inputText' },
          ],
          success: false,
        },
      });
      expect(requests).toContainEqual({
        id: 'current-time-1',
        result: { currentTimeAt: expect.any(Number) },
      });
      expect(requests).toContainEqual({
        id: 'legacy-patch-1',
        result: {
          decision: { denied: { rejection: 'Approval UI is unavailable in this client.' } },
        },
      });
      expect(requests).toContainEqual({
        id: 'legacy-command-1',
        result: {
          decision: { denied: { rejection: 'Approval UI is unavailable in this client.' } },
        },
      });
      expect(requests).toContainEqual({
        error: {
          code: -32_000,
          message:
            'Codex app-server request is unavailable in this client: account/chatgptAuthTokens/refresh',
        },
        id: 'auth-refresh-1',
      });
      expect(requests).toContainEqual({
        error: {
          code: -32_000,
          message: 'Codex app-server request is unavailable in this client: attestation/generate',
        },
        id: 'attestation-1',
      });
    });
    send({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
    });
    await run;

    expect(onIntervention).toHaveBeenCalledTimes(6);
    const userInputRequest = onIntervention.mock.calls[0][0];
    expect(userInputRequest).toEqual(
      expect.objectContaining({
        arguments: expect.objectContaining({
          allowEscape: false,
          questions: expect.arrayContaining([
            expect.objectContaining({ id: 'scope' }),
            expect.objectContaining({ allowCustom: false, id: 'target' }),
          ]),
        }),
        timeoutMs: null,
      }),
    );
    expect(userInputRequest.arguments).not.toHaveProperty('deadline');
    expect(onIntervention.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        arguments: expect.objectContaining({
          allowEscape: false,
          deadline: expect.any(Number),
          description: 'Configure connector',
          questions: expect.arrayContaining([
            expect.objectContaining({ id: 'name', required: true }),
            expect.objectContaining({ id: 'scope', required: false }),
          ]),
        }),
      }),
    );
  });

  it('cancels a pending child-thread intervention when serverRequest/resolved clears it elsewhere', async () => {
    const { child, requests, send } = createAppServerProcess({ autoComplete: false });
    spawnMock.mockReturnValue(child);
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    const statuses: any[] = [];
    const onIntervention = vi.fn(
      (_request, signal: AbortSignal) =>
        new Promise<{ cancelled: boolean }>((resolve) => {
          signal.addEventListener('abort', () => resolve({ cancelled: true }), { once: true });
        }),
    );
    const session = new CodexAppServerSession({
      args: [],
      clientVersion: '1.0.0',
      commandPath: 'codex',
      cwd: '/workspace',
      env: process.env,
      input: [{ text: 'hello', text_elements: [], type: 'text' }],
      onEvents: vi.fn(),
      onIntervention,
      onRawMessage: vi.fn(),
      onRuntimeStatus: (status) => statuses.push(status),
      onSessionId: vi.fn(),
      onStderr: vi.fn(),
      operationId: 'operation-1',
      sessionId: 'session-1',
    });

    const run = session.run();
    await vi.waitFor(() => expect(statuses.some(({ state }) => state === 'running')).toBe(true));
    send({
      id: 77,
      method: 'item/tool/requestUserInput',
      params: {
        itemId: 'ask-77',
        questions: [
          {
            header: 'Scope',
            id: 'scope',
            isOther: false,
            isSecret: false,
            options: null,
            question: 'Choose scope',
          },
        ],
        threadId: 'child-thread-77',
        turnId: 'turn-1',
      },
    });
    await vi.waitFor(() => expect(onIntervention).toHaveBeenCalledOnce());
    send({
      method: 'serverRequest/resolved',
      params: { requestId: 77, threadId: 'child-thread-77' },
    });
    await vi.waitFor(() =>
      expect(onIntervention.mock.results[0].value).resolves.toEqual({ cancelled: true }),
    );
    expect(requests.some(({ id, result }) => id === 77 && result !== undefined)).toBe(false);

    send({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
    });
    await run;
  });

  it('ignores terminal notifications for another thread', async () => {
    const { child, send } = createAppServerProcess({ autoComplete: false });
    spawnMock.mockReturnValue(child);
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    const statuses: any[] = [];

    const session = new CodexAppServerSession({
      args: [],
      clientVersion: '1.0.0',
      commandPath: 'codex',
      cwd: '/workspace',
      env: process.env,
      input: [{ text: 'hello', text_elements: [], type: 'text' }],
      onEvents: vi.fn(),
      onRawMessage: vi.fn(),
      onRuntimeStatus: (status) => statuses.push(status),
      onSessionId: vi.fn(),
      onStderr: vi.fn(),
      operationId: 'operation-1',
      sessionId: 'session-1',
    });

    const run = session.run();
    await vi.waitFor(() => expect(statuses.some(({ state }) => state === 'running')).toBe(true));
    send({
      method: 'turn/completed',
      params: {
        threadId: 'another-thread',
        turn: { id: 'another-turn', status: 'completed' },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(statuses.some(({ state }) => state === 'idle')).toBe(false);

    await session.interrupt();
    await run;
  });
});

describe('Codex app-server payload builders', () => {
  it('starts only the app-server subcommand and translates runtime flags into thread params', () => {
    expect(buildCodexAppServerArgs()).toEqual(['app-server']);
    expect(
      buildCodexAppServerArgs([
        '--model',
        'gpt-5.5-codex',
        '-c',
        'model_reasoning_effort="high"',
        '--config=service_tier="fast"',
      ]),
    ).toEqual([
      '-c',
      'model_reasoning_effort="high"',
      '--config=service_tier="fast"',
      'app-server',
    ]);
    expect(
      buildCodexAppServerThreadParams(
        [
          '--model',
          'gpt-5.5-codex',
          '-s',
          'read-only',
          '-a',
          'never',
          '--cd',
          'nested',
          '--ephemeral',
          '-c',
          'model_reasoning_effort="high"',
          '-c',
          'model_provider="openai"',
          '--config=service_tier="fast"',
        ],
        '/workspace',
      ),
    ).toEqual({
      approvalPolicy: 'never',
      cwd: '/workspace/nested',
      ephemeral: true,
      model: 'gpt-5.5-codex',
      modelProvider: 'openai',
      sandbox: 'read-only',
      serviceTier: 'fast',
    });
    expect(buildCodexAppServerThreadParams(['--full-auto'], '/workspace')).toMatchObject({
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
    });
    expect(
      buildCodexAppServerThreadParams(['--dangerously-bypass-approvals-and-sandbox'], '/workspace'),
    ).toMatchObject({ approvalPolicy: 'never', sandbox: 'danger-full-access' });
  });

  it('falls back for unsupported or interactive CLI arguments instead of dropping them', () => {
    expect(getCodexAppServerUnsupportedArgs(['--profile', 'work'])).toEqual(['--profile']);
    expect(getCodexAppServerUnsupportedArgs(['--ignore-user-config'])).toEqual([
      '--ignore-user-config',
    ]);
    expect(getCodexAppServerUnsupportedArgs(['--full-auto'])).toEqual(['--full-auto']);
    expect(getCodexAppServerUnsupportedArgs(['-a', 'on-request'])).toEqual(['-a']);
    expect(getCodexAppServerUnsupportedArgs(['-c', 'approval_policy="untrusted"'])).toEqual(['-c']);
    expect(getCodexAppServerUnsupportedArgs(['--search'])).toEqual(['--search']);
    expect(getCodexAppServerUnsupportedArgs(['--model', '--ephemeral'])).toEqual(['--model']);
    expect(getCodexAppServerUnsupportedArgs(['--sandbox', 'invalid'])).toEqual(['--sandbox']);
    expect(
      getCodexAppServerUnsupportedArgs([
        '--dangerously-bypass-approvals-and-sandbox',
        '--sandbox',
        'read-only',
      ]),
    ).toEqual(['--dangerously-bypass-approvals-and-sandbox']);
    expect(getCodexAppServerUnsupportedArgs(['--ephemeral'], { resume: true })).toEqual([
      '--ephemeral',
    ]);
    expect(
      getCodexAppServerUnsupportedArgs([
        '--model',
        'gpt-5.5-codex',
        '-c',
        'service_tier="fast"',
        '--cd=src',
        '--ephemeral',
      ]),
    ).toEqual([]);
  });

  it('converts Codex text and --image args into v2 turn inputs', () => {
    expect(
      buildCodexAppServerInput({
        args: ['--image', '/tmp/a.png', '--image', '/tmp/b.jpg'],
        stdin: 'describe these',
      }),
    ).toEqual([
      { text: 'describe these', text_elements: [], type: 'text' },
      { path: '/tmp/a.png', type: 'localImage' },
      { path: '/tmp/b.jpg', type: 'localImage' },
    ]);
  });
});
