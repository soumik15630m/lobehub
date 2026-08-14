import { type ReactElement } from 'react';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { ViteReactSSG } from 'vite-react-ssg/single-page';

import BootErrorBoundary from '@/components/BootErrorBoundary';
import SignIn from '@/features/Auth/SignIn';
import SignUp from '@/features/Auth/SignUp';
import NextThemeProvider from '@/layout/GlobalProvider/NextThemeProvider';
import { parseSSOProviders } from '@/libs/better-auth/utils/server';
import { authRoutes } from '@/spa/router/authRouter.config';
import { type AuthSPAServerConfig } from '@/types/spaServerConfig';

import { getStyleCollector } from './getStyleCollector';

let activeSsgRoute = '/en-US/signin';

const readBooleanEnv = (value?: string) => value === '1' || value === 'true';

const getAuthSsgServerConfig = (): AuthSPAServerConfig => ({
  analyticsConfig: {},
  config: {
    aiProvider: {},
    disableEmailPassword: readBooleanEnv(process.env.AUTH_DISABLE_EMAIL_PASSWORD),
    enableBusinessFeatures: false,
    enableEmailVerification: readBooleanEnv(process.env.AUTH_EMAIL_VERIFICATION),
    enableMagicLink: readBooleanEnv(process.env.AUTH_ENABLE_MAGIC_LINK),
    enableMarketTrustedClient: Boolean(
      process.env.MARKET_TRUSTED_CLIENT_SECRET && process.env.MARKET_TRUSTED_CLIENT_ID,
    ),
    oAuthSSOProviders: parseSSOProviders(process.env.AUTH_SSO_PROVIDERS),
    telemetry: {},
  },
  enableOIDC: readBooleanEnv(process.env.ENABLE_OIDC),
  featureFlags: {},
  globalCDN: readBooleanEnv(process.env.CDN_USE_GLOBAL),
});

const resolveRoute = () => {
  const [, locale = 'en-US', route = 'signin'] = activeSsgRoute.split('/');

  return {
    locale,
    pathname: `/${route}`,
    route,
  };
};

const createSsgRoutes = (route: string, page: ReactElement) =>
  authRoutes.map((rootRoute) => ({
    ...rootRoute,
    children: rootRoute.children?.map((childRoute) =>
      childRoute.path === route ? { ...childRoute, element: page } : childRoute,
    ),
  }));

const AuthSsgApp = () => {
  const { pathname, route } = resolveRoute();
  const page = route === 'signup' ? <SignUp /> : <SignIn />;
  const router = createMemoryRouter(createSsgRoutes(route, page), {
    initialEntries: [pathname],
  });

  return (
    <BootErrorBoundary>
      <NextThemeProvider>
        <RouterProvider router={router} />
      </NextThemeProvider>
    </BootErrorBoundary>
  );
};

export const createRoot = ViteReactSSG(
  <AuthSsgApp />,
  ({ routePath }) => {
    if (!routePath) return;

    activeSsgRoute = routePath || activeSsgRoute;

    const { locale } = resolveRoute();
    const serverConfig = getAuthSsgServerConfig();

    if (typeof document === 'undefined') {
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: {
          addEventListener: () => {},
          cookie: '',
          body: { scrollLeft: 0, scrollTop: 0 },
          documentElement: { lang: locale, scrollLeft: 0, scrollTop: 0 },
          removeEventListener: () => {},
        },
        writable: true,
      });
    } else {
      document.documentElement.lang = locale;
    }

    if (typeof localStorage === 'undefined') {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
          getItem: () => null,
          removeItem: () => {},
          setItem: () => {},
        },
        writable: true,
      });
    }

    if (typeof window === 'undefined') {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: {
          __SERVER_CONFIG__: serverConfig,
          addEventListener: () => {},
          innerWidth: 1280,
          location: { href: '', pathname: `/${resolveRoute().route}`, search: '' },
          matchMedia: globalThis.matchMedia,
          removeEventListener: () => {},
          requestAnimationFrame: () => 0,
        },
        writable: true,
      });
    } else {
      window.__SERVER_CONFIG__ = serverConfig;
    }
  },
  { getStyleCollector },
);
