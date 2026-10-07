import type { UIChatMessage } from '@lobechat/types';
import { describe, expect, it } from 'vitest';

import {
  buildPreviousConversationTurns,
  buildResumeReplayMessages,
  shouldHydrateResumeReplay,
} from './resumeReplay';

const msg = (over: Partial<UIChatMessage>): UIChatMessage =>
  ({ content: '', createdAt: 1_780_000_000_000, id: 'm', role: 'user', ...over }) as UIChatMessage;

describe('buildResumeReplayMessages', () => {
  it('maps user / assistant / tool turns into the transcript-rebuild shape', () => {
    const out = buildResumeReplayMessages([
      msg({ content: 'hi', id: 'u1', role: 'user' }),
      msg({
        content: 'reading',
        id: 'a1',
        role: 'assistant',
        tools: [
          {
            apiName: 'Read',
            arguments: '{"p":1}',
            id: 'toolu_1',
            identifier: 'claude-code',
            type: 'default',
          },
        ],
      } as Partial<UIChatMessage>),
      msg({ content: 'file body', id: 't1', role: 'tool', tool_call_id: 'toolu_1' }),
    ]);

    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(out[1].tools?.[0]).toMatchObject({ apiName: 'Read', id: 'toolu_1' });
    expect(out[2].toolCallId).toBe('toolu_1');
    expect(out[0].createdAt).toBe(new Date(1_780_000_000_000).toISOString());
  });

  it('skips virtual/grouping roles that carry no replayable turn', () => {
    const out = buildResumeReplayMessages([
      msg({ content: 'real', id: 'u1', role: 'user' }),
      msg({ content: 'grouped', id: 'g1', role: 'assistantGroup' as any }),
      msg({ content: 'sys', id: 's1', role: 'system' as any }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe('real');
  });

  it('drops a tool turn with no tool_call_id (nothing to answer)', () => {
    const out = buildResumeReplayMessages([
      msg({ content: 'q', id: 'u1', role: 'user' }),
      msg({ content: 'orphan', id: 't1', role: 'tool' }),
    ]);
    expect(out.map((m) => m.role)).toEqual(['user']);
  });

  it('drops the in-flight prompt echo and the empty assistant placeholder', () => {
    const out = buildResumeReplayMessages(
      [
        msg({ content: 'older turn', id: 'u1', role: 'user' }),
        msg({ content: 'older reply', id: 'a1', role: 'assistant' }),
        msg({ content: 'new question', id: 'u2', role: 'user' }),
        msg({ content: '', id: 'a2', role: 'assistant' }),
      ],
      'new question',
    );
    // only the PREVIOUS turns survive — the new prompt is sent separately
    expect(out.map((m) => m.content)).toEqual(['older turn', 'older reply']);
  });

  it('returns an empty array for empty/undefined input', () => {
    expect(buildResumeReplayMessages(undefined)).toEqual([]);
    expect(buildResumeReplayMessages([])).toEqual([]);
  });
});

describe('shouldHydrateResumeReplay', () => {
  it('pays for a restored transcript only where one is actually rebuilt', () => {
    // Main rebuilds a transcript for Claude Code and nothing else; the other
    // adapters are handed the replay and ignore it, so restoring their bodies
    // would be one authenticated round trip per historical tool, every turn.
    expect(shouldHydrateResumeReplay('claude-code')).toBe(true);

    for (const other of ['codex', 'opencode', 'pi', 'droid', undefined]) {
      expect(shouldHydrateResumeReplay(other)).toBe(false);
    }
  });
});

/** @example Fresh edited runs replay the selected ancestry, including tool batches. */
describe('buildPreviousConversationTurns', () => {
  /** @example Both tool outputs survive, while later turns and sibling attempts do not. */
  it('keeps tool results and selected context before the edited user boundary', () => {
    const messages = [
      msg({
        id: 'u1',
        content: 'Read the selected context',
        metadata: {
          contextSelections: [{ id: 'selection', source: 'text', content: 'SELECTED-647' }],
        },
      }),
      msg({
        id: 'a1',
        parentId: 'u1',
        role: 'assistant',
        tools: [
          { id: 'call1', apiName: 'shell', arguments: '{}', identifier: 'codex', type: 'default' },
          { id: 'call2', apiName: 'shell', arguments: '{}', identifier: 'codex', type: 'default' },
        ],
      }),
      msg({
        id: 't1',
        parentId: 'a1',
        role: 'tool',
        tool_call_id: 'call1',
        content: 'TOOL-647-ONE',
      }),
      msg({
        id: 't2',
        parentId: 'a1',
        role: 'tool',
        tool_call_id: 'call2',
        content: 'TOOL-647-TWO',
      }),
      msg({ id: 'answer', parentId: 't1', role: 'assistant', content: 'Read both files.' }),
      msg({ id: 'sibling', parentId: 'u1', role: 'assistant', content: 'SIBLING-SECRET' }),
      msg({ id: 'edited', parentId: 'answer', content: 'EDITED-647' }),
      msg({ id: 'current', parentId: 'edited', role: 'assistant' }),
      msg({ id: 'later', parentId: 'current', content: 'AFTER-BOUNDARY-SECRET' }),
    ];
    // ROOT CAUSE:
    // The text-only filter discarded tool rows and metadata, and parent walking
    // alone missed the second tool result in the same assistant tool batch.
    // Fresh edited sessions must replay the completed batch and user selections.
    const history = JSON.stringify(buildPreviousConversationTurns(messages, 'current'));
    /** @example Selected text is available to the fresh CLI. */
    expect(history).toContain('SELECTED-647');
    /** @example The first historical shell result survives. */
    expect(history).toContain('TOOL-647-ONE');
    /** @example A parallel result attached to the same ancestor also survives. */
    expect(history).toContain('TOOL-647-TWO');
    /** @example The replaced prompt is sent separately, never replayed as history. */
    expect(history).not.toContain('EDITED-647');
    /** @example An unrelated assistant attempt is excluded. */
    expect(history).not.toContain('SIBLING-SECRET');
    /** @example No post-boundary content enters the new session. */
    expect(history).not.toContain('AFTER-BOUNDARY-SECRET');
  });
});

/** @example Continuing after an assistant keeps that assistant in the completed history. */
describe('fresh continuation ancestry', () => {
  /** @example Only a user boundary is excluded as the separately dispatched prompt. */
  it('retains a non-user anchor when continuing a fresh run', () => {
    const history = buildPreviousConversationTurns(
      [
        msg({ id: 'question', content: 'Original question' }),
        msg({ id: 'answer', role: 'assistant', parentId: 'question', content: 'Partial answer' }),
        msg({ id: 'current', role: 'assistant', parentId: 'answer' }),
      ],
      'current',
    );
    /** @example The continuation sees both the original user and partial assistant response. */
    expect(history.map((entry) => entry.content)).toEqual(['Original question', 'Partial answer']);
  });
});

/** @example Concurrent shell results remain attributable when they complete out of order. */
describe('tool result attribution', () => {
  /** @example The second shell call finishes before the first one. */
  it('preserves the call ID with each serialized result', () => {
    const history = buildPreviousConversationTurns(
      [
        msg({ id: 'u', content: 'Read two files' }),
        msg({
          id: 'a',
          role: 'assistant',
          parentId: 'u',
          tools: [
            {
              id: 'first',
              apiName: 'shell',
              arguments: '{"file":"red"}',
              identifier: 'codex',
              type: 'default',
            },
            {
              id: 'second',
              apiName: 'shell',
              arguments: '{"file":"blue"}',
              identifier: 'codex',
              type: 'default',
            },
          ],
        }),
        msg({ id: 't2', role: 'tool', parentId: 'a', tool_call_id: 'second', content: 'BLUE' }),
        msg({ id: 't1', role: 'tool', parentId: 'a', tool_call_id: 'first', content: 'RED' }),
        msg({ id: 'edited', parentId: 't1', content: 'Edited question' }),
        msg({ id: 'current', role: 'assistant', parentId: 'edited' }),
      ],
      'current',
    );
    // ROOT CAUSE:
    // Tool bodies survived replay but their tool_call_id did not. Parallel calls
    // can complete in reverse order; each serialized result must retain its ID.
    /** @example The blue output belongs to the second call regardless of array position. */
    expect(history.find((entry) => entry.content === 'BLUE')?.context).toContain('second');
    /** @example The red output belongs to the first call. */
    expect(history.find((entry) => entry.content === 'RED')?.context).toContain('first');
  });
});
