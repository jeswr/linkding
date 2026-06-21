// AUTHORED-BY Claude Opus 4.8
import type { BookmarkData } from "@jeswr/solid-bookmark";

/**
 * A bookmark as the UI works with it: the typed {@link BookmarkData} model from
 * `@jeswr/solid-bookmark` plus the pod-side identity (`iri` = the LDP resource URL)
 * and the conditional-write `etag` we keep from the last read.
 *
 * The data fields (`url`/`title`/`description`/`notes`/`archived`/`tags`/`created`/
 * `modified`) come straight from the published model — we never re-declare them, so
 * a model change flows through here for free.
 */
export interface PodBookmark extends BookmarkData {
  /** The LDP resource URL this bookmark is stored at (one resource per bookmark). */
  iri: string;
  /** The ETag from the last GET, for an `If-Match` conditional update (optimistic concurrency). */
  etag?: string;
}

/** A new-bookmark form payload (no pod identity yet). */
export type NewBookmark = BookmarkData;
