import { describe, expect, it } from 'vitest';

import {
  buildSnippet,
  clampSearchLimit,
  formatMessageResults,
  formatTopicResults,
  messageFetchLimit,
  resolveAgentFilter,
  RESULT_BUDGET_CHARS,
  SNIPPET_MAX_CHARS,
} from './format';

const updatedAt = new Date('2026-09-15T07:10:38.644Z');

describe('resolveAgentFilter', () => {
  it('narrows to the running agent by default', () => {
    expect(resolveAgentFilter(undefined, 'agt_a')).toBe('agt_a');
    expect(resolveAgentFilter('agent', 'agt_a')).toBe('agt_a');
  });

  it('widens to every agent only when scope is all', () => {
    expect(resolveAgentFilter('all', 'agt_a')).toBeUndefined();
  });
});

describe('clampSearchLimit', () => {
  it('defaults and clamps into 1..10', () => {
    expect(clampSearchLimit()).toBe(5);
    expect(clampSearchLimit(0)).toBe(5);
    expect(clampSearchLimit(50)).toBe(10);
    expect(clampSearchLimit(2.7)).toBe(2);
  });

  it('over-fetches messages to survive role filtering, capped at 30', () => {
    expect(messageFetchLimit(5)).toBe(15);
    expect(messageFetchLimit(10)).toBe(30);
  });
});

describe('buildSnippet', () => {
  it('keeps short content intact with whitespace collapsed', () => {
    expect(buildSnippet('hello\n\n  world', 'world')).toBe('hello world');
  });

  it('cuts a bounded window around the match of a long message', () => {
    const content = `${'a'.repeat(10_000)} Pulse pricing is $20 ${'b'.repeat(10_000)}`;
    const snippet = buildSnippet(content, 'pulse pricing');

    expect(snippet).toContain('Pulse pricing is $20');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(SNIPPET_MAX_CHARS + 2);
  });

  it('falls back to an individual term when the full phrase is absent', () => {
    const content = `${'x'.repeat(5000)} the Railway runbook ${'y'.repeat(5000)}`;
    expect(buildSnippet(content, 'runbook deploy')).toContain('runbook');
  });

  it('starts from the beginning when nothing matches', () => {
    const snippet = buildSnippet('z'.repeat(5000), 'missing');
    expect(snippet.startsWith('z')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
  });
});

describe('formatTopicResults', () => {
  it('lists topics with ids, agents and escaped titles', () => {
    const content = formatTopicResults(
      [
        {
          agent: { title: 'Kimi Code' },
          agentId: 'agt_1',
          id: 'tpc_1',
          title: 'Pulse "pricing" <draft>',
          updatedAt,
        },
      ],
      { agentFilter: 'agt_1', query: 'pulse' },
    );

    expect(content).toContain('<topics query="pulse" scope="agent" count="1">');
    expect(content).toContain(
      '<topic id="tpc_1" title="Pulse &quot;pricing&quot; &lt;draft>" agentId="agt_1" agent="Kimi Code" updatedAt="2026-09-15T07:10:38.644Z" />',
    );
    expect(content).toContain('readTopic');
  });

  it('suggests widening the scope when the agent has no match', () => {
    expect(formatTopicResults([], { agentFilter: 'agt_1', query: 'x' })).toContain('scope "all"');
    expect(formatTopicResults([], { query: 'x' })).not.toContain('scope "all"');
  });
});

describe('formatMessageResults', () => {
  const hit = (overrides: Record<string, unknown>) => ({
    agentId: 'agt_1',
    content: 'we agreed on Pulse pricing',
    id: 'msg_1',
    role: 'assistant',
    topicId: 'tpc_1',
    updatedAt,
    ...overrides,
  });

  it('drops tool / system rows and rows without a topic, then applies the limit', () => {
    const content = formatMessageResults(
      [
        hit({ id: 'msg_tool', role: 'tool' }),
        hit({ id: 'msg_sys', role: 'system' }),
        hit({ id: 'msg_orphan', topicId: null }),
        hit({ id: 'msg_1' }),
        hit({ id: 'msg_2', role: 'user' }),
        hit({ id: 'msg_3' }),
      ],
      { agentFilter: undefined, limit: 2, query: 'pulse' },
    );

    expect(content).toContain('count="2"');
    expect(content).toContain('id="msg_1"');
    expect(content).toContain('id="msg_2"');
    expect(content).not.toContain('msg_tool');
    expect(content).not.toContain('msg_sys');
    expect(content).not.toContain('msg_orphan');
    expect(content).not.toContain('msg_3');
  });

  it('never returns full message bodies: two 20k-char hits stay within the budget', () => {
    const big = `${'a'.repeat(19_000)} Railway 微服务 ${'b'.repeat(2000)}`;
    const content = formatMessageResults(
      [hit({ content: big, id: 'm1' }), hit({ content: big, id: 'm2' })],
      { limit: 5, query: 'Railway 微服务' },
    );

    expect(content).toContain('Railway 微服务');
    expect(content.length).toBeLessThan(1000);
  });

  it('stops at the total budget and reports omitted hits', () => {
    const hits = Array.from({ length: 30 }, (_, i) =>
      hit({ content: `${'c'.repeat(400)} pulse ${'d'.repeat(400)}`, id: `m${i}` }),
    );
    const content = formatMessageResults(hits, { limit: 30, query: 'pulse' });

    expect(content.length).toBeLessThan(RESULT_BUDGET_CHARS + 500);
    expect(content).toMatch(/omitted="\d+"/);
  });

  it('escapes markup inside snippets', () => {
    const content = formatMessageResults([hit({ content: '<task>pulse</task>' })], {
      limit: 5,
      query: 'pulse',
    });
    expect(content).toContain('&lt;task>pulse&lt;/task>');
  });
});
