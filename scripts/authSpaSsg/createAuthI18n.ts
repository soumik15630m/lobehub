import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

import zhAuth from '@/../locales/zh-CN/auth.json';
import zhAuthError from '@/../locales/zh-CN/authError.json';
import zhCommon from '@/../locales/zh-CN/common.json';
import zhError from '@/../locales/zh-CN/error.json';
import zhMarketAuth from '@/../locales/zh-CN/marketAuth.json';
import zhOauth from '@/../locales/zh-CN/oauth.json';
import defaultAuth from '@/locales/default/auth';
import defaultAuthError from '@/locales/default/authError';
import defaultCommon from '@/locales/default/common';
import defaultError from '@/locales/default/error';
import defaultMarketAuth from '@/locales/default/marketAuth';
import defaultOauth from '@/locales/default/oauth';
import { normalizeLocale } from '@/locales/resources';

const defaultResources = {
  auth: defaultAuth,
  authError: defaultAuthError,
  common: defaultCommon,
  error: defaultError,
  marketAuth: defaultMarketAuth,
  oauth: defaultOauth,
};

const zhResources = {
  auth: zhAuth,
  authError: zhAuthError,
  common: zhCommon,
  error: zhError,
  marketAuth: zhMarketAuth,
  oauth: zhOauth,
};

export const createAuthI18n = (lang?: string) => {
  const locale = normalizeLocale(lang);
  const instance = i18next.createInstance().use(initReactI18next);

  return {
    init: () =>
      instance.init({
        defaultNS: ['auth', 'common', 'error'],
        fallbackLng: 'en-US',
        initAsync: false,
        interpolation: { escapeValue: false },
        keySeparator: false,
        lng: locale,
        ns: [],
        partialBundledLanguages: true,
        react: {
          bindI18nStore: 'added',
          useSuspense: false,
        },
        resources: {
          'en-US': defaultResources,
          'zh-CN': zhResources,
        },
        showSupportNotice: false,
      }),
    instance,
  };
};
