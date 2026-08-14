import { getServerFeatureFlagsValue } from '@/config/featureFlags';
import { appEnv } from '@/envs/app';
import { authEnv } from '@/envs/auth';
import { buildAnalyticsConfig, fetchViteDevTemplate, renderSpaHtml } from '@/libs/spaHtml';
import { type Locales, normalizeLocale } from '@/locales/resources';
import { getServerAuthConfig } from '@/server/globalConfig/getServerAuthConfig';
import { type AuthSPAServerConfig } from '@/types/spaServerConfig';

import { selectAuthSpaTemplate } from '../../selectAuthSpaTemplate';
import { buildSeoMeta } from './seoMeta';

export function generateStaticParams() {
  const staticLocales: Locales[] = ['en-US', 'zh-CN'];

  return staticLocales.map((locale) => ({ locale }));
}

const isDev = process.env.NODE_ENV === 'development';

async function getTemplate(locale: Locales, pathname: string): Promise<string> {
  if (isDev) return fetchViteDevTemplate('/index.auth.html');

  const { authHtmlTemplate, authSsgHtmlTemplates } = await import('../../authHtmlTemplate');

  return selectAuthSpaTemplate(authSsgHtmlTemplates, authHtmlTemplate, locale, pathname);
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ locale: string; path?: string[] }> },
) {
  const { locale: rawLocale, path } = await params;
  const locale = normalizeLocale(rawLocale);

  const authConfig: AuthSPAServerConfig = {
    analyticsConfig: buildAnalyticsConfig(),
    config: getServerAuthConfig(),
    enableOIDC: authEnv.ENABLE_OIDC,
    featureFlags: getServerFeatureFlagsValue(),
    globalCDN: appEnv.CDN_USE_GLOBAL,
  };

  const pathname = `/${(path ?? []).join('/')}`;
  const template = await getTemplate(locale, pathname);
  const seoMeta = await buildSeoMeta(locale, pathname);

  return renderSpaHtml(template, { seoMeta, serverConfig: authConfig });
}
