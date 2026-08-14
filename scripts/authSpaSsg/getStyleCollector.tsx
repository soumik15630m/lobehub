import { extractStaticStyle, StyleProvider } from 'antd-style';
import { type ReactElement } from 'react';

export const getStyleCollector = () => ({
  collect: (app: ReactElement) => (
    <StyleProvider cache={extractStaticStyle.cache}>{app}</StyleProvider>
  ),
  toString: () =>
    extractStaticStyle()
      .map((item) => item.tag)
      .join(''),
});
