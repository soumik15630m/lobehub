import { CUSTOM_DOCUMENT_FILE_TYPE } from '@lobechat/const';
import { act, renderHook } from '@testing-library/react';
import type { MutatorCallback, ScopedMutator } from 'swr/_internal';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setScopedMutate } from '@/libs/swr';
import { documentService } from '@/services/document';
import { documentSWRKeys } from '@/services/document/swrKeys';
import { initialState } from '@/store/page/initialState';
import { usePageStore } from '@/store/page/store';
import { DocumentSourceType, type LobeDocument } from '@/types/document';

vi.mock('zustand/traditional');

vi.mock('@/business/client/hooks/useActiveWorkspaceId', () => ({
  getActiveWorkspaceId: () => null,
  useActiveWorkspaceId: () => null,
}));

vi.mock('@/services/document', () => ({
  documentService: {
    createDocument: vi.fn(),
    deleteDocument: vi.fn(),
    getDocumentById: vi.fn(),
    getPageDocuments: vi.fn(),
    publishDocumentToWorkspace: vi.fn(),
    setDocumentVisibility: vi.fn(),
    updateDocument: vi.fn(),
  },
}));

const createPage = (
  id: string,
  title: string,
  overrides: Partial<LobeDocument> = {},
): LobeDocument => ({
  content: `${title} content`,
  createdAt: new Date('2026-07-31T00:00:00.000Z'),
  editorData: {},
  fileType: CUSTOM_DOCUMENT_FILE_TYPE,
  filename: title,
  id,
  metadata: {},
  source: 'document',
  sourceType: DocumentSourceType.EDITOR,
  title,
  totalCharCount: title.length,
  totalLineCount: 1,
  updatedAt: new Date('2026-07-31T00:00:00.000Z'),
  ...overrides,
});

