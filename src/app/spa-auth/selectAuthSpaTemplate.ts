import { type Locales } from '@/locales/resources';

export type AuthSsgLocale = 'en-US' | 'zh-CN';

export type AuthSsgHtmlTemplates = Record<AuthSsgLocale, Record<string, string>>;

const resolveSsgLocale = (locale: Locales): AuthSsgLocale =>
  locale === 'zh-CN' ? 'zh-CN' : 'en-US';

export const selectAuthSpaTemplate = (
  templates: AuthSsgHtmlTemplates,
  fallback: string,
  locale: Locales,
  pathname: string,
) => templates[resolveSsgLocale(locale)][pathname] ?? fallback;
