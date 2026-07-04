// AUTHORED-BY Claude Opus 4.8
import { useCallback, useMemo, useState } from "react";
import { BookmarkForm } from "./components/BookmarkForm.js";
import { BookmarkList } from "./components/BookmarkList.js";
import { Login } from "./components/Login.js";
import { TagCloud } from "./components/TagCloud.js";
import { resolveStorages, startLogin } from "./lib/auth.js";
import type { Query } from "./lib/filter.js";
import { PodStore } from "./lib/podStore.js";
import type { NewBookmark, PodBookmark } from "./lib/types.js";
import { useBookmarks } from "./lib/useBookmarks.js";

interface ActiveSession {
  webId: string;
  container: string;
}

export function App() {
  const [session, setSession] = useState<ActiveSession | undefined>();
  const [restoring] = useState(false);
  const [editing, setEditing] = useState<PodBookmark | undefined>();

  const store = useMemo(
    () =>
      session
        ? new PodStore({ container: session.container, webId: session.webId })
        : undefined,
    [session],
  );

  const bm = useBookmarks(store);

  const handleLogin = useCallback(async (webId: string) => {
    await startLogin(webId);
    // After login the patched fetch is authenticated; derive the storage.
    // `resolveStorages` returns only validated, normalised container roots (http(s),
    // no query/fragment, trailing slash) — build the sub-path via `new URL(child,
    // base)` rather than string-concatenating a raw profile value.
    const storages = await resolveStorages(webId);
    const base = storages[0] ?? new URL("/", webId).toString();
    const container = new URL("bookmarks/", base).toString();
    setSession({ webId, container });
  }, []);

  const setQuery = useCallback(
    (patch: Partial<Query>) => bm.setQuery({ ...bm.query, ...patch }),
    [bm],
  );

  const toggleTag = useCallback(
    (tag: string) => {
      const has = bm.query.selectedTags.map((t) => t.toLowerCase()).includes(tag.toLowerCase());
      setQuery({
        selectedTags: has
          ? bm.query.selectedTags.filter((t) => t.toLowerCase() !== tag.toLowerCase())
          : [...bm.query.selectedTags, tag],
      });
    },
    [bm.query, setQuery],
  );

  const onAdd = useCallback(
    async (data: NewBookmark) => {
      await bm.add(data);
    },
    [bm],
  );

  const onSaveEdit = useCallback(
    async (data: NewBookmark) => {
      if (!editing) return;
      await bm.edit({ ...editing, ...data });
      setEditing(undefined);
    },
    [bm, editing],
  );

  if (!session) {
    return <Login onLogin={handleLogin} restoring={restoring} />;
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>linkding</h1>
        <div className="header-right">
          {bm.saving > 0 ? <span className="saving">Saving…</span> : <span className="saved">Saved</span>}
          <span className="who" title={session.webId}>
            {new URL(session.webId).host}
          </span>
        </div>
      </header>

      <div className="toolbar">
        <input
          type="search"
          className="search"
          placeholder="Search bookmarks… (use #tag)"
          value={bm.query.search}
          onChange={(e) => setQuery({ search: e.target.value })}
        />
        <div className="view-tabs">
          <button
            type="button"
            className={bm.query.view === "active" ? "active" : ""}
            onClick={() => setQuery({ view: "active" })}
          >
            Active
          </button>
          <button
            type="button"
            className={bm.query.view === "archived" ? "active" : ""}
            onClick={() => setQuery({ view: "archived" })}
          >
            Archived
          </button>
        </div>
      </div>

      <main className="layout">
        <section className="main-col">
          {editing ? (
            <BookmarkForm
              editing={editing}
              onSubmit={onSaveEdit}
              onCancel={() => setEditing(undefined)}
            />
          ) : (
            <BookmarkForm onSubmit={onAdd} />
          )}

          {bm.error ? (
            <p className="error" role="alert">
              {bm.error}
            </p>
          ) : null}

          {bm.loading ? (
            <p className="loading">Loading bookmarks…</p>
          ) : (
            <BookmarkList
              bookmarks={bm.visible}
              onEdit={setEditing}
              onArchive={bm.setArchived}
              onRemove={bm.remove}
              onTagClick={(tag) => toggleTag(tag)}
            />
          )}
        </section>
        <TagCloud tags={bm.tags} selected={bm.query.selectedTags} onToggle={toggleTag} />
      </main>
    </div>
  );
}