describe('Page mutations', () => {
  const cache = new Map<string, unknown>();
  const cacheKey = (key: readonly unknown[]) => JSON.stringify(key);

  beforeEach(() => {
    vi.clearAllMocks();
    cache.clear();
    setScopedMutate((async (key, data) => {
      const keyString = JSON.stringify(key);
      if (data === undefined) return cache.get(keyString);

      const nextData =
        typeof data === 'function'
          ? await (data as MutatorCallback<unknown>)(cache.get(keyString))
          : await data;
      cache.set(keyString, nextData);
      return nextData;
    }) as ScopedMutator);
    usePageStore.setState({ ...initialState, navigate: vi.fn() }, false);
  });

  it('keeps a deleted page out of list and detail snapshots on remount', async () => {
    const deletedPage = createPage('page-deleted', 'Deleted');
    const remainingPage = createPage('page-remaining', 'Remaining');
    cache.set(cacheKey(documentSWRKeys.pageDocuments()), [deletedPage, remainingPage]);
    cache.set(cacheKey(documentSWRKeys.pageDetail(deletedPage.id)), deletedPage);
    vi.mocked(documentService.deleteDocument).mockResolvedValue(undefined);

    usePageStore.setState({ documents: [deletedPage, remainingPage] });
    const { result } = renderHook(() => usePageStore());

    await act(async () => {
      await result.current.removePage(deletedPage.id);
    });

    expect(cache.get(cacheKey(documentSWRKeys.pageDocuments()))).toEqual([remainingPage]);
    expect(cache.get(cacheKey(documentSWRKeys.pageDetail(deletedPage.id)))).toBeNull();

    usePageStore.setState({
      documents: cache.get(cacheKey(documentSWRKeys.pageDocuments())) as LobeDocument[],
    });
    expect(usePageStore.getState().documents).not.toContainEqual(
      expect.objectContaining({ id: deletedPage.id }),
    );
  });

  it('keeps renamed page metadata in list and detail snapshots on remount', async () => {
    const oldPage = createPage('page-1', 'Old title', {
      content: 'Full cached content',
      metadata: { emoji: 'old' },
    });
    const renamedPage = createPage('page-1', 'New title', {
      content: 'Full cached content',
      metadata: { emoji: 'new' },
    });
    cache.set(cacheKey(documentSWRKeys.pageDocuments()), [oldPage]);
    cache.set(cacheKey(documentSWRKeys.pageDetail(oldPage.id)), oldPage);
    vi.mocked(documentService.updateDocument).mockResolvedValue({
      historyAppended: false,
      id: oldPage.id,
    });
    vi.mocked(documentService.getPageDocuments).mockResolvedValue([renamedPage] as never);

    usePageStore.setState({ documents: [oldPage] });
    const { result } = renderHook(() => usePageStore());

    await act(async () => {
      await result.current.updatePageOptimistically(oldPage.id, {
        emoji: 'new',
        title: 'New title',
      });
    });

    expect(cache.get(cacheKey(documentSWRKeys.pageDocuments()))).toEqual([renamedPage]);
    expect(cache.get(cacheKey(documentSWRKeys.pageDetail(oldPage.id)))).toMatchObject({
      content: 'Full cached content',
      metadata: { emoji: 'new' },
      title: 'New title',
    });
  });

  it('does not replay old metadata when list refresh fails after a successful rename', async () => {
    const oldPage = createPage('page-1', 'Old title', { metadata: { emoji: 'old' } });
    cache.set(cacheKey(documentSWRKeys.pageDocuments()), [oldPage]);
    cache.set(cacheKey(documentSWRKeys.pageDetail(oldPage.id)), oldPage);
    vi.mocked(documentService.updateDocument).mockResolvedValue({
      historyAppended: false,
      id: oldPage.id,
    });
    vi.mocked(documentService.getPageDocuments).mockRejectedValue(new Error('refresh failed'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    usePageStore.setState({ documents: [oldPage] });
    const { result } = renderHook(() => usePageStore());

    await act(async () => {
      await result.current.updatePageOptimistically(oldPage.id, {
        emoji: 'new',
        title: 'New title',
      });
    });

    expect(usePageStore.getState().documents?.[0]).toMatchObject({
      metadata: { emoji: 'new' },
      title: 'New title',
    });
    expect(cache.get(cacheKey(documentSWRKeys.pageDocuments()))).toEqual([
      expect.objectContaining({ metadata: { emoji: 'new' }, title: 'New title' }),
    ]);
    expect(cache.get(cacheKey(documentSWRKeys.pageDetail(oldPage.id)))).toMatchObject({
      metadata: { emoji: 'new' },
      title: 'New title',
    });
  });

  it('keeps a newly created page in the list snapshot on remount', async () => {
    const existingPage = createPage('page-existing', 'Existing');
    const createdPage = createPage('page-created', 'Created');
    cache.set(cacheKey(documentSWRKeys.pageDocuments()), [existingPage]);
    vi.mocked(documentService.createDocument).mockResolvedValue(createdPage as never);

    usePageStore.setState({ documents: [existingPage] });
    const { result } = renderHook(() => usePageStore());

    await act(async () => {
      await result.current.createNewPage('Created');
    });

    const cachedDocuments = cache.get(cacheKey(documentSWRKeys.pageDocuments())) as LobeDocument[];
    expect(cachedDocuments.map((document) => document.id)).toEqual([
      createdPage.id,
      existingPage.id,
    ]);

    usePageStore.setState({ documents: cachedDocuments });
    expect(usePageStore.getState().documents).toContainEqual(
      expect.objectContaining({ id: createdPage.id, title: 'Created' }),
    );
  });

  it('keeps page moves in list and detail snapshots on remount', async () => {
    const oldPage = createPage('page-1', 'Page', { parentId: null });
    const movedPage = createPage('page-1', 'Page', { parentId: 'folder-1' });
    cache.set(cacheKey(documentSWRKeys.pageDocuments()), [oldPage]);
    cache.set(cacheKey(documentSWRKeys.pageDetail(oldPage.id)), oldPage);
    vi.mocked(documentService.updateDocument).mockResolvedValue({
      historyAppended: false,
      id: oldPage.id,
    });
    vi.mocked(documentService.getPageDocuments).mockResolvedValue([movedPage] as never);

    usePageStore.setState({ documents: [oldPage] });
    const { result } = renderHook(() => usePageStore());

    await act(async () => {
      await result.current.updatePage(oldPage.id, { parentId: 'folder-1' });
    });

    expect(cache.get(cacheKey(documentSWRKeys.pageDocuments()))).toEqual([movedPage]);
    expect(cache.get(cacheKey(documentSWRKeys.pageDetail(oldPage.id)))).toMatchObject({
      parentId: 'folder-1',
    });
  });

  it('keeps visibility changes in list and detail snapshots on remount', async () => {
    const publicPage = createPage('page-1', 'Page', { visibility: 'public' });
    const privatePage = createPage('page-1', 'Page', { visibility: 'private' });
    cache.set(cacheKey(documentSWRKeys.pageDocuments()), [publicPage]);
    cache.set(cacheKey(documentSWRKeys.pageDetail(publicPage.id)), publicPage);
    vi.mocked(documentService.setDocumentVisibility).mockResolvedValue({
      documentIds: [publicPage.id],
    });
    vi.mocked(documentService.getPageDocuments).mockResolvedValue([privatePage] as never);

    usePageStore.setState({ documents: [publicPage] });
    const { result } = renderHook(() => usePageStore());

    await act(async () => {
      await result.current.setPageVisibility(publicPage.id, 'private');
    });

    expect(cache.get(cacheKey(documentSWRKeys.pageDocuments()))).toEqual([privatePage]);
    expect(cache.get(cacheKey(documentSWRKeys.pageDetail(publicPage.id)))).toMatchObject({
      visibility: 'private',
    });
  });
});
