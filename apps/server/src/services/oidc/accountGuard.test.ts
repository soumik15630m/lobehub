import type { LobeChatDatabase } from '@lobechat/database';
import { getServerDB } from '@lobechat/database';
import { getUserAuth } from '@lobechat/utils/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OIDCProvider } from '@/libs/oidc-provider/provider';
import { reconcileCurrentOIDCSession } from '@/libs/oidc-provider/session-cleanup';

import { OIDCService } from '.';
import { guardOIDCAuthorizationAccount } from './accountGuard';

vi.mock('@lobechat/database', () => ({
  getServerDB: vi.fn(),
}));

vi.mock('@lobechat/utils/server', () => ({
  getUserAuth: vi.fn(),
}));

vi.mock('@/libs/oidc-provider/session-cleanup', () => ({
  reconcileCurrentOIDCSession: vi.fn(),
}));

const provider = { id: 'provider' } as unknown as OIDCProvider;
const serverDB = { id: 'server-db' } as unknown as LobeChatDatabase;

describe('guardOIDCAuthorizationAccount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getUserAuth).mockResolvedValue({ betterAuth: null, userId: 'user-b' });
    vi.mocked(getServerDB).mockResolvedValue(serverDB);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ignores requests outside the authorization flow', async () => {
    const result = await guardOIDCAuthorizationAccount({
      getCookie: vi.fn(),
      pathname: '/oidc/token',
      provider,
    });

    expect(result).toBeNull();
    expect(getUserAuth).not.toHaveBeenCalled();
    expect(getServerDB).not.toHaveBeenCalled();
  });

  it('allows first-time authorization without an OIDC session', async () => {
    vi.mocked(reconcileCurrentOIDCSession).mockResolvedValueOnce({ status: 'missing' });

    const result = await guardOIDCAuthorizationAccount({
      getCookie: vi.fn(() => null),
      pathname: '/oidc/auth',
      provider,
    });

    expect(result).toEqual({ path: 'authorization', status: 'missing' });
    expect(getUserAuth).toHaveBeenCalledOnce();
    expect(getServerDB).toHaveBeenCalledOnce();
  });

  it('blocks an existing OIDC session when the application session is missing', async () => {
    vi.mocked(getUserAuth).mockResolvedValueOnce({ betterAuth: null, userId: undefined });
    vi.mocked(reconcileCurrentOIDCSession).mockResolvedValueOnce({ status: 'unverified' });

    const result = await guardOIDCAuthorizationAccount({
      getCookie: vi.fn((name) => (name === '_session' ? 'oidc-session-a' : null)),
      pathname: '/oidc/auth',
      provider,
    });

    expect(result).toEqual({ path: 'authorization', status: 'missing_app_session' });
    expect(getServerDB).toHaveBeenCalledOnce();
  });

  it.each(['dangling_session', 'expired_session', 'invalid_cookie'] as const)(
    'recovers a stale %s without requiring an application session',
    async (reason) => {
      vi.mocked(getUserAuth).mockResolvedValueOnce({ betterAuth: null, userId: undefined });
      vi.mocked(reconcileCurrentOIDCSession).mockResolvedValueOnce({
        reason,
        status: 'recovered',
      });

      const result = await guardOIDCAuthorizationAccount({
        getCookie: vi.fn(),
        pathname: '/oidc/auth',
        provider,
      });

      expect(result).toEqual({ path: 'authorization', reason, status: 'recovered' });
    },
  );

  it('reconciles the persisted session at authorization entry', async () => {
    vi.mocked(reconcileCurrentOIDCSession).mockResolvedValueOnce({
      reason: 'account_mismatch',
      status: 'recovered',
    });
    const getCookie = vi.fn((name) => (name === '_session' ? 'oidc-session-a' : null));

    const result = await guardOIDCAuthorizationAccount({
      getCookie,
      pathname: '/oidc/auth',
      provider,
    });

    expect(result).toEqual({
      path: 'authorization',
      reason: 'account_mismatch',
      status: 'recovered',
    });
    expect(reconcileCurrentOIDCSession).toHaveBeenCalledWith(serverDB, 'user-b', { getCookie });
  });

  it('replaces a mismatched account when authorization resumes', async () => {
    vi.spyOn(OIDCService.prototype, 'reconcileInteractionAccount').mockResolvedValueOnce(
      'recovered',
    );

    const result = await guardOIDCAuthorizationAccount({
      getCookie: vi.fn(),
      pathname: '/oidc/auth/interaction-1',
      provider,
    });

    expect(result).toEqual({
      path: 'resume',
      reason: 'account_mismatch',
      status: 'recovered',
    });
    expect(OIDCService.prototype.reconcileInteractionAccount).toHaveBeenCalledWith(
      'interaction-1',
      'user-b',
    );
    expect(getServerDB).not.toHaveBeenCalled();
  });

  it('lets oidc-provider handle an expired authorization interaction', async () => {
    const error = new Error('invalid_request');
    error.name = 'SessionNotFound';
    vi.spyOn(OIDCService.prototype, 'reconcileInteractionAccount').mockRejectedValueOnce(error);

    const result = await guardOIDCAuthorizationAccount({
      getCookie: vi.fn(),
      pathname: '/oidc/auth/interaction-1',
      provider,
    });

    expect(result).toEqual({ path: 'resume', status: 'missing_interaction' });
    expect(getServerDB).not.toHaveBeenCalled();
  });

  it('propagates unexpected interaction reconciliation errors', async () => {
    vi.spyOn(OIDCService.prototype, 'reconcileInteractionAccount').mockRejectedValueOnce(
      new Error('database unavailable'),
    );

    await expect(
      guardOIDCAuthorizationAccount({
        getCookie: vi.fn(),
        pathname: '/oidc/auth/interaction-1',
        provider,
      }),
    ).rejects.toThrow('database unavailable');
  });
});
