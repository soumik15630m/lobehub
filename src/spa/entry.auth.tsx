import '../initialize';

import { hydrateRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router/dom';

import BootErrorBoundary from '@/components/BootErrorBoundary';
import NextThemeProvider from '@/layout/GlobalProvider/NextThemeProvider';

import { authRoutes } from './router/authRouter.config';
import { createSPABrowserRouter, createSPARoot } from './runtime';

const router = createSPABrowserRouter(authRoutes);
const root = document.getElementById('root')!;
const app = (
  <BootErrorBoundary>
    <NextThemeProvider>
      <RouterProvider router={router} />
    </NextThemeProvider>
  </BootErrorBoundary>
);

if (root.hasChildNodes()) {
  hydrateRoot(root, app);
} else {
  createSPARoot(root).render(app);
}
