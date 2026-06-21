// AUTHORED-BY Claude Opus 4.8
import { fetchRdf } from "@jeswr/fetch-rdf";
import { parseBookmark, serializeBookmark } from "@jeswr/solid-bookmark";
import { ownerOnlyAcl } from "./acl.js";
import type { NewBookmark, PodBookmark } from "./types.js";

/**
 * Pod-backed bookmark CRUD over LDP — the Solid replacement for Linkding's Django
 * `/api/bookmarks/` endpoints.
 *
 * STORAGE LAYOUT — **one LDP resource per bookmark** in a single container
 * (default `${podBase}bookmarks/`), each a Turtle document carrying exactly one
 * `book:Bookmark`. Chosen over a single aggregate document because:
 *   - per-resource WAC: an individual bookmark can be shared/locked independently;
 *   - listing is the container's `ldp:contains` (cheap, no full-doc parse to enumerate);
 *   - concurrent edits don't contend on one big document (each write is `If-Match`
 *     against just that bookmark's ETag);
 *   - it matches the Pod Manager's per-resource read model so its bookmarks view
 *     reads the SAME resources with no translation.
 * The trade-off — N requests to hydrate the full list — is acceptable for a
 * personal bookmark store and is mitigated by client-side caching + the fact that
 * filter/search run over the already-fetched in-memory list.
 *
 * RDF discipline: reads parse via `@jeswr/fetch-rdf` (the suite parse seam) +
 * `@jeswr/solid-bookmark`'s `parseBookmark`; writes serialise via the package's
 * `serializeBookmark` (n3.Writer under the hood). No hand-built triples.
 *
 * Auth: a `fetch` is injected (the auth seam) — `@solid/reactive-authentication`
 * patches `globalThis.fetch`, but the store takes an explicit `fetch` so it is
 * unit-testable without a server and works with any authed-fetch implementation.
 */
export interface PodStoreConfig {
  /** The bookmarks container URL, e.g. `https://alice.pod/bookmarks/`. */
  container: string;
  /** The owner's WebID — written into each bookmark's owner-only ACL. */
  webId: string;
  /** An authenticated `fetch` (defaults to `globalThis.fetch`). */
  fetch?: typeof globalThis.fetch;
}

const TURTLE = "text/turtle";

