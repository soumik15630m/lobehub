import { getServerDB } from '@lobechat/database';
import { getUserAuth } from '@lobechat/utils/server';

import type { OIDCProvider } from '@/libs/oidc-provider/provider';
import type { OIDCSessionReconciliationResult } from '@/libs/oidc-provider/session-cleanup';
import { reconcileCurrentOIDCSession } from '@/libs/oidc-provider/session-cleanup';

import { OIDCService } from '.';

const AUTHORIZATION_PATH = /^\/oidc\/auth\/?$/;
const AUTHORIZATION_RESUME_PATH = /^\/oidc\/auth\/([^/]+)\/?$/;

type OIDCAccountGuardPath = 'authorization' | 'resume';
type OIDCRecoveryReason = Extract<
  OIDCSessionReconciliationResult,
  { status: 'recovered' }
>['reason'];

type OIDCAccountGuardResult =
  | {
      path: OIDCAccountGuardPath;
      status: 'matched' | 'missing' | 'missing_app_session' | 'missing_interaction';
    }
  | {
      path: OIDCAccountGuardPath;
      reason: OIDCRecoveryReason;
      status: 'recovered';
    };

interface GuardOIDCAuthorizationAccountParams {
  getCookie: (name: string) => string | null;
  pathname: string;
  provider: OIDCProvider;
}

type AuthorizationStage = { name: 'authorization' } | { name: 'resume'; uid: string };

const getAuthorizationStage = (pathname: string): AuthorizationStage | null => {
  if (AUTHORIZATION_PATH.test(pathname)) return { name: 'authorization' };

  const resumeMatch = AUTHORIZATION_RESUME_PATH.exec(pathname);
  return resumeMatch ? { name: 'resume', uid: resumeMatch[1] } : null;
};

/**
 * Verifies that the active application account owns the OIDC authorization session.
 */
export const guardOIDCAuthorizationAccount = async ({
  getCookie,
  pathname,
  provider,
}: GuardOIDCAuthorizationAccountParams): Promise<OIDCAccountGuardResult | null> => {
  const stage = getAuthorizationStage(pathname);
  if (!stage) return null;

  const { userId } = await getUserAuth();

  if (stage.name === 'resume') {
    if (!userId) return { path: stage.name, status: 'missing_app_session' };

    try {
      const status = await new OIDCService(provider).reconcileInteractionAccount(stage.uid, userId);

      return status === 'recovered'
        ? { path: stage.name, reason: 'account_mismatch', status }
        : { path: stage.name, status };
    } catch (error) {
      /**
       * An expired interaction is a normal browser timeout. The provider callback owns its
       * standard invalid-request response, so it must not become an account-guard outage.
       */
      if (error instanceof Error && error.name === 'SessionNotFound') {
        return { path: stage.name, status: 'missing_interaction' };
      }
      throw error;
    }
  }

  const db = await getServerDB();
  const result = await reconcileCurrentOIDCSession(db, userId, { getCookie });

  if (result.status === 'unverified') {
    return { path: stage.name, status: 'missing_app_session' };
  }

  return { path: stage.name, ...result };
};
