// AUTHORED-BY Claude Opus 4.8
import { fetchRdf } from "@jeswr/fetch-rdf";
import { parseBookmark, serializeBookmark } from "@jeswr/solid-bookmark";
import { DataFactory } from "n3";
import { ownerOnlyAcl, ownerOnlyContainerAcl } from "./acl.js";
import type { NewBookmark, PodBookmark } from "./types.js";

const { namedNode } = DataFactory;

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
  /**
   * Memoised promise of the one-time container owner-only ACL establishment. Set on
   * the first `create()` (or an explicit `ensureContainerAcl()`) so the fail-closed
   * container guard runs exactly once per store, not on every write.
   */
  private containerAcl: Promise<void> | undefined;

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
   * Establish the bookmarks **container's** owner-only ACL — FAIL-CLOSED, exactly
   * once per store (memoised). This is the keystone of the owner-only guarantee:
   *
   *   - The container ACL carries `acl:default`, so EVERY resource created inside
   *     the container inherits owner-only access. That covers the brief window
   *     between a bookmark's body being written and its own per-resource `.acl`
   *     being applied — the resource is never world-readable, even momentarily,
   *     which is what lets `create()` safely write the body before its `.acl`.
   *   - If the container ACL cannot be CONFIRMED owner-private (a non-2xx PUT and
   *     no verifiable owner-only ACL already in place), this REFUSES to proceed
   *     (throws), so we never write bookmarks into a container we cannot prove is
   *     owner-private. Fail-closed, not fail-open.
   *
   * The single accepted "ACLs not writable but already owner-private" path: a
   * server that rejects the `.acl` PUT with a documented "method not allowed on a
   * fixed-policy `.acl`" signal (405) AND whose existing container `.acl` we can
   * fetch and confirm grants no public/authenticated access. Anything else throws.
   */
  async ensureContainerAcl(): Promise<void> {
    if (!this.containerAcl) {
      this.containerAcl = this.establishContainerAcl().catch((err) => {
        // Don't cache a failure — a transient error should be retryable on the
        // next create() rather than poisoning the store permanently.
        this.containerAcl = undefined;
        throw err;
      });
    }
    return this.containerAcl;
  }

  private async establishContainerAcl(): Promise<void> {
    const aclUrl = `${this.container}.acl`;
    const acl = await ownerOnlyContainerAcl(this.container, this.webId);
    const res = await this.fetchFn(aclUrl, {
      method: "PUT",
      headers: { "content-type": TURTLE },
      body: acl,
    });
    if (res.ok) return; // owner-only container ACL now in place.

    // The ONLY accepted non-2xx: the server won't let us write the container `.acl`
    // (405 Method Not Allowed) but we can fetch the existing one and CONFIRM it is
    // already owner-private (no public / authenticated-agent grant). Anything else
    // (401/403/404/5xx/unconfirmable) FAILS CLOSED.
    if (res.status === 405 && (await this.containerIsAlreadyOwnerPrivate(aclUrl))) {
      return;
    }
    throw new Error(
      `Refusing to store bookmarks: could not establish an owner-only ACL on the ` +
        `container ${this.container} (${res.status} ${res.statusText} on ${aclUrl}). ` +
        `Bookmarks are owner-private; aborting rather than risk a public container.`,
    );
  }

  /**
   * POSITIVELY confirm an EXISTING container `.acl` is owner-only. This is a
   * fail-CLOSED, positive proof — NOT a negative "no public grant" heuristic. It
   * returns `true` ONLY IF the parsed `.acl`:
   *
   *   1. `acl:accessTo <this.container>` coverage: there EXISTS an
   *        `acl:Authorization` that has `acl:accessTo <this.container>` +
   *        `acl:agent <this.webId>` (the owner) + `acl:mode` Read AND Write AND
   *        Control (protects the container itself); AND
   *   2. `acl:default <this.container>` coverage: there EXISTS an
   *        `acl:Authorization` that has `acl:default <this.container>` +
   *        `acl:agent <this.webId>` + `acl:mode` Read AND Write AND Control
   *        (protects every CHILD resource — the clause the create→acl window relies
   *        on). This MAY be the SAME authorization as (1) or a DIFFERENT one: WAC
   *        validly splits access and default across two owner-only authorizations,
   *        so we validate the two coverages INDEPENDENTLY rather than demanding both
   *        on one subject; AND
   *   3. contains NO authorization (anywhere in the document) that grants any
   *        `acl:agentClass` (e.g. foaf:Agent = public, acl:AuthenticatedAgent = any
   *        logged-in user) or any `acl:agent` OTHER than `this.webId` (no public,
   *        authenticated, or third-party grant).
   *
   * Anything not positively proven owner-only — an empty ACL, an ACL missing
   * `acl:accessTo` OR `acl:default` owner coverage, an ACL missing one of the
   * owner's R/W/C modes on either, an ACL granting a foreign agent or an
   * agentClass, or an ACL we can't fetch/parse — returns `false` (fail closed). A
   * non-owner grant ANYWHERE in the document fails it, even if a separate owner-only
   * authorization also exists.
   */
  private async containerIsAlreadyOwnerPrivate(aclUrl: string): Promise<boolean> {
    let result: Awaited<ReturnType<typeof fetchRdf>>;
    try {
      result = await fetchRdf(aclUrl, { fetch: this.fetchFn });
    } catch {
      return false; // can't read it → can't confirm → fail closed.
    }
    const dataset = result.dataset;
    const ns = "http://www.w3.org/ns/auth/acl#";
    const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
    const AUTHORIZATION = `${ns}Authorization`;
    const ACCESS_TO = `${ns}accessTo`;
    const DEFAULT = `${ns}default`;
    const AGENT = `${ns}agent`;
    const AGENT_CLASS = `${ns}agentClass`;
    const MODE = `${ns}mode`;
    const READ = `${ns}Read`;
    const WRITE = `${ns}Write`;
    const CONTROL = `${ns}Control`;

    // (2) FOREIGN-GRANT GUARD (checked first, fail-fast): any `acl:agentClass` grant
    //     at all, or any `acl:agent` that is NOT the owner, means the document is not
    //     owner-private — regardless of any owner-only authorization that may also
    //     exist. A single public/authenticated/third-party grant disqualifies it.
    if (dataset.match(null, namedNode(AGENT_CLASS), null).size > 0) {
      return false; // public (foaf:Agent) or authenticated (acl:AuthenticatedAgent).
    }
    for (const q of dataset.match(null, namedNode(AGENT), null)) {
      if (q.object.value !== this.webId) return false; // a third-party agent grant.
    }

    // (1)+(2) POSITIVE PROOF, validated INDEPENDENTLY: the owner must have a complete
    //     Read+Write+Control authorization covering `acl:accessTo <container>` AND a
    //     complete Read+Write+Control authorization covering `acl:default <container>`.
    //     WAC validly expresses these as SEPARATE owner-only authorizations, so we do
    //     NOT require both clauses on one subject — each coverage is proven on its own.
    const container = namedNode(this.container);
    const owner = namedNode(this.webId);
    // True iff SOME Authorization grants the owner R+W+C and has `target <container>`.
    const ownerHasFullControlOver = (target: string): boolean => {
      for (const q of dataset.match(null, namedNode(RDF_TYPE), namedNode(AUTHORIZATION))) {
        const authz = q.subject;
        const has = (predicate: string, object: ReturnType<typeof namedNode>): boolean =>
          dataset.match(authz, namedNode(predicate), object).size > 0;
        if (
          has(target, container) &&
          has(AGENT, owner) &&
          has(MODE, namedNode(READ)) &&
          has(MODE, namedNode(WRITE)) &&
          has(MODE, namedNode(CONTROL))
        ) {
          return true;
        }
      }
      return false;
    };
    // Both coverages must hold (each MAY be the same authz or two different ones).
    if (ownerHasFullControlOver(ACCESS_TO) && ownerHasFullControlOver(DEFAULT)) {
      return true; // positively proven owner-only for this container.
    }
    return false; // accessTo and/or default owner coverage missing → fail closed.
  }

  /**
   * Create a new bookmark — FAIL-CLOSED owner-only:
   *   1. ensure the container has an owner-only ACL (with `acl:default`), so the new
   *      resource inherits owner-only access during the create→acl window;
   *   2. write the resource BODY (the order servers accept — a `.acl` for a resource
   *      that doesn't yet exist is widely rejected);
   *   3. PUT the resource's own owner-only `.acl`; if that fails and the inherited
   *      container default cannot cover it, the create FAILS (and the orphaned body
   *      is cleaned up) rather than silently leaving a resource without its ACL.
   */
  async create(data: NewBookmark): Promise<PodBookmark> {
    // 0. FAIL-CLOSED: the container must be confirmed owner-private first.
    await this.ensureContainerAcl();

    const iri = this.newIri();
    const now = new Date();
    const withDates: NewBookmark = {
      ...data,
      created: data.created ?? now,
      modified: data.modified ?? now,
    };
    // 1. Body first (resource-then-acl — the order LDP/WAC servers accept).
    const ttl = await serializeBookmark(iri, withDates);
    const res = await this.fetchFn(iri, {
      method: "PUT",
      headers: { "content-type": TURTLE },
      body: ttl,
    });
    assertOk(res, `create ${iri}`);

    // 2. Per-resource ACL — fail closed. The body already inherits the container's
    //    owner-only `acl:default`, so a server that doesn't expose a writable
    //    per-resource `.acl` (405) is acceptable; a real auth/error failure is NOT,
    //    and we clean up the orphaned body so we never leave a resource we couldn't
    //    secure with its intended ACL.
    try {
      await this.putAcl(iri);
    } catch (err) {
      await this.bestEffortDelete(iri);
      throw err;
    }

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

  /**
   * Write the owner-only ACL for a resource — FAIL-CLOSED.
   *
   * A non-2xx response is NOT silently swallowed. The single accepted exception is
   * `405 Method Not Allowed`: a server that exposes no writable per-resource `.acl`
   * (ACP-only / fixed-policy). That is acceptable ONLY because the resource already
   * inherits the container's owner-only `acl:default` (established fail-closed in
   * `ensureContainerAcl()` before any body is written), so it is still owner-only.
   * Every other non-2xx — 401/403 (auth failure), 400/422 (malformed/rejected ACL),
   * 5xx (server error) — THROWS, so the create fails rather than leaving the
   * resource under inherited container *or* default permissions we cannot vouch for.
   */
  private async putAcl(iri: string): Promise<void> {
    const aclUrl = `${iri}.acl`;
    const acl = await ownerOnlyAcl(iri, this.webId);
    const res = await this.fetchFn(aclUrl, {
      method: "PUT",
      headers: { "content-type": TURTLE },
      body: acl,
    });
    if (res.ok) return;
    // Documented "no writable per-resource .acl, fixed/inherited policy" signal —
    // acceptable ONLY because the container default already secures the resource.
    if (res.status === 405) return;
    throw new Error(
      `Refusing to leave a bookmark without its owner-only ACL: ` +
        `${res.status} ${res.statusText} writing ${aclUrl}.`,
    );
  }

  /** Delete a resource ignoring failures — used to clean up an orphaned body. */
  private async bestEffortDelete(iri: string): Promise<void> {
    try {
      await this.fetchFn(iri, { method: "DELETE" });
    } catch {
      // Cleanup is best-effort; the create already threw the meaningful error.
    }
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
