import type { BuiltinInterventionProps } from '@lobechat/types';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  buildSubmitPayload,
  FREEFORM_PAYLOAD_KEY,
  getQuestionKey,
  isQuestionAnswered,
  readDraft,
} from './draft';
import { normalizeAskUserDescription, normalizeAskUserQuestions } from './normalize';
import type { AskUserDraft, AskUserQuestionArgs, AskUserQuestionItem } from './types';

export interface UseAskUserFormParams {
  args: AskUserQuestionArgs | undefined;
  /**
   * Relative fallback for hosts without `args.deadline`. Either deadline form
   * drives the countdown and timeout fallback; when both are absent no timer runs.
   */
  countdownMs?: number;
  onInteractionAction?: BuiltinInterventionProps<AskUserQuestionArgs>['onInteractionAction'];
  /** Raw persisted draft blob read from the host's store (coerced internally). */
  persistedDraft: unknown;
  /** Persist the full draft; host wires this to its own store. */
  writeDraft: (draft: AskUserDraft) => void;
}

export interface AskUserFormApi {
  activeQuestion?: AskUserQuestionItem;
  activeTab: string;
  custom: Record<string, string>;
  description?: string;
  escapeActive: boolean;
  escapeAvailable: boolean;
  escapeText: string;
  expired: boolean;
  handleCustomChange: (q: AskUserQuestionItem, value: string) => void;
  handleEscapeTextChange: (value: string) => void;
  handleSkip: () => void;
  handleSubmit: () => void;
  handleToggle: (
    q: AskUserQuestionItem,
    label: string,
    options?: {
      /**
       * Allow the single-select "select-to-submit" fast path for this toggle.
       * Only keyboard-driven picks (digits / Enter) opt in — a mouse click is
       * too easy to land by accident to fire a submit on its own, so clicks
       * just select and leave submission to the explicit Submit button/Enter.
       */
      submitOnComplete?: boolean;
    },
  ) => void;
  isMulti: boolean;
  isSubmitDisabled: boolean;
  picks: Record<string, string | string[]>;
  questions: AskUserQuestionItem[];
  remainingMs: number;
  setActiveTab: (key: string) => void;
  setEscapeMode: (next: boolean) => void;
  submitting: boolean;
}

/**
 * All state + handlers for the AskUserQuestion form. Kept out of the view so
 * the per-package `index.tsx` stays a thin render of the returned values.
 *
 * Draft persistence is host-owned: the caller passes the raw `persistedDraft`
 * (read from wherever it stores plugin state) and a `writeDraft` callback, so
 * this hook never touches any app store directly and stays app-decoupled.
 */
