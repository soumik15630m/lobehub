import path from 'node:path';

import { defineConfig, mergeConfig } from 'vite';
import type { ViteReactSSGOptions } from 'vite-react-ssg';

import baseConfig from './vite.config';

const authSsgRoutes = ['/en-US/signin', '/en-US/signup', '/zh-CN/signin', '/zh-CN/signup'];
const authSsgI18nModule = path.resolve(import.meta.dirname, 'scripts/authSpaSsg/createAuthI18n.ts');

export default mergeConfig(
  baseConfig,
  defineConfig({
    build: {
      outDir: 'dist/auth-ssg',
    },
    plugins: [
      {
        enforce: 'pre',
        name: 'auth-ssg-synchronous-i18n',
        resolveId(source, importer) {
          if (source === './createAuthI18n' && importer?.includes('/src/features/AuthShell/')) {
            return authSsgI18nModule;
          }
        },
      },
    ],
    ssgOptions: {
      concurrency: 1,
      crittersOptions: false,
      entry: 'scripts/authSpaSsg/entry.tsx',
      formatting: 'none',
      htmlEntry: 'index.auth.ssg.html',
      includedRoutes: () => authSsgRoutes,
      mock: false,
    } satisfies ViteReactSSGOptions,
  }),
);
