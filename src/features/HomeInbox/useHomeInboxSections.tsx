import { Flexbox } from '@lobehub/ui';
import { Segmented } from '@lobehub/ui/base-ui';
import { createStaticStyles, cx } from 'antd-style';
import { type ReactNode, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useWorkspaceMemberProfiles } from '@/business/client/hooks/useWorkspaceMemberProfiles';
import AsyncError from '@/components/AsyncError';
import { BriefCardSkeleton } from '@/features/DailyBrief/BriefCardSkeleton';
import { homeType } from '@/features/Home/components/homeType';
import { useRecommendationsSettled, useRecommendationsVisible } from '@/features/Recommendations';
import { useCacheScope } from '@/libs/swr/useCacheScope';
import { useBriefStore } from '@/store/brief';
import { briefListSelectors } from '@/store/brief/selectors';
import { useHomeStore } from '@/store/home';
import { homeInboxScopeSelectors } from '@/store/home/selectors';
import { useUserStore } from '@/store/user';
import { authSelectors, userProfileSelectors } from '@/store/user/slices/auth/selectors';

import { resolveHomeInboxHasContent, resolveHomeInboxHasResolved } from './homeInboxHasContent';
import InboxBriefCard from './InboxBriefCard';
import MarkAllReadButton from './MarkAllReadButton';
import NeedsYouRailCard from './NeedsYouRailCard';
import NewsList from './NewsList';
import { ownsRailSections } from './railSectionPlacement';
import RunningTasksCard from './RunningTasksCard';
import { filterTopicsForInboxScope, resolveScopeToggleSection } from './scopeTogglePlacement';
import { splitBriefs } from './splitBriefs';
import UnreadTopicList from './UnreadTopicList';
import { useHomeInboxTopics } from './useHomeInboxTopics';

const styles = createStaticStyles(({ css, cssVar }) => ({
  onlyMe: css`
    margin-inline-start: 8px;
    padding-inline: 5px;
    border-radius: 3px;
    background: ${cssVar.colorFillQuaternary};
  `,
}));

export interface InboxSection {
  /** Header action revealed on hover (GroupBlock's action slot). */
  action?: ReactNode;
  actionAlwaysVisible?: boolean;
  /** Trailing marker on the heading, e.g. the team-view "only mine" chip. */
  badge?: ReactNode;
  count?: number;
  key: string;
  /** Omitted when the section labels itself (the running card names its own count). */
  label?: string;
  node: ReactNode;
  /** Section carries its own card shell — the rail renders it verbatim. */
  selfShelled?: boolean;
  subtitle?: string;
}

export interface UseHomeInboxSectionsOptions {
  hideNeedsYou?: boolean;
  hideUnread?: boolean;
  /**
   * Main column only: the rail is collapsed, so the sections it owns (running,
   * news) fold into this column instead of disappearing with it.
   */
  inlineRail?: boolean;
  variant?: 'default' | 'main' | 'rail';
}

export interface HomeInboxSectionsResult {
  briefsError: unknown;
  hasContent: boolean;
  hasResolved: boolean;
  recommendationsVisible: boolean;
  retryBriefs: () => void;
  sections: InboxSection[];
  status: 'loading' | 'error' | 'ready';
}

/**
 * The home inbox: everything the agents did while you were away, sorted by
 * whether it needs you.
 *
 * - **Needs you** — briefs blocking an agent (decide / fix). Errors sink to the
 *   bottom: a stuck decision blocks work right now, a failed run has already
 *   stopped.
 * - **Unread** — runs that finished while you were away, each showing the agent's
 *   last reply so the answer is right there.
 * - **Running** — collapsed to one line, showing who is working; a healthy run
 *   needs nothing from you.
 * - **News** — `insight` + `result` briefs (reports of finished work); read them
 *   or don't.
 *
 * **Workspace mode** adds a mine/team split, but only over the sections it can
 * honestly widen. Topics are workspace-shared, so the unread + running feeds
 * already carry every member's runs — the toggle filters them by triggerer, and
 * team view tags each row with whose it is. Briefs are per-user by a deliberate
 * ownership rule (a member never sees another's brief), so Needs-you and News
 * stay mine in both views; team view marks News as such rather than pretending.
 *
 * Sections are siblings, never nested: each names itself and carries its own
 * count, and one absent section never hides another's heading.
 */
