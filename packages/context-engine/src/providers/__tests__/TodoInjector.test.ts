import { describe, expect, it } from 'vitest';

import type { PipelineContext } from '../../types';
import { TodoInjector, type TodoList } from '../TodoInjector';
import { TopicReferenceContextInjector } from '../TopicReferenceContextInjector';

const createContext = (messages: any[]): PipelineContext => ({
  initialState: { messages: [] },
  isAborted: false,
  messages,
  metadata: {},
});

const todos = (...items: Array<[string, 'todo' | 'processing' | 'completed']>): TodoList => ({
  items: items.map(([text, status]) => ({ status, text })),
  updatedAt: '2026-01-01T00:00:00.000Z',
});

/** `[user, assistant(tool_calls), tool]` — the shape that used to break the prefix cache. */
const toolLoopMessages = () => [
  { content: 'system role', role: 'system' },
  { content: 'help me refactor the parser', id: 'msg-user', role: 'user' },
  {
    content: '',
    id: 'msg-assistant',
    role: 'assistant',
    tools: [{ apiName: 'createTodos', identifier: 'lobe-agent' }],
  },
  { content: '{"success":true}', id: 'msg-tool', role: 'tool' },
];

/** Everything a provider actually sends upstream, per message. */
const payloadSignatures = (messages: any[]) =>
  messages.map((message) => JSON.stringify({ content: message.content, role: message.role }));

describe('TodoInjector', () => {
  it('leaves the historical user message untouched and appends a virtual tail message', async () => {
    const messages = toolLoopMessages();
    const provider = new TodoInjector({ enabled: true, todos: todos(['write tests', 'todo']) });

    const result = await provider.process(createContext(messages));

    expect(result.messages[1].content).toBe('help me refactor the parser');
    expect(result.messages).toHaveLength(5);

    const tail = result.messages.at(-1);
    expect(tail?.role).toBe('user');
    expect(tail?.meta?.virtualLastUser).toBe(true);
    expect(tail?.meta?.injectType).toBe('TodoInjector');
    expect(tail?.content).toContain('<todo_context>');
    expect(tail?.content).toContain('<todo index="0" status="todo">write tests</todo>');
    expect(tail?.content).toContain('<progress completed="0" processing="0" total="1" />');
  });

  it('keeps every preceding message byte-identical across two different todo states', async () => {
    const first = await new TodoInjector({
      enabled: true,
      todos: todos(['read the code', 'processing'], ['write tests', 'todo']),
    }).process(createContext(toolLoopMessages()));

    const second = await new TodoInjector({
      enabled: true,
      todos: todos(
        ['read the code', 'completed'],
        ['write tests', 'processing'],
        ['run the suite', 'todo'],
      ),
    }).process(createContext(toolLoopMessages()));

    // Only the tail differs — the whole prefix stays reusable.
    expect(payloadSignatures(second.messages.slice(0, -1))).toEqual(
      payloadSignatures(first.messages.slice(0, -1)),
    );
    expect(second.messages.at(-1)?.content).not.toBe(first.messages.at(-1)?.content);
  });

  it('does not fold todo state into the real user message on the first turn', async () => {
    const messages = [
      { content: 'system role', role: 'system' },
      { content: 'plan the migration', id: 'msg-user', role: 'user' },
    ];

    const result = await new TodoInjector({
      enabled: true,
      todos: todos(['plan the migration', 'processing']),
    }).process(createContext(messages));

    expect(result.messages[1].content).toBe('plan the migration');
    expect(result.messages).toHaveLength(3);
    expect(result.messages[2].meta?.virtualLastUser).toBe(true);
  });

  it('reuses an existing virtual tail message instead of adding another one', async () => {
    const messages = [
      ...toolLoopMessages(),
      {
        content: '<next_actions>keep going</next_actions>',
        meta: { injectType: 'OnboardingActionHintInjector', virtualLastUser: true },
        role: 'user',
      },
    ];

    const result = await new TodoInjector({
      enabled: true,
      todos: todos(['keep going', 'processing']),
    }).process(createContext(messages));

    expect(result.messages).toHaveLength(5);
    expect(result.messages[4].content).toContain('<next_actions>keep going</next_actions>');
    expect(result.messages[4].content).toContain('<todo_context>');
    expect(result.messages[1].content).toBe('help me refactor the parser');
  });

  it('does not let historical-user injectors write into the todo tail message', async () => {
    const injected = await new TodoInjector({
      enabled: true,
      todos: todos(['write tests', 'todo']),
    }).process(createContext(toolLoopMessages()));

    const result = await new TopicReferenceContextInjector({
      enabled: true,
      topicReferences: [
        { summary: 'we discussed parsers', topicId: 'tpc_1', topicTitle: 'Parser' },
      ],
    }).process(injected);

    expect(result.messages.at(-1)?.content).not.toContain('topic_reference_context');
    expect(result.messages[1].content).toContain('topic_reference_context');
  });

  it('records todo metadata', async () => {
    const result = await new TodoInjector({
      enabled: true,
      todos: todos(
        ['read the code', 'completed'],
        ['write tests', 'processing'],
        ['run the suite', 'todo'],
      ),
    }).process(createContext(toolLoopMessages()));

    expect(result.metadata.todoInjected).toBe(true);
    expect(result.metadata.todoCount).toBe(3);
    expect(result.metadata.todoCompletedCount).toBe(1);
    expect(result.metadata.todoProcessingCount).toBe(1);
  });

  it('skips injection when disabled, empty, or without any user turn', async () => {
    const disabled = await new TodoInjector({
      enabled: false,
      todos: todos(['x', 'todo']),
    }).process(createContext(toolLoopMessages()));
    expect(disabled.messages).toHaveLength(4);
    expect(disabled.metadata.todoInjected).toBeUndefined();

    const empty = await new TodoInjector({
      enabled: true,
      todos: { items: [], updatedAt: '2026-01-01T00:00:00.000Z' },
    }).process(createContext(toolLoopMessages()));
    expect(empty.messages).toHaveLength(4);

    const noUser = await new TodoInjector({
      enabled: true,
      todos: todos(['x', 'todo']),
    }).process(createContext([{ content: 'system role', role: 'system' }]));
    expect(noUser.messages).toHaveLength(1);
  });
});
