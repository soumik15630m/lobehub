import { describe, expect, it } from 'vitest';

import { type AuthSsgHtmlTemplates, selectAuthSpaTemplate } from './selectAuthSpaTemplate';

const templates: AuthSsgHtmlTemplates = {
  'en-US': { '/signin': 'en-signin', '/signup': 'en-signup' },
  'zh-CN': { '/signin': 'zh-signin', '/signup': 'zh-signup' },
};

describe('selectAuthSpaTemplate', () => {
  it('selects the prerendered HTML from the locale prefix and pathname', () => {
    expect(selectAuthSpaTemplate(templates, 'fallback', 'zh-CN', '/signin')).toBe('zh-signin');
    expect(selectAuthSpaTemplate(templates, 'fallback', 'en-US', '/signup')).toBe('en-signup');
  });

  it('uses the English SSG template for locales whose auth copy falls back to English', () => {
    expect(selectAuthSpaTemplate(templates, 'fallback', 'ja-JP', '/signin')).toBe('en-signin');
  });

  it('keeps the client-only template for routes that cannot be statically rendered', () => {
    expect(selectAuthSpaTemplate(templates, 'fallback', 'zh-CN', '/oauth/device')).toBe('fallback');
  });
});
