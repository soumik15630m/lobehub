import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parseHTML } from 'linkedom';

import { type AuthSsgHtmlTemplates } from '@/app/spa-auth/selectAuthSpaTemplate';

import { resolveStreamingSuspense } from './resolveStreamingSuspense';

const root = path.resolve(import.meta.dirname, '../..');
const clientHtmlPath = path.resolve(root, 'dist/auth/index.auth.html');
const outputPath = path.resolve(root, 'dist/auth/ssg-manifest.json');
const locales = ['en-US', 'zh-CN'] as const;
const paths = ['/signin', '/signup'] as const;

const injectRootHtml = (template: string, appHtml: string, styleHtml: string) => {
  const rootPattern = /<div id="root"([^>]*)><\/div>/;

  if (!rootPattern.test(template)) {
    throw new Error('Auth SPA HTML does not contain an empty #root element');
  }

  return template
    .replace('</head>', `${styleHtml}</head>`)
    .replace(rootPattern, `<div id="root"$1>${appHtml}</div>`);
};

const clientHtml = await readFile(clientHtmlPath, 'utf8');
const templates = Object.fromEntries(locales.map((locale) => [locale, {}])) as AuthSsgHtmlTemplates;

for (const locale of locales) {
  for (const pathname of paths) {
    const ssgHtmlPath = path.resolve(root, `dist/auth-ssg/${locale}${pathname}.html`);
    const rawSsgHtml = await readFile(ssgHtmlPath, 'utf8');
    const ssgHtml = resolveStreamingSuspense(rawSsgHtml);
    const { document } = parseHTML(ssgHtml);
    const appHtml = document.querySelector('#root')?.innerHTML;
    const styleHtml = Array.from(document.head.querySelectorAll('style'))
      .map((element) => element.outerHTML)
      .join('');

    if (!appHtml) throw new Error(`Auth SPA SSG output is empty: ${locale}${pathname}`);
    if (!styleHtml) throw new Error(`Auth SPA SSG styles are empty: ${locale}${pathname}`);

    templates[locale][pathname] = injectRootHtml(clientHtml, appHtml, styleHtml);
  }
}

await writeFile(outputPath, JSON.stringify(templates), 'utf8');

console.log(`Generated Auth SPA SSG templates: ${locales.length * paths.length}`);
