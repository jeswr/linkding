// AUTHORED-BY Claude Opus 4.8
import { type FormEvent, useEffect, useState } from "react";
import type { NewBookmark, PodBookmark } from "../lib/types.js";

interface Props {
  /** When editing, the bookmark to seed the form; absent for "add". */
  editing?: PodBookmark;
  onSubmit: (data: NewBookmark) => void;
  onCancel?: () => void;
}

function tagsToString(tags: string[] | undefined): string {
  return (tags ?? []).join(" ");
}

function stringToTags(s: string): string[] {
  return s
    .split(/[\s,]+/)
    .map((t) => t.replace(/^#/, "").trim())
    .filter(Boolean);
}

/** Linkding's add/edit bookmark form (url, title, description, tags, notes). */
export function BookmarkForm({ editing, onSubmit, onCancel }: Props) {
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    setUrl(editing?.url ?? "");
    setTitle(editing?.title ?? "");
    setDescription(editing?.description ?? "");
    setTags(tagsToString(editing?.tags));
    setNotes(editing?.notes ?? "");
  }, [editing]);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    onSubmit({
      url: url.trim(),
      title: title.trim() || undefined,
      description: description.trim() || undefined,
      tags: stringToTags(tags),
      notes: notes.trim() || undefined,
      archived: editing?.archived ?? false,
    });
    if (!editing) {
      setUrl("");
      setTitle("");
      setDescription("");
      setTags("");
      setNotes("");
    }
  }

  return (
    <form className="bookmark-form" onSubmit={submit}>
      <div className="form-group">
        <label htmlFor="bk-url">URL</label>
        <input
          id="bk-url"
          type="url"
          required
          placeholder="https://example.org/article"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </div>
      <div className="form-row">
        <div className="form-group">
          <label htmlFor="bk-title">Title</label>
          <input
            id="bk-title"
            type="text"
            placeholder="Optional title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div className="form-group">
          <label htmlFor="bk-tags">Tags</label>
          <input
            id="bk-tags"
            type="text"
            placeholder="space-separated"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
          />
        </div>
      </div>
      <div className="form-group">
        <label htmlFor="bk-desc">Description</label>
        <input
          id="bk-desc"
          type="text"
          placeholder="Optional summary"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="form-group">
        <label htmlFor="bk-notes">Notes</label>
        <textarea
          id="bk-notes"
          rows={3}
          placeholder="Markdown notes (optional)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>
      <div className="form-actions">
        <button type="submit" className="btn primary">
          {editing ? "Save" : "Add bookmark"}
        </button>
        {onCancel ? (
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}