export const useAskUserForm = ({
  args,
  countdownMs,
  onInteractionAction,
  persistedDraft,
  writeDraft,
}: UseAskUserFormParams): AskUserFormApi => {
  const questions = useMemo(() => normalizeAskUserQuestions(args), [args]);
  const description = useMemo(() => normalizeAskUserDescription(args), [args]);
  const suppliedDeadline = args?.deadline;

  // Plain const (not a hook) so it can read `persistedDraft` without tripping
  // exhaustive-deps; consumed only by the once-run useState initializers below.
  const initial = readDraft(persistedDraft);

  const [picks, setPicks] = useState<Record<string, string | string[]>>(() => initial.picks);
  const [custom, setCustom] = useState<Record<string, string>>(() => initial.custom);
  const [escapeText, setEscapeText] = useState<string>(() => initial.escapeText);
  const [escapeActive, setEscapeActive] = useState<boolean>(() => initial.escapeActive);
  const [submitting, setSubmitting] = useState(false);
  const [activeTab, setActiveTab] = useState<string>(() => {
    // Resume on the first unanswered question rather than always at Q1.
    const idx = questions.findIndex((q) => !isQuestionAnswered(q, initial.picks, initial.custom));
    return String(idx >= 0 ? idx : 0);
  });

  // Countdown is opt-in: bridge-backed surfaces supply an absolute deadline,
  // while legacy hosts may still provide a mount-relative duration.
  const countdownEnabled = suppliedDeadline != null || countdownMs != null;

  const deadline = useMemo(
    () => suppliedDeadline ?? Date.now() + (countdownMs ?? 0),
    [countdownMs, suppliedDeadline],
  );
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!countdownEnabled) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [countdownEnabled]);
  const expired = countdownEnabled ? now >= deadline : false;

  /**
   * Submit `payload` exactly as given. Used by the Submit button (with the
   * user's picks/text), the single-select select-to-submit path, and the
   * timeout fallback (option 1 of each unanswered question merged in).
   */
  const submitWith = useCallback(
    async (payload: Record<string, string | string[]>) => {
      if (!onInteractionAction || submitting) return;
      setSubmitting(true);
      try {
        await onInteractionAction({ payload, type: 'submit' });
      } catch (err) {
        console.error('[AskUserQuestion] submit failed:', err);
        setSubmitting(false);
      }
    },
    [onInteractionAction, submitting],
  );

  const handleToggle = useCallback(
    (q: AskUserQuestionItem, label: string, options?: { submitOnComplete?: boolean }) => {
      const key = getQuestionKey(q);
      let nextPicks: Record<string, string | string[]>;
      if (q.multiSelect) {
        const current = (picks[key] as string[] | undefined) ?? [];
        nextPicks = {
          ...picks,
          [key]: current.includes(label) ? current.filter((x) => x !== label) : [...current, label],
        };
      } else {
        nextPicks = { ...picks, [key]: label };
      }

      // Single-select pick and custom text are mutually exclusive — picking
      // drops any "write your own" text. Multi-select keeps it (additive).
      let nextCustom = custom;
      if (!q.multiSelect && custom[key]) {
        const { [key]: _drop, ...rest } = custom;
        nextCustom = rest;
      }

      setPicks(nextPicks);
      if (nextCustom !== custom) setCustom(nextCustom);
      writeDraft({ custom: nextCustom, escapeActive, escapeText, picks: nextPicks });

      if (!q.multiSelect) {
        // Codex-style select-to-submit: the pick that completes the form sends
        // it right away — no extra Submit press for single-select flows. Two
        // gates: the caller must opt in via `submitOnComplete` (keyboard picks
        // only — a stray mouse click must never submit on its own), and the
        // question must have been unanswered so revisiting an already answered
        // question only updates the pick and never fires a surprise submit
        // while the user is reviewing.
        const wasUnanswered = !isQuestionAnswered(q, picks, custom);
        const allAnswered = questions.every((qq) => isQuestionAnswered(qq, nextPicks, nextCustom));
        if (options?.submitOnComplete && wasUnanswered && allAnswered) {
          void submitWith(buildSubmitPayload(questions, nextPicks, nextCustom));
          return;
        }

        // Auto-advance to the next still-unanswered question, so the user
        // sweeps through without re-clicking the tabs.
        if (questions.length > 1) {
          const next = questions.findIndex(
            (qq) => getQuestionKey(qq) !== key && !isQuestionAnswered(qq, nextPicks, nextCustom),
          );
          if (next >= 0) setActiveTab(String(next));
        }
      }
    },
    [picks, custom, escapeActive, escapeText, questions, submitWith, writeDraft],
  );

  const handleCustomChange = useCallback(
    (q: AskUserQuestionItem, value: string) => {
      const key = getQuestionKey(q);
      const nextCustom = { ...custom, [key]: value };

      // Single-select: writing your own answer clears the picked option so the
      // two stay mutually exclusive. Multi-select keeps the checks — custom
      // text rides along as an additive entry.
      let nextPicks = picks;
      if (!q.multiSelect && value.trim() && picks[key]) {
        const { [key]: _drop, ...rest } = picks;
        nextPicks = rest;
      }

      setCustom(nextCustom);
      if (nextPicks !== picks) setPicks(nextPicks);
      writeDraft({ custom: nextCustom, escapeActive, escapeText, picks: nextPicks });
    },
    [picks, custom, escapeActive, escapeText, writeDraft],
  );

  const handleEscapeTextChange = useCallback(
    (value: string) => {
      setEscapeText(value);
      // Persist freeform text alongside the (hidden) picks so a refresh resumes
      // here; the picks survive a toggle back to the form.
      writeDraft({ custom, escapeActive: true, escapeText: value, picks });
    },
    [custom, picks, writeDraft],
  );

  const setEscapeMode = useCallback(
    (next: boolean) => {
      setEscapeActive(next);
      writeDraft({ custom, escapeActive: next, escapeText, picks });
    },
    [custom, escapeText, picks, writeDraft],
  );

  // Whole-form freeform only makes sense with more than one question — with a
  // single question the per-question custom box already IS the full custom
  // answer, so escape is redundant there and never offered.
  const escapeAvailable = questions.length > 1 && args?.allowEscape !== false;
  const inEscape = escapeActive && escapeAvailable;

  const handleSubmit = useCallback(() => {
    if (escapeActive && escapeAvailable) {
      // Escape mode is mutually exclusive with picks — send the text alone
      // under `__freeform__`. Bridge formatter forwards it verbatim.
      void submitWith({ [FREEFORM_PAYLOAD_KEY]: escapeText.trim() });
    } else {
      void submitWith(buildSubmitPayload(questions, picks, custom));
    }
  }, [custom, escapeActive, escapeAvailable, escapeText, picks, questions, submitWith]);

  const handleSkip = useCallback(async () => {
    if (!onInteractionAction || submitting) return;
    setSubmitting(true);
    try {
      await onInteractionAction({ type: 'skip' });
    } catch (err) {
      console.error('[AskUserQuestion] skip failed:', err);
      setSubmitting(false);
    }
  }, [onInteractionAction, submitting]);

  const allRequiredAnswered = useMemo(
    () => questions.every((q) => q.required === false || isQuestionAnswered(q, picks, custom)),
    [picks, custom, questions],
  );

  // Timeout fallback: when the countdown hits zero and the user hasn't
  // submitted, fill option 1 of each unanswered question and submit. Beats
  // letting the bridge time out into a `cancelled` isError — the model gets a
  // structured answer it can act on. Single-shot via the `submitting` guard.
  //
  // Escape-mode special case: if the user is in escape mode with non-empty text
  // when the clock hits zero, submit that text as-is rather than discarding it.
  useEffect(() => {
    if (!expired || submitting || questions.length === 0) return;
    if (escapeActive && escapeAvailable && escapeText.trim().length > 0) {
      void submitWith({ [FREEFORM_PAYLOAD_KEY]: escapeText.trim() });
      return;
    }
    // Start from whatever the user picked / typed, then backfill option 1 for
    // any question still untouched.
    const fallback = buildSubmitPayload(questions, picks, custom);
    for (const q of questions) {
      const key = getQuestionKey(q);
      if (q.required !== false && fallback[key] == null && q.options.length > 0) {
        const first = q.options[0].label;
        fallback[key] = q.multiSelect ? [first] : first;
      }
    }
    void submitWith(fallback);
  }, [
    expired,
    submitting,
    questions,
    escapeActive,
    escapeAvailable,
    escapeText,
    picks,
    custom,
    submitWith,
  ]);

  const activeQuestion = questions[Number(activeTab)] ?? questions[0];
  const isSubmitDisabled =
    questions.length === 0 ||
    (inEscape
      ? !escapeText.trim() || submitting || expired
      : !allRequiredAnswered || expired || submitting);

  return {
    activeQuestion,
    activeTab,
    custom,
    description,
    escapeActive: inEscape,
    escapeAvailable,
    escapeText,
    expired,
    handleCustomChange,
    handleEscapeTextChange,
    handleSkip,
    handleSubmit,
    handleToggle,
    isMulti: questions.length > 1,
    isSubmitDisabled,
    picks,
    questions,
    remainingMs: deadline - now,
    setActiveTab,
    setEscapeMode,
    submitting,
  };
};
