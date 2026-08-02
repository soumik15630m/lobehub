'use client';

import { type UIChatMessage } from '@lobechat/types';
import debug from 'debug';
import isEqual from 'fast-deep-equal';
import { type ReactNode } from 'react';
import { memo, useMemo, useRef } from 'react';

import { useFetchAvailableAgents } from '@/hooks/useFetchAvailableAgents';
import { messageMapKey } from '@/store/chat/utils/messageMapKey';

import AssistantTurnSettledWatcher from './AssistantTurnSettledWatcher';
import { createStore, Provider } from './store';
import StoreUpdater from './StoreUpdater';
import {
  type ActionsBarConfig,
  type ConversationContext,
  type ConversationHooks,
  type OperationState,
} from './types';

const log = debug('lobe-render:features:Conversation');

interface ConversationContextPrefetcherProps {
  context: ConversationContext;
}

const ConversationContextPrefetcher = memo<ConversationContextPrefetcherProps>(({ context }) => {
  useFetchAvailableAgents(!context.topicShareId && !!context.agentId);

  return null;
});

ConversationContextPrefetcher.displayName = 'ConversationContextPrefetcher';

export interface ConversationProviderProps {
  /**
   * Actions bar configuration by message type
   */
  actionsBar?: ActionsBarConfig;
  children: ReactNode;
  /**
   * Conversation context (data coordinates)
   */
  context: ConversationContext;
  /**
   * Whether external messages have been initialized
   * When false, ChatList will show skeleton loading state
   */
  hasInitMessages?: boolean;
  /**
   * Lifecycle hooks for external behavior injection
   */
  hooks?: ConversationHooks;
  /**
   * External messages to sync into the store
   * When provided, these messages will be used as the source of truth
   */
  /**
   * The topic id that the in-flight send just created for THIS conversation
   * (`chatStore.materializedTopicId`).
   *
   * Supplying it lets the provider keep its store — and therefore the
   * virtualized message list — mounted while `topicId: null` turns into that
   * id, instead of remounting and blanking the list for a frame.
   *
   * A `null → id` transition alone is NOT sufficient to infer this: opening any
   * existing topic from the new-chat view looks identical. So the host must
   * establish it, and when it cannot the provider falls back to remounting,
   * which is always correct (just visibly less smooth).
   */
  materializedTopicId?: string;
  messages?: UIChatMessage[];
  /**
   * Callback when messages are fetched or changed internally
   * Use this to sync messages back to external state (e.g., ChatStore)
   *
   * @param messages - The updated messages array
   * @param context - The context that this data belongs to (prevents race conditions)
   */
  onMessagesChange?: (messages: UIChatMessage[], context: ConversationContext) => void;
  /**
   * External operation state (from ChatStore)
   *
   * This state is managed by the global ChatStore and passed down for reactivity.
   * Operations are kept global to support multiple agents/topics running in parallel.
   *
   * When provided, this will be synced into the store for reactive updates.
   */
  operationState?: OperationState;
  skipFetch?: boolean;
}

/**
 * ConversationProvider
 *
 * Creates an isolated ConversationStore instance for a specific conversation context.
 * This enables multiple independent conversations to run simultaneously.
 */
export const ConversationProvider = memo<ConversationProviderProps>(
  ({
    actionsBar,
    children,
    context,
    hooks = {},
    hasInitMessages,
    materializedTopicId,
    messages,
    onMessagesChange,
    operationState,
    skipFetch,
  }) => {
    const contextKey = useMemo(() => messageMapKey(context), [context]);

    /**
     * Identity key for `<Provider>`.
     *
     * The store is keyed so a genuine conversation switch gets a fresh instance —
     * no stale messages / input / tool state leaking across conversations.
     *
     * A conversation that *materializes its topic*, though, is NOT a switch:
     * `topicId: null` → the id the server just created for this very send is the
     * same conversation gaining an id. Remounting there tears the virtualized
     * message list down and back up, and virtua re-measures from an empty
     * viewport — the list paints zero rows for ~50ms, which reads as "every
     * message vanished, then came back" right after the first send.
     *
     * Seeding the new store (`initialMessages`) fixes the React-data half of
     * that flicker but cannot help the DOM half, because the remount itself is
     * what resets the virtualizer. So absorb this one transition and keep the
     * subtree mounted; `StoreUpdater`'s pre-paint layout effect already handles
     * a context change within a mount.
     *
     * The shape of the transition is deliberately NOT the test. Opening any
     * existing topic from the new-chat view is also `topicId: null` → an id, and
     * absorbing that one would carry composer state — an armed `scheduledSendAt`,
     * the draft, message-edit and tool state — into an unrelated conversation,
     * because `StoreUpdater` resets only the context and message fields. So the
     * host must name the id its send just created; without that, remount.
     */
    const providerKeyRef = useRef(contextKey);
    const prevContextKeyRef = useRef(contextKey);
    if (prevContextKeyRef.current !== contextKey) {
      const newChatKey = messageMapKey({ ...context, topicId: null });
      const isTopicMaterialization =
        !!context.topicId &&
        context.topicId === materializedTopicId &&
        prevContextKeyRef.current === newChatKey;

      if (!isTopicMaterialization) providerKeyRef.current = contextKey;
      prevContextKeyRef.current = contextKey;
    }
    const providerKey = providerKeyRef.current;

    log(
      '[Provider] render | contextKey=%s | messagesCount=%d | hasInitMessages=%s | skipFetch=%s',
      contextKey,
      messages?.length ?? 0,
      hasInitMessages,
      skipFetch,
    );

    return (
      <Provider
        createStore={() => createStore({ context, hooks, initialMessages: messages, skipFetch })}
        key={providerKey}
      >
        <StoreUpdater
          actionsBar={actionsBar}
          context={context}
          hasInitMessages={hasInitMessages}
          hooks={hooks}
          messages={messages}
          operationState={operationState}
          skipFetch={skipFetch}
          onMessagesChange={onMessagesChange}
        />
        <AssistantTurnSettledWatcher />
        <ConversationContextPrefetcher context={context} />
        {children}
      </Provider>
    );
  },
  isEqual,
);

ConversationProvider.displayName = 'ConversationProvider';