export const useHomeInboxSections = ({
  hideNeedsYou,
  hideUnread,
  inlineRail,
  variant = 'default',
}: UseHomeInboxSectionsOptions): HomeInboxSectionsResult => {
  const isRail = variant === 'rail';
  const isMain = variant === 'main';
  const showRailSections = ownsRailSections({ inlineRail, variant });
  const { t } = useTranslation('home');
  const isLogin = useUserStore(authSelectors.isLogin);
  const myId = useUserStore(userProfileSelectors.userId);

  // Briefs are per-user AND per-workspace rows, so the feed is read through the
  // active cache scope — a list left over from the previous workspace holds ids
  // this one cannot resolve, and every action on it would fail silently.
  const cacheScope = useCacheScope();
  const useFetchBriefs = useBriefStore((s) => s.useFetchBriefs);
  const briefsSWR = useFetchBriefs(isLogin, cacheScope);
  const briefs = useBriefStore(briefListSelectors.briefs(cacheScope));
  const isBriefsInit = useBriefStore(briefListSelectors.isBriefsInit(cacheScope));

  const topics = useHomeInboxTopics(isLogin);
  const recommendationsVisible = useRecommendationsVisible();
  const isRecommendationsSettled = useRecommendationsSettled();

  // A team context is a workspace with more than the viewer in it. In personal
  // mode this map is empty, so `isTeam` is false and the whole mine/team layer
  // stays dark — the inbox is byte-for-byte the personal one.
  const memberProfiles = useWorkspaceMemberProfiles();
  const isTeam = memberProfiles.size > 1;

  const scope = useHomeStore(homeInboxScopeSelectors.homeInboxScope);
  const setScope = useHomeStore((s) => s.setHomeInboxScope);
  const teamView = isTeam && scope === 'team';

  const { needsYou, news } = useMemo(() => splitBriefs(briefs), [briefs]);

  // Topics are already workspace-wide from the server; "mine" is the viewer's
  // own runs, "team" is everyone's. Personal mode has only the viewer's, so the
  // filter is a no-op there.
  const unreadTopics = useMemo(
    () => filterTopicsForInboxScope(topics.unread, myId, teamView),
    [teamView, topics.unread, myId],
  );
  const runningTopics = useMemo(
    () => filterTopicsForInboxScope(topics.running, myId, teamView),
    [teamView, topics.running, myId],
  );

  const retryBriefs = () => {
    void briefsSWR.mutate();
  };

  const status: HomeInboxSectionsResult['status'] = (() => {
    if (!isMain && briefsSWR.error && !isBriefsInit && !briefsSWR.isLoading) return 'error';
    if (!isMain && !isBriefsInit) return 'loading';
    return 'ready';
  })();

  const buildSections = (): { sections: InboxSection[] } => {
    const sections: InboxSection[] = [];

    // Mine/team lives at page level (governs the topic sections), so it rides on
    // the first titled section's header — the primary "Needs you", or Unread when
    // there's nothing to handle. Only shown in a team workspace.
    const scopeToggle = isTeam ? (
      <Segmented
        size={'small'}
        value={scope}
        options={[
          { label: t('inbox.scope.mine'), value: 'mine' },
          { label: t('inbox.scope.team'), value: 'team' },
        ]}
        onChange={(value) => setScope(value as 'mine' | 'team')}
      />
    ) : undefined;
    const toggleSectionKey = scopeToggle
      ? resolveScopeToggleSection({
          hasNeedsYou: !hideNeedsYou && needsYou.length > 0,
          hasRunning: runningTopics.length > 0,
          hasUnread: !hideUnread && unreadTopics.length > 0,
          preferUnread: isMain,
        })
      : null;
    const placeToggle = (key: typeof toggleSectionKey): ReactNode =>
      key === toggleSectionKey ? scopeToggle : undefined;

    if (!isMain && !hideNeedsYou && needsYou.length > 0)
      sections.push(
        // The rail paginates instead of stacking and owns its header. Keep the
        // page-level scope control in that header alongside the pager.
        isRail
          ? {
              actionAlwaysVisible: 'needsYou' === toggleSectionKey,
              key: 'needsYou',
              node: <NeedsYouRailCard briefs={needsYou} scopeControl={placeToggle('needsYou')} />,
              selfShelled: true,
            }
          : {
              action: placeToggle('needsYou'),
              actionAlwaysVisible: 'needsYou' === toggleSectionKey,
              count: needsYou.length,
              key: 'needsYou',
              label: t('inbox.needsYou.title'),
              node: (
                <Flexbox gap={12}>
                  {needsYou.map((brief) => (
                    <InboxBriefCard brief={brief} key={brief.id} />
                  ))}
                </Flexbox>
              ),
            },
      );

    // A topic-feed failure must not be silent: without this the unread / running
    // sections would just vanish and the inbox would look empty-but-fine.
    if (topics.error)
      sections.push({
        key: 'topics-error',
        label: t('inbox.unread.title'),
        node: <AsyncError error={topics.error} variant={'inline'} onRetry={topics.reload} />,
      });

    if (!hideUnread && unreadTopics.length > 0)
      sections.push({
        action: placeToggle('unread'),
        actionAlwaysVisible: 'unread' === toggleSectionKey,
        count: unreadTopics.length,
        key: 'unread',
        label: t('inbox.unread.title'),
        node: (
          <UnreadTopicList
            bare={isRail}
            showAuthor={teamView}
            topics={unreadTopics}
            onFollowUpSent={topics.promoteToRunning}
          />
        ),
      });

    if (isMain) {
      if (briefsSWR.error && !isBriefsInit && !briefsSWR.isLoading) {
        sections.push({
          key: 'needsYou-error',
          label: t('inbox.needsYou.title'),
          node: (
            <AsyncError
              error={briefsSWR.error}
              variant={'inline'}
              onRetry={() => void briefsSWR.mutate()}
            />
          ),
        });
      } else if (!isBriefsInit) {
        sections.push({ key: 'needsYou-loading', node: <BriefCardSkeleton /> });
      } else if (!hideNeedsYou && needsYou.length > 0) {
        sections.push({
          action: placeToggle('needsYou'),
          actionAlwaysVisible: 'needsYou' === toggleSectionKey,
          count: needsYou.length,
          key: 'needsYou',
          label: t('inbox.needsYou.title'),
          node: (
            <Flexbox gap={12}>
              {needsYou.map((brief) => (
                <InboxBriefCard brief={brief} key={brief.id} />
              ))}
            </Flexbox>
          ),
        });
      }
    }

    // No title: the card already says "3 tasks running" on its own head.
    if (showRailSections && runningTopics.length > 0)
      sections.push({
        actionAlwaysVisible: 'running' === toggleSectionKey,
        key: 'running',
        node: (
          <RunningTasksCard
            action={placeToggle('running')}
            bare={isRail}
            running={runningTopics}
            showAuthor={teamView}
          />
        ),
      });

    if (showRailSections && news.length > 0)
      sections.push({
        action: <MarkAllReadButton news={news} />,
        // Team view: News is still only mine (briefs are per-user), so say so
        // rather than let a team-scoped page imply it spans the team.
        badge: teamView && (
          <span className={cx(homeType.meta, styles.onlyMe)}>{t('inbox.scope.onlyMe')}</span>
        ),
        count: news.length,
        key: 'news',
        label: t('inbox.news.title'),
        node: <NewsList bare={isRail} news={news} />,
        subtitle: t('inbox.news.subtitle'),
      });

    return { sections };
  };

  const { sections } = status === 'ready' ? buildSections() : { sections: [] };

  const hasContent = resolveHomeInboxHasContent({
    isMain,
    recommendationsVisible,
    sectionsCount: sections.length,
    status,
  });

  const hasResolved = resolveHomeInboxHasResolved({
    isRecommendationsSettled,
    isTopicsInit: topics.isInit,
    status,
  });

  return {
    briefsError: status === 'error' ? briefsSWR.error : undefined,
    hasContent,
    hasResolved,
    recommendationsVisible,
    retryBriefs,
    sections,
    status,
  };
};

// Deliberately no `inlineRail` here: `ownsRailSections({ variant: 'rail' })`
// short-circuits to `true` on the `variant !== 'main'` branch regardless of
// `inlineRail`, so this predicate's `hasContent` can never be a function of
// the collapsed state it's about to decide — the cycle that would create is
// exactly what would make the rail flicker between collapsing and expanding
// itself. When `hasContent` is `false`, the running/news sections that fold
// into the main column instance are therefore necessarily empty too: that
// instance reads the same briefs (`cacheScope`), the same topics, and the
// same shared `scope` (`useHomeStore`) as this one, so whatever emptied out
// the rail's own copy is already reflected there. This constant exists so
// the predicate instance (`Home/index.tsx`) and the rendered rail (the
// `<HomeInbox {...}>` in the aside) can never receive different options —
// `hasContent` measures exactly what renders only as long as both spread
// this one object.
export const HOME_RAIL_INBOX_OPTIONS = {
  hideNeedsYou: true,
  hideUnread: true,
  variant: 'rail',
} as const;

export const useHomeRailHasContent = (): boolean =>
  useHomeInboxSections(HOME_RAIL_INBOX_OPTIONS).hasContent;
