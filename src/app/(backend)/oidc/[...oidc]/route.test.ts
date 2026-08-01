/**
 * @vitest-environment node
 */
import type { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  accountGuardModuleLoaded: vi.fn(),
  authEnv: {
    ENABLE_OIDC: true,
  },
  createNodeRequest: vi.fn(),
  createNodeResponse: vi.fn(),
  getOIDCProvider: vi.fn(),
  guardOIDCAuthorizationAccount: vi.fn(),
  middleware: vi.fn(),
  providerCallback: vi.fn(),
}));

vi.mock('debug', () => ({
  default: () => vi.fn(),
}));

vi.mock('@/envs/auth', () => ({
  authEnv: mocks.authEnv,
}));

vi.mock('@/libs/oidc-provider/http-adapter', () => ({
  createNodeRequest: mocks.createNodeRequest,
  createNodeResponse: mocks.createNodeResponse,
}));

vi.mock('@/server/services/oidc/accountGuard', () => {
  mocks.accountGuardModuleLoaded();
  return {
    guardOIDCAuthorizationAccount: mocks.guardOIDCAuthorizationAccount,
  };
});

vi.mock('@/server/services/oidc/oidcProvider', () => ({
  getOIDCProvider: mocks.getOIDCProvider,
}));

describe('OIDC route', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    mocks.authEnv.ENABLE_OIDC = true;
    mocks.getOIDCProvider.mockResolvedValue({
      callback: mocks.providerCallback,
    });
    mocks.guardOIDCAuthorizationAccount.mockResolvedValue(null);
    mocks.providerCallback.mockReturnValue(mocks.middleware);
    mocks.middleware.mockImplementation(
      (_request: unknown, _response: unknown, next: (error?: Error) => void) => next(),
    );
    mocks.createNodeRequest.mockResolvedValue({});
    mocks.createNodeResponse.mockReturnValue({
      nodeResponse: {},
      responseBody: '',
      responseHeaders: {},
      responseStatus: 200,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads the account guard after OIDC is enabled', async () => {
    mocks.guardOIDCAuthorizationAccount.mockResolvedValueOnce({
      path: 'authorization',
      reason: 'account_mismatch',
      status: 'recovered',
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { GET } = await import('./route');
    const getCookie = vi.fn((name: string) =>
      name === '_session' ? { value: 'oidc-session-a' } : undefined,
    );
    const request = {
      cookies: { get: getCookie },
      method: 'GET',
      url: 'https://example.com/oidc/auth?client_id=client-1',
    } as unknown as NextRequest;

    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(mocks.accountGuardModuleLoaded).toHaveBeenCalledTimes(1);
    expect(mocks.guardOIDCAuthorizationAccount).toHaveBeenCalledWith({
      getCookie: expect.any(Function),
      pathname: '/oidc/auth',
      provider: expect.objectContaining({ callback: mocks.providerCallback }),
    });
    const { getCookie: readCookie } = mocks.guardOIDCAuthorizationAccount.mock.calls[0][0];
    expect(readCookie('_session')).toBe('oidc-session-a');
    expect(mocks.middleware).toHaveBeenCalledTimes(1);
  });

  it('continues first-time authorization without an OIDC session', async () => {
    mocks.guardOIDCAuthorizationAccount.mockResolvedValueOnce({
      path: 'authorization',
      status: 'missing',
    });

    const { GET } = await import('./route');
    const request = {
      cookies: { get: vi.fn() },
      method: 'GET',
      url: 'https://example.com/oidc/auth?client_id=client-1',
    } as unknown as NextRequest;

    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(mocks.providerCallback).toHaveBeenCalledTimes(1);
    expect(mocks.middleware).toHaveBeenCalledTimes(1);
  });

  it('does not load server account dependencies when OIDC is disabled', async () => {
    mocks.authEnv.ENABLE_OIDC = false;
    const { GET } = await import('./route');
    const request = {
      cookies: { get: vi.fn() },
      method: 'GET',
      url: 'https://example.com/oidc/auth',
    } as unknown as NextRequest;

    const response = await GET(request);

    expect(response.status).toBe(404);
    expect(mocks.accountGuardModuleLoaded).not.toHaveBeenCalled();
    expect(mocks.getOIDCProvider).not.toHaveBeenCalled();
  });

  it('redirects to sign-in when the application session is missing', async () => {
    mocks.guardOIDCAuthorizationAccount.mockResolvedValueOnce({
      path: 'authorization',
      status: 'missing_app_session',
    });

    const { GET } = await import('./route');
    const request = {
      cookies: { get: vi.fn() },
      method: 'GET',
      url: 'https://example.com/oidc/auth?client_id=client-1',
    } as unknown as NextRequest;

    const response = await GET(request);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      'https://example.com/signin?callbackUrl=%2Foidc%2Fauth%3Fclient_id%3Dclient-1',
    );
    expect(mocks.providerCallback).not.toHaveBeenCalled();
  });

  it('lets oidc-provider render the standard error for an expired interaction', async () => {
    mocks.guardOIDCAuthorizationAccount.mockResolvedValueOnce({
      path: 'resume',
      status: 'missing_interaction',
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { GET } = await import('./route');
    const request = {
      cookies: { get: vi.fn() },
      method: 'GET',
      url: 'https://example.com/oidc/auth/interaction-1',
    } as unknown as NextRequest;

    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(mocks.providerCallback).toHaveBeenCalledTimes(1);
    expect(mocks.middleware).toHaveBeenCalledTimes(1);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('fails closed when the authorization account check fails', async () => {
    mocks.guardOIDCAuthorizationAccount.mockRejectedValueOnce(new Error('auth unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { GET } = await import('./route');
    const request = {
      cookies: { get: vi.fn() },
      method: 'GET',
      url: 'https://example.com/oidc/auth?client_id=client-1',
    } as unknown as NextRequest;

    const response = await GET(request);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'temporarily_unavailable',
      error_description: 'OIDC authorization is temporarily unavailable',
    });
    expect(mocks.providerCallback).not.toHaveBeenCalled();
  });

  it('returns a 500 response when creating the Node request fails', async () => {
    mocks.createNodeRequest.mockRejectedValueOnce(new Error('body stream aborted'));

    const { POST } = await import('./route');
    const request = new Request('https://example.com/oidc/token', {
      body: 'grant_type=refresh_token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      method: 'POST',
    }) as unknown as NextRequest;

    const response = await Promise.race([
      POST(request),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('OIDC route timed out')), 50),
      ),
    ]);

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toContain('body stream aborted');
    expect(mocks.middleware).not.toHaveBeenCalled();
  });
});
