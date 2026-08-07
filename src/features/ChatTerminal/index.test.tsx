import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useGlobalStore } from '@/store/global';
import { initialState } from '@/store/global/initialState';

import ChatTerminalPanel from './index';

vi.mock('@lobechat/const', async (importOriginal) => ({
  ...(await importOriginal()),
  isDesktop: true,
}));

vi.mock('@lobehub/ui', () => ({
  DraggablePanel: ({
    children,
    expand,
    stableLayout = true,
  }: {
    children?: ReactNode;
    expand?: boolean;
    stableLayout?: boolean;
  }) => (
    <div
      data-expand={String(expand)}
      data-testid="terminal-panel"
      style={{ height: expand ? 320 : stableLayout ? '100%' : 0 }}
    >
      {children}
    </div>
  ),
}));

vi.mock('./Content', () => ({
  default: () => <div data-testid="terminal-content" />,
}));

const setShow = (showTerminalPanel: boolean) =>
  act(() => {
    useGlobalStore.setState({
      status: { ...useGlobalStore.getState().status, showTerminalPanel },
    });
  });

beforeEach(() => {
  useGlobalStore.setState({ status: { ...initialState.status } });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ChatTerminalPanel', () => {
  it('drives open/close through controlled expand instead of unmounting', async () => {
    render(<ChatTerminalPanel />);

    // Closed: the panel is mounted (so it can animate) with expand=false,
    // rather than returning null as the old implementation did. It must use
    // the legacy DraggablePanel layout so the collapsed bottom panel does not
    // retain the stable layout's full-height fixed aside.
    expect(screen.getByTestId('terminal-panel').dataset.expand).toBe('false');
    expect(screen.getByTestId('terminal-panel')).toHaveStyle({ height: '0px' });

    setShow(true);
    await waitFor(() => expect(screen.getByTestId('terminal-panel').dataset.expand).toBe('true'));

    setShow(false);
    expect(screen.getByTestId('terminal-panel').dataset.expand).toBe('false');
  });

  it('defers Content until first open, then unmounts it after the collapse animation', async () => {
    render(<ChatTerminalPanel />);

    expect(screen.queryByTestId('terminal-content')).toBeNull();

    setShow(true);
    expect(await screen.findByTestId('terminal-content')).toBeDefined();

    vi.useFakeTimers();
    try {
      setShow(false);
      // Kept mounted while the panel collapses.
      expect(screen.getByTestId('terminal-content')).toBeDefined();

      act(() => {
        vi.advanceTimersByTime(300);
      });
      // Unmounted once hidden, releasing the xterm canvas.
      expect(screen.queryByTestId('terminal-content')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
