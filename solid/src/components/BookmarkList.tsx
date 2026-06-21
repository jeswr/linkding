// AUTHORED-BY Claude Opus 4.8
import type { PodBookmark } from "../lib/types.js";

interface Props {
  bookmarks: PodBookmark[];
  onEdit: (b: PodBookmark) => void;
  onArchive: (b: PodBookmark, archived: boolean) => void;
  onRemove: (b: PodBookmark) => void;
  onTagClick: (tag: string) => void;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function formatDate(d: Date | undefined): string {
  if (!d) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Reproduces Linkding's bookmark-list item: title link, url path, tags, description, actions. */
export function BookmarkList({ bookmarks, onEdit, onArchive, onRemove, onTagClick }: Props) {
  if (bookmarks.length === 0) {
    return (
      <div className="empty-bookmarks">
        <p>You have no bookmarks here yet.</p>
        <p className="empty-hint">Add one with the form above.</p>
      </div>
    );
  }
  return (
    <section aria-label="Bookmark list">
      <ul className="bookmark-list" role="list">
        {bookmarks.map((b) => (
          <li key={b.iri} role="listitem" className={b.archived ? "archived" : undefined}>
            <div className="content">
              <div className="title">
                <a href={b.url} target="_blank" rel="noopener noreferrer">
                  <span>{b.title || b.url}</span>
                </a>
              </div>
              <div className="url-path truncate">
                <a href={b.url} target="_blank" rel="noopener noreferrer" className="url-display">
                  {hostOf(b.url)}
                </a>
              </div>
              {b.description ? <div className="description separate">{b.description}</div> : null}
              {b.tags && b.tags.length > 0 ? (
                <div className="tags">
                  {[...b.tags].sort().map((tag) => (
                    <button
                      type="button"
                      key={tag}
                      className="tag-link"
                      onClick={() => onTagClick(tag)}
                    >
                      #{tag}
                    </button>
                  ))}
                </div>
              ) : null}
              {b.notes ? <div className="notes">{b.notes}</div> : null}
              <div className="actions">
                {formatDate(b.modified ?? b.created) ? (
                  <span>{formatDate(b.modified ?? b.created)}</span>
                ) : null}
                <span aria-hidden>|</span>
                <button type="button" className="btn-link" onClick={() => onEdit(b)}>
                  Edit
                </button>
                <button
                  type="button"
                  className="btn-link"
                  onClick={() => onArchive(b, !b.archived)}
                >
                  {b.archived ? "Unarchive" : "Archive"}
                </button>
                <button
                  type="button"
                  className="btn-link danger"
                  onClick={() => {
                    if (window.confirm("Remove this bookmark?")) onRemove(b);
                  }}
                >
                  Remove
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