export class PodStore {
  private readonly container: string;
  private readonly webId: string;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(config: PodStoreConfig) {
    if (!config.container.endsWith("/")) {
      throw new Error("PodStore container URL must end with a trailing slash");
    }
    this.container = config.container;
    this.webId = config.webId;
    // Bind so we never rely on `this` inside fetch.
    this.fetchFn = config.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** Generate a fresh, collision-resistant resource URL for a new bookmark. */
  private newIri(): string {
    const slug = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return `${this.container}${slug}`;
  }

  /**
   * List the bookmark resource URLs in the container (the LDP membership), parsed
   * from the container listing via `@jeswr/fetch-rdf` — `ldp:contains` triples.
   */
  async listIris(): Promise<string[]> {
    let result: Awaited<ReturnType<typeof fetchRdf>>;
    try {
      result = await fetchRdf(this.container, { fetch: this.fetchFn });
    } catch (err) {
      // A 404 container means "no bookmarks yet" — surface as empty, not an error.
      if (isNotFound(err)) return [];
      throw err;
    }
    const LDP_CONTAINS = "http://www.w3.org/ns/ldp#contains";
    const iris: string[] = [];
    for (const q of result.dataset.match(null, null, null)) {
      if (q.predicate.value === LDP_CONTAINS && q.object.termType === "NamedNode") {
        const child = q.object.value;
        // Skip ACL/meta sidecars and sub-containers.
        if (child.endsWith(".acl") || child.endsWith("/")) continue;
        iris.push(child);
      }
    }
    return iris;
  }

  /**
   * Read and parse one bookmark resource. Returns undefined if it isn't a bookmark
   * OR if it does not exist (a 404 — e.g. a freshly deleted resource).
   */
  async get(iri: string): Promise<PodBookmark | undefined> {
    let result: Awaited<ReturnType<typeof fetchRdf>>;
    try {
      result = await fetchRdf(iri, { fetch: this.fetchFn });
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
    const parsed = parseBookmark(iri, result.dataset);
    // undefined means "no book:Bookmark here" — not a bookmark resource.
    if (!parsed) return undefined;
    return {
      ...parsed,
      iri,
      etag: result.etag ?? undefined,
    };
  }

  /** Hydrate the full bookmark list (filtered to valid bookmarks). */
  async list(): Promise<PodBookmark[]> {
    const iris = await this.listIris();
    const results = await Promise.all(
      iris.map((iri) => this.get(iri).catch(() => undefined)),
    );
    return results.filter((b): b is PodBookmark => b !== undefined);
  }

  /**
   * Create a new bookmark. Writes the **owner-only ACL first**, then the body, so
   * the resource is never briefly world-readable. Returns the stored bookmark.
   */
  async create(data: NewBookmark): Promise<PodBookmark> {
    const iri = this.newIri();
    const now = new Date();
    const withDates: NewBookmark = {
      ...data,
      created: data.created ?? now,
      modified: data.modified ?? now,
    };
    // 1. ACL first.
    await this.putAcl(iri);
    // 2. Body.
    const ttl = await serializeBookmark(iri, withDates);
    const res = await this.fetchFn(iri, {
      method: "PUT",
      headers: { "content-type": TURTLE },
      body: ttl,
    });
    assertOk(res, `create ${iri}`);
    return {
      ...withDates,
      iri,
      etag: res.headers.get("etag") ?? undefined,
    };
  }

  /**
   * Update an existing bookmark with an `If-Match` conditional write (optimistic
   * concurrency). Pass the bookmark you read (so its `etag` is used). Returns the
   * updated bookmark with the new ETag.
   */
  async update(bookmark: PodBookmark): Promise<PodBookmark> {
    const updated: PodBookmark = { ...bookmark, modified: new Date() };
    const ttl = await serializeBookmark(bookmark.iri, updated);
    const headers: Record<string, string> = { "content-type": TURTLE };
    if (bookmark.etag) headers["if-match"] = bookmark.etag;
    const res = await this.fetchFn(bookmark.iri, {
      method: "PUT",
      headers,
      body: ttl,
    });
    assertOk(res, `update ${bookmark.iri}`);
    return { ...updated, etag: res.headers.get("etag") ?? undefined };
  }

  /** Toggle a bookmark's archived flag (Linkding archive/unarchive). */
  async setArchived(bookmark: PodBookmark, archived: boolean): Promise<PodBookmark> {
    return this.update({ ...bookmark, archived });
  }

  /** Delete a bookmark resource (Linkding "Remove"). */
  async remove(iri: string): Promise<void> {
    const res = await this.fetchFn(iri, { method: "DELETE" });
    if (res.status !== 404) assertOk(res, `remove ${iri}`);
  }

  /** Write the owner-only ACL for a resource (best-effort: not all servers expose `.acl`). */
  private async putAcl(iri: string): Promise<void> {
    const aclUrl = `${iri}.acl`;
    const acl = await ownerOnlyAcl(iri, this.webId);
    const res = await this.fetchFn(aclUrl, {
      method: "PUT",
      headers: { "content-type": TURTLE },
      body: acl,
    });
    // A server that doesn't support a writable `.acl` (ACP-only, or a fixed-policy
    // server) returns 4xx — that's not fatal to creating the bookmark, but we
    // surface a 5xx (a real failure).
    if (res.status >= 500) assertOk(res, `acl ${aclUrl}`);
  }
}

function assertOk(res: Response, ctx: string): void {
  if (!res.ok) {
    throw new Error(`Pod request failed (${res.status} ${res.statusText}) for ${ctx}`);
  }
}

function isNotFound(err: unknown): boolean {
  if (err && typeof err === "object" && "status" in err) {
    return (err as { status?: number }).status === 404;
  }
  return false;
}
