// AUTHORED-BY Claude Opus 4.8
import { useCallback, useEffect, useMemo, useState } from "react";
import { applyQuery, EMPTY_QUERY, type Query, tagCloud } from "./filter.js";
import type { PodStore } from "./podStore.js";
import type { NewBookmark, PodBookmark } from "./types.js";

export interface BookmarksState {
  loading: boolean;
  error: string | undefined;
  /** All hydrated bookmarks (unfiltered). */
  all: PodBookmark[];
  /** The current query result (filtered + searched). */
  visible: PodBookmark[];
  query: Query;
  setQuery: (q: Query) => void;
  tags: { tag: string; count: number }[];
  /** In-flight write count, for a "Saving…/Saved" indicator. */
  saving: number;
  reload: () => Promise<void>;
  add: (data: NewBookmark) => Promise<void>;
  edit: (bookmark: PodBookmark) => Promise<void>;
  setArchived: (bookmark: PodBookmark, archived: boolean) => Promise<void>;
  remove: (bookmark: PodBookmark) => Promise<void>;
}

/**
 * The Linkding-Solid app state. Optimistic, non-blocking mutations (suite UX
 * invariant #2): a write updates the in-memory list immediately, persists async,
 * and reverts on failure with a surfaced error.
 */
export function useBookmarks(store: PodStore | undefined): BookmarksState {
  const [all, setAll] = useState<PodBookmark[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [query, setQuery] = useState<Query>(EMPTY_QUERY);
  const [saving, setSaving] = useState(0);

  const reload = useCallback(async () => {
    if (!store) return;
    setLoading(true);
    setError(undefined);
    try {
      const list = await store.list();
      setAll(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load bookmarks");
    } finally {
      setLoading(false);
    }
  }, [store]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const withSave = useCallback(async (fn: () => Promise<void>) => {
    setSaving((n) => n + 1);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
      throw e;
    } finally {
      setSaving((n) => n - 1);
    }
  }, []);

  const add = useCallback(
    async (data: NewBookmark) => {
      if (!store) return;
      await withSave(async () => {
        const created = await store.create(data);
        setAll((prev) => [created, ...prev]);
      });
    },
    [store, withSave],
  );

  const edit = useCallback(
    async (bookmark: PodBookmark) => {
      if (!store) return;
      const prevSnapshot = all;
      // Optimistic: replace in place immediately.
      setAll((prev) => prev.map((b) => (b.iri === bookmark.iri ? bookmark : b)));
      try {
        await withSave(async () => {
          const updated = await store.update(bookmark);
          setAll((prev) => prev.map((b) => (b.iri === updated.iri ? updated : b)));
        });
      } catch {
        setAll(prevSnapshot); // revert
      }
    },
    [store, withSave, all],
  );

  const setArchived = useCallback(
    async (bookmark: PodBookmark, archived: boolean) => {
      if (!store) return;
      const prevSnapshot = all;
      setAll((prev) =>
        prev.map((b) => (b.iri === bookmark.iri ? { ...b, archived } : b)),
      );
      try {
        await withSave(async () => {
          const updated = await store.setArchived(bookmark, archived);
          setAll((prev) => prev.map((b) => (b.iri === updated.iri ? updated : b)));
        });
      } catch {
        setAll(prevSnapshot);
      }
    },
    [store, withSave, all],
  );

  const remove = useCallback(
    async (bookmark: PodBookmark) => {
      if (!store) return;
      const prevSnapshot = all;
      setAll((prev) => prev.filter((b) => b.iri !== bookmark.iri));
      try {
        await withSave(async () => {
          await store.remove(bookmark.iri);
        });
      } catch {
        setAll(prevSnapshot);
      }
    },
    [store, withSave, all],
  );

  const visible = useMemo(() => applyQuery(all, query), [all, query]);
  const tags = useMemo(() => tagCloud(all), [all]);

  return {
    loading,
    error,
    all,
    visible,
    query,
    setQuery,
    tags,
    saving,
    reload,
    add,
    edit,
    setArchived,
    remove,
  };
}
