/**
 * @vitest-environment happy-dom
 */
import type { ConversationContext, UIChatMessage } from '@lobechat/types';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { messageMapKey } from '@/store/chat/utils/messageMapKey';

import ChatList from './ChatList';
import { ConversationProvider } from './ConversationProvider';
import { dataSelectors, useConversationStore, useConversationStoreApi } from './store';

const chatListMocks = vi.hoisted(() => ({
  isStreaming: false,
  refreshError: {
    error: undefined as unknown,
    isRetrying: false,
    retry: vi.fn(),
  },
  swrMutate: vi.fn(),
  useFetchAgentConfig: vi.fn(),
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({
    children,
    disabled,
    onClick,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) => (
    <button disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/features/Conversation/ChatList/components/AgentSignalReceiptList', () => ({
  default: () => null,
}));

vi.mock('@/features/Conversation/ChatList/components/VirtualizedList', () => ({
  default: ({ dataSource }: { dataSource: string[] }) => (
    <div data-testid={'virtualized-list'}>{dataSource.join(',')}</div>
  ),
}));

vi.mock('@/features/Conversation/ChatList/hooks/useAgentSignalReceipts', () => ({
  useAgentSignalReceipts: () => ({ receiptsByAnchor: new Map() }),
}));

vi.mock('@/features/Conversation/ChatList/hooks/useMessageRefreshError', () => ({
  useMessageRefreshError: () => chatListMocks.refreshError,
}));

vi.mock('@/features/Conversation/components/SkeletonList', () => ({
  default: () => <div data-testid={'skeleton-list'} />,
}));

vi.mock('@/features/Conversation/Messages', () => ({
  default: ({ id }: { id: string }) => <div>{id}</div>,
}));

vi.mock('@/features/Conversation/Messages/Contexts/MessageActionProvider', () => ({
  MessageActionProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

vi.mock('@/features/WideScreenContainer', () => ({
  default: ({ children, style }: { children?: ReactNode; style?: React.CSSProperties }) => (
    <div data-testid={'welcome'} style={style}>
      {children}
    </div>
  ),
}));

vi.mock('@/hooks/useFetchAvailableAgents', () => ({ useFetchAvailableAgents: vi.fn() }));
vi.mock('@/hooks/useFetchMemoryForTopic', () => ({ useFetchTopicMemories: vi.fn() }));
vi.mock('@/hooks/useFetchNotebookDocuments', () => ({ useFetchNotebookDocuments: vi.fn() }));

vi.mock('@/libs/swr', () => ({
  useClientDataSWRWithSync: () => ({
    data: undefined,
    error: undefined,
    isLoading: false,
    isValidating: false,
    mutate: chatListMocks.swrMutate,
  }),
}));

vi.mock('@/libs/swr/useCacheScope', () => ({
  getCacheScope: () => 'user-1:personal',
}));

vi.mock('@/store/agent', () => ({
  useAgentStore: (
    selector: (state: { useFetchAgentConfig: typeof chatListMocks.useFetchAgentConfig }) => unknown,
  ) => selector({ useFetchAgentConfig: chatListMocks.useFetchAgentConfig }),
}));

vi.mock('@/store/chat', () => ({
  getChatStoreState: () => ({}),
  useChatStore: (selector: (state: { activeAgentId: string }) => unknown) =>
    selector({ activeAgentId: 'agt_old' }),
}));

vi.mock('@/store/chat/selectors', () => ({
  operationSelectors: {
    isAgentRuntimeRunningByContext: () => () => chatListMocks.isStreaming,
  },
}));

vi.mock('@/store/serverConfig', () => ({
  featureFlagsSelectors: vi.fn(),
  useServerConfigStore: () => ({ enableAgentSelfIteration: false }),
}));

vi.mock('@/store/user', () => ({ useUserStore: () => false }));
vi.mock('@/store/user/selectors', () => ({ authSelectors: {}, settingsSelectors: {} }));

const oldContext = {
  agentId: 'agt_old',
  threadId: null,
  topicId: 'tpc_old',
} satisfies ConversationContext;

const nextContext = {
  agentId: 'agt_next',
  threadId: null,
  topicId: null,
} satisfies ConversationContext;

const oldMessages = [
  {
    content: 'old message',
    createdAt: 1,
    id: 'msg_old',
    role: 'user',
    updatedAt: 1,
  },
] as UIChatMessage[];

interface Snapshot {
  actualContextKey: string;
  displayMessageIds: string[];
  expectedContextKey: string;
}

const Probe = ({
  expectedContext,
  snapshots,
}: {
  expectedContext: ConversationContext;
  snapshots: Snapshot[];
}) => {
  const context = useConversationStore((s) => s.context);
  const displayMessageIds = useConversationStore(dataSelectors.displayMessageIds);

  snapshots.push({
    actualContextKey: messageMapKey(context),
    displayMessageIds,
    expectedContextKey: messageMapKey(expectedContext),
  });

  return null;
};

/**
 * Records one entry per distinct ConversationStore instance, so a test can tell
 * a re-render (same store) from a remount (fresh store). Remounting is what
 * tears the virtualized message list down and repaints it from an empty
 * viewport — the DOM-level half of the first-send flicker, which a
 * React-commit-level assertion cannot observe.
 */
const StoreIdentityProbe = ({ stores }: { stores: unknown[] }) => {
  const storeApi = useConversationStoreApi();
  const context = useConversationStore((s) => s.context);

  if (stores.at(-1) !== storeApi) stores.push(storeApi);

  return <div data-testid="store-context-key">{messageMapKey(context)}</div>;
};

/**
 * Arms a scheduled send, then reports whether it is still armed. Scheduled send
 * is per-conversation state that only a remount clears — `StoreUpdater` resets
 * context and message fields, not the composer.
 */
const ScheduledSendProbe = () => {
  const scheduledSendAt = useConversationStore((s) => s.scheduledSendAt);
  const setScheduledSendAt = useConversationStore((s) => s.setScheduledSendAt);

  return (
    <div>
      <button onClick={() => setScheduledSendAt('2026-01-01T00:00:00.000Z')}>arm</button>
      <div data-testid="scheduled-send-at">{scheduledSendAt ?? 'none'}</div>
    </div>
  );
};

const OverlayHeightSetter = () => {
  const setChatInputOverlayHeight = useConversationStore((s) => s.setChatInputOverlayHeight);

  return <button onClick={() => setChatInputOverlayHeight(48)}>set overlay height</button>;
};

const renderChatList = (messages?: UIChatMessage[]) =>
  render(
    <ConversationProvider
      context={oldContext}
      hasInitMessages={messages !== undefined}
      messages={messages}
    >
      <ChatList welcome={<div>WELCOME</div>} />
    </ConversationProvider>,
  );

describe('ConversationProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chatListMocks.isStreaming = false;
    chatListMocks.refreshError.error = undefined;
    chatListMocks.refreshError.isRetrying = false;
  });

  it('does not expose the previous local conversation store after context changes', () => {
    const snapshots: Snapshot[] = [];

    const { rerender } = render(
      <ConversationProvider hasInitMessages context={oldContext} messages={oldMessages}>
        <Probe expectedContext={oldContext} snapshots={snapshots} />
      </ConversationProvider>,
    );

    rerender(
      <ConversationProvider context={nextContext} hasInitMessages={false}>
        <Probe expectedContext={nextContext} snapshots={snapshots} />
      </ConversationProvider>,
    );

    const mismatchedNextContextSnapshots = snapshots.filter(
      (snapshot) =>
        snapshot.expectedContextKey === messageMapKey(nextContext) &&
        snapshot.actualContextKey !== snapshot.expectedContextKey,
    );

    expect(mismatchedNextContextSnapshots).toEqual([]);
  });

  it('keeps the same store when a new conversation materializes its topic', () => {
    const stores: unknown[] = [];
    const newChatContext = {
      agentId: 'agt_old',
      threadId: null,
      topicId: null,
    } satisfies ConversationContext;
    const materializedContext = {
      agentId: 'agt_old',
      threadId: null,
      topicId: 'tpc_created',
    } satisfies ConversationContext;

    const { rerender } = render(
      <ConversationProvider hasInitMessages context={newChatContext} messages={[]}>
        <StoreIdentityProbe stores={stores} />
      </ConversationProvider>,
    );

    rerender(
      <ConversationProvider
        hasInitMessages
        context={materializedContext}
        materializedTopicId={'tpc_created'}
        messages={oldMessages}
      >
        <StoreIdentityProbe stores={stores} />
      </ConversationProvider>,
    );

    // A remount here resets virtua and paints an empty list for ~50ms — the
    // "all messages vanished then came back" flicker right after the first send.
    expect(stores).toHaveLength(1);
    // …and the surviving store still follows the freshly created topic.
    expect(screen.getByTestId('store-context-key')).toHaveTextContent(
      messageMapKey(materializedContext),
    );
  });

  it('creates a fresh store when navigating from a new chat to an existing topic', () => {
    const stores: unknown[] = [];
    const newChatContext = {
      agentId: 'agt_old',
      threadId: null,
      topicId: null,
    } satisfies ConversationContext;
    const existingTopicContext = {
      agentId: 'agt_old',
      threadId: null,
      topicId: 'tpc_existing',
    } satisfies ConversationContext;

    const { rerender } = render(
      <ConversationProvider hasInitMessages context={newChatContext} messages={[]}>
        <ScheduledSendProbe />
        <StoreIdentityProbe stores={stores} />
      </ConversationProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'arm' }));
    expect(screen.getByTestId('scheduled-send-at')).toHaveTextContent('2026-01-01T00:00:00.000Z');

    // Opening an unrelated topic from the sidebar is navigation, not this
    // send's topic materializing — `materializedTopicId` stays undefined.
    rerender(
      <ConversationProvider hasInitMessages context={existingTopicContext} messages={oldMessages}>
        <ScheduledSendProbe />
        <StoreIdentityProbe stores={stores} />
      </ConversationProvider>,
    );

    expect(stores).toHaveLength(2);
    // A send armed in the new chat must not stay armed in the topic the user
    // navigated to.
    expect(screen.getByTestId('scheduled-send-at')).toHaveTextContent('none');
  });

  it('creates a fresh store when switching between two persisted topics', () => {
    const stores: unknown[] = [];
    const firstTopic = {
      agentId: 'agt_old',
      threadId: null,
      topicId: 'tpc_a',
    } satisfies ConversationContext;
    const secondTopic = {
      agentId: 'agt_old',
      threadId: null,
      topicId: 'tpc_b',
    } satisfies ConversationContext;

    const { rerender } = render(
      <ConversationProvider hasInitMessages context={firstTopic} messages={oldMessages}>
        <StoreIdentityProbe stores={stores} />
      </ConversationProvider>,
    );

    rerender(
      <ConversationProvider hasInitMessages context={secondTopic} messages={[]}>
        <StoreIdentityProbe stores={stores} />
      </ConversationProvider>,
    );

    // Genuine conversation switches must stay isolated — no stale messages,
    // input or tool state carried across.
    expect(stores).toHaveLength(2);
  });

  it('renders the message skeleton before the first request settles', () => {
    renderChatList();

    expect(screen.getByTestId('skeleton-list')).toBeInTheDocument();
  });

  it('renders a retryable full-surface error when the first request fails', () => {
    chatListMocks.refreshError.error = new Error('offline');

    renderChatList();
    fireEvent.click(screen.getByRole('button', { name: 'error.retry' }));

    expect(chatListMocks.refreshError.retry).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('skeleton-list')).not.toBeInTheDocument();
  });

  it('preserves a settled empty welcome while showing a retryable background error', () => {
    chatListMocks.refreshError.error = new Error('offline');

    renderChatList([]);
    fireEvent.click(screen.getByRole('button', { name: 'error.retry' }));

    expect(screen.getByText('WELCOME')).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(chatListMocks.refreshError.retry).toHaveBeenCalledTimes(1);
  });

  it('reserves composer overlay space in the settled empty welcome', () => {
    const { container } = render(
      <ConversationProvider hasInitMessages context={oldContext} messages={[]}>
        <ChatList welcome={<div>WELCOME</div>} />
        <OverlayHeightSetter />
      </ConversationProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'set overlay height' }));

    expect(container.querySelector('[data-testid="welcome"]')).toHaveStyle({
      boxSizing: 'border-box',
      paddingBottom: '60px',
    });
  });

  it('renders a settled message list through the virtualized list', () => {
    renderChatList(oldMessages);

    expect(screen.getByTestId('virtualized-list')).toHaveTextContent('msg_old');
  });
});
