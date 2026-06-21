// AUTHORED-BY Claude Opus 4.8
import type { PodBookmark } from "./types.js";

/**
 * Linkding's query model, client-side. Linkding's search box accepts free text
 * plus `#tag` tokens and a `!unread`/`!untagged` style of special filter; we
 * reproduce the two that matter for the MVP: free-text terms (AND across terms,
 * matched against title/description/notes/url/tags) and `#tag` tokens (AND across
 * tags). The `archived` view is a separate toggle, like Linkding's Archived page.
 */
export interface Query {
  /** Raw search string from the search box. */
  search: string;
  /** Tags selected from the tag cloud (AND-combined with any `#tag` in `search`). */
  selectedTags: string[];
  /** Which list to show: active (default) or the archive. */
  view: "active" | "archived";
}

export const EMPTY_QUERY: Query = { search: "", selectedTags: [], view: "active" };

interface ParsedSearch {
  terms: string[];
  tags: string[];
}

/** Split a Linkding-style search string into free-text terms and `#tag` tokens. */
export function parseSearch(search: string): ParsedSearch {
  const terms: string[] = [];
  const tags: string[] = [];
  for (const token of search.trim().split(/\s+/).filter(Boolean)) {
    if (token.startsWith("#") && token.length > 1) {
      tags.push(token.slice(1).toLowerCase());
    } else {
      terms.push(token.toLowerCase());
    }
  }
  return { terms, tags };
}

function haystack(b: PodBookmark): string {
  return [b.title, b.description, b.notes, b.url, ...(b.tags ?? [])]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** Apply a {@link Query} to a bookmark list — the pure filter Linkding does server-side. */
export function applyQuery(bookmarks: PodBookmark[], query: Query): PodBookmark[] {
  const { terms, tags: searchTags } = parseSearch(query.search);
  const requiredTags = [
    ...searchTags,
    ...query.selectedTags.map((t) => t.toLowerCase()),
  ];

  return bookmarks.filter((b) => {
    // Archive view separation.
    const isArchived = b.archived === true;
    if (query.view === "archived" ? !isArchived : isArchived) return false;

    // All free-text terms must match somewhere.
    if (terms.length > 0) {
      const hay = haystack(b);
      if (!terms.every((t) => hay.includes(t))) return false;
    }

    // All required tags must be present (case-insensitive).
    if (requiredTags.length > 0) {
      const bookmarkTags = (b.tags ?? []).map((t) => t.toLowerCase());
      if (!requiredTags.every((t) => bookmarkTags.includes(t))) return false;
    }

    return true;
  });
}

/** Build a sorted, deduplicated tag cloud with counts (Linkding's tag sidebar). */
export function tagCloud(bookmarks: PodBookmark[]): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const b of bookmarks) {
    if (b.archived) continue;
    for (const tag of b.tags ?? []) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => a.tag.localeCompare(b.tag));
}
