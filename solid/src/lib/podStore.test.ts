// AUTHORED-BY Claude Opus 4.8
import { serializeBookmark } from "@jeswr/solid-bookmark";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PodStore } from "./podStore.js";

const CONTAINER = "https://alice.pod/bookmarks/";
const WEBID = "https://alice.pod/profile/card#me";

/**
 * Options to simulate a hostile/limited server for the fail-closed security tests.
 */
interface FakePodOptions {
  /**
   * Status to return for a PUT to a *per-resource* (non-container) `.acl`. When set
   * to a non-2xx value this simulates a server rejecting the per-resource ACL write
   * (e.g. 403 auth failure, 400 malformed). Default: accept (201).
   */
  resourceAclStatus?: number;
  /**
   * Status to return for a PUT to the *container* `.acl`. Non-2xx simulates a server
   * that won't let us establish the container owner-only ACL. Default: accept (201).
   */
  containerAclStatus?: number;
  /** An existing container `.acl` body to serve on GET (for the 405-confirm path). */
  existingContainerAcl?: string;
}

/**
 * An in-memory fake pod: a Map of URL → { body, contentType, etag }. The returned
 * `fetch` records every request so we can assert ordering (body-before-acl) and
 * conditional-write headers, and can be configured to REJECT ACL writes so the
 * fail-closed owner-only guarantees can be tested.
 */
function fakePod(options: FakePodOptions = {}) {
  const store = new Map<string, { body: string; contentType: string; etag: string }>();
  const requests: { method: string; url: string; headers: Record<string, string> }[] = [];
  let etagSeq = 0;

  const containerAclUrl = `${CONTAINER}.acl`;
  if (options.existingContainerAcl) {
    store.set(containerAclUrl, {
      body: options.existingContainerAcl,
      contentType: "text/turtle",
      etag: '"existing-acl"',
    });
  }

  const containerListing = () => {
    const children = [...store.keys()].filter(
      (k) => k.startsWith(CONTAINER) && k !== CONTAINER && !k.endsWith(".acl"),
    );
    const triples = children.map((c) => `<${CONTAINER}> ldp:contains <${c}> .`).join("\n");
    return `@prefix ldp: <http://www.w3.org/ns/ldp#> .\n${triples}\n`;
  };

  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    requests.push({ method, url, headers });

    if (method === "GET") {
      if (url === CONTAINER) {
        return new Response(containerListing(), {
          status: 200,
          headers: { "content-type": "text/turtle" },
        });
      }
      const rec = store.get(url);
      if (!rec) return new Response("Not Found", { status: 404 });
      return new Response(rec.body, {
        status: 200,
        headers: { "content-type": rec.contentType, etag: rec.etag },
      });
    }

    if (method === "PUT") {
      const isAcl = url.endsWith(".acl");
      const isContainerAcl = url === containerAclUrl;
      // Simulate ACL-write rejection per the configured options.
      const rejectStatus = isContainerAcl
        ? options.containerAclStatus
        : isAcl
          ? options.resourceAclStatus
          : undefined;
      if (rejectStatus !== undefined && rejectStatus >= 300) {
        return new Response(`ACL write refused`, {
          status: rejectStatus,
          statusText: rejectStatus === 403 ? "Forbidden" : "Error",
        });
      }
      const etag = `"v${++etagSeq}"`;
      store.set(url, {
        body: (init?.body as string) ?? "",
        contentType: headers["content-type"] ?? "text/turtle",
        etag,
      });
      return new Response(null, { status: 201, headers: { etag } });
    }

    if (method === "DELETE") {
      store.delete(url);
      return new Response(null, { status: 204 });
    }

    return new Response("Method Not Allowed", { status: 405 });
  }) as typeof globalThis.fetch;

  return { store, requests, fetchFn };
}

describe("PodStore", () => {
  let pod: ReturnType<typeof fakePod>;
  let podStore: PodStore;

  beforeEach(() => {
    pod = fakePod();
    podStore = new PodStore({ container: CONTAINER, webId: WEBID, fetch: pod.fetchFn });
  });

  it("rejects a container URL without a trailing slash", () => {
    expect(
      () => new PodStore({ container: "https://x/bookmarks", webId: WEBID, fetch: pod.fetchFn }),
    ).toThrow(/trailing slash/);
  });

  it("create establishes the owner-only CONTAINER ACL before creating any resource", async () => {
    // (b) The container owner-only ACL is established up-front, before the resource
    //     is created — so the new resource inherits owner-only via acl:default.
    await podStore.create({ url: "https://example.org/a", title: "A", tags: ["x"] });
    const containerAclUrl = `${CONTAINER}.acl`;
    const writes = pod.requests.filter((r) => r.method === "PUT");
    const containerAclIdx = writes.findIndex((r) => r.url === containerAclUrl);
    const bodyIdx = writes.findIndex(
      (r) => r.url.startsWith(CONTAINER) && r.url !== containerAclUrl && !r.url.endsWith(".acl"),
    );
    expect(containerAclIdx).toBeGreaterThanOrEqual(0);
    expect(bodyIdx).toBeGreaterThanOrEqual(0);
    expect(containerAclIdx).toBeLessThan(bodyIdx); // container ACL first

    // The container ACL must carry acl:default (covers created resources).
    const containerAclBody = pod.store.get(containerAclUrl)?.body ?? "";
    expect(containerAclBody).toContain("default");
    expect(containerAclBody).toContain(WEBID);
    expect(containerAclBody).not.toContain("agentClass"); // owner-only, no public grant
  });

  it("create writes the resource BODY before its own .acl (resource-then-acl order)", async () => {
    // (c) Within a resource, the body is PUT before its `.acl` — the order LDP/WAC
    //     servers accept (a `.acl` for a non-existent resource is widely rejected).
    await podStore.create({ url: "https://example.org/a", title: "A", tags: ["x"] });
    const containerAclUrl = `${CONTAINER}.acl`;
    const writes = pod.requests.filter((r) => r.method === "PUT");
    const bodyIdx = writes.findIndex(
      (r) => r.url.startsWith(CONTAINER) && r.url !== containerAclUrl && !r.url.endsWith(".acl"),
    );
    const resourceAclIdx = writes.findIndex(
      (r) => r.url.endsWith(".acl") && r.url !== containerAclUrl,
    );
    expect(bodyIdx).toBeGreaterThanOrEqual(0);
    expect(resourceAclIdx).toBeGreaterThanOrEqual(0);
    expect(bodyIdx).toBeLessThan(resourceAclIdx); // body first, then its .acl
  });

  it("create FAILS CLOSED when the per-resource .acl PUT is rejected (403)", async () => {
    // (a) A failed `.acl` PUT makes create() throw — never silently succeed leaving
    //     a resource under unverified permissions.
    const hostile = fakePod({ resourceAclStatus: 403 });
    const s = new PodStore({ container: CONTAINER, webId: WEBID, fetch: hostile.fetchFn });
    await expect(s.create({ url: "https://example.org/secret", title: "S" })).rejects.toThrow(
      /owner-only ACL|403/i,
    );
    // And the orphaned body is cleaned up (not left without its ACL).
    const orphanBodies = [...hostile.store.keys()].filter(
      (k) => k.startsWith(CONTAINER) && k !== CONTAINER && !k.endsWith(".acl"),
    );
    expect(orphanBodies).toEqual([]);
    // A DELETE was issued to clean up.
    expect(hostile.requests.some((r) => r.method === "DELETE")).toBe(true);
  });

  it("create FAILS CLOSED when the container ACL cannot be established (403)", async () => {
    // The container owner-only guarantee can't be confirmed → refuse to store at all.
    const hostile = fakePod({ containerAclStatus: 403 });
    const s = new PodStore({ container: CONTAINER, webId: WEBID, fetch: hostile.fetchFn });
    await expect(s.create({ url: "https://example.org/x", title: "X" })).rejects.toThrow(
      /owner-only ACL|container/i,
    );
    // No resource body was ever written (we refused before creating anything).
    const bodies = [...hostile.store.keys()].filter(
      (k) => k.startsWith(CONTAINER) && k !== CONTAINER && !k.endsWith(".acl"),
    );
    expect(bodies).toEqual([]);
  });

  it("create FAILS CLOSED when the container ACL is 405 but NOT confirmable as owner-private", async () => {
    // 405 (no writable container .acl) is only acceptable if the EXISTING container
    // .acl can be confirmed owner-private. A public (foaf:Agent) one must fail closed.
    const publicAcl =
      "@prefix acl: <http://www.w3.org/ns/auth/acl#> .\n" +
      "@prefix foaf: <http://xmlns.com/foaf/0.1/> .\n" +
      `[ a acl:Authorization; acl:accessTo <${CONTAINER}>; acl:default <${CONTAINER}>;` +
      " acl:agentClass foaf:Agent; acl:mode acl:Read ] .\n";
    const hostile = fakePod({ containerAclStatus: 405, existingContainerAcl: publicAcl });
    const s = new PodStore({ container: CONTAINER, webId: WEBID, fetch: hostile.fetchFn });
    await expect(s.create({ url: "https://example.org/x", title: "X" })).rejects.toThrow(
      /owner-only ACL|container/i,
    );
  });

  it("create SUCCEEDS on a 405 container ACL that IS confirmed owner-private", async () => {
    // Fixed-policy server: no writable container .acl (405) but the existing one is
    // already owner-private (no agentClass). Accepted — the container default secures
    // children — and the resource .acl 405 is then also acceptable.
    const privateAcl =
      "@prefix acl: <http://www.w3.org/ns/auth/acl#> .\n" +
      `[ a acl:Authorization; acl:accessTo <${CONTAINER}>; acl:default <${CONTAINER}>;` +
      ` acl:agent <${WEBID}>; acl:mode acl:Read, acl:Write, acl:Control ] .\n`;
    const fixed = fakePod({
      containerAclStatus: 405,
      resourceAclStatus: 405,
      existingContainerAcl: privateAcl,
    });
    const s = new PodStore({ container: CONTAINER, webId: WEBID, fetch: fixed.fetchFn });
    const created = await s.create({ url: "https://example.org/ok", title: "OK" });
    expect(created.iri.startsWith(CONTAINER)).toBe(true);
    // The body was written (and not cleaned up).
    const bodies = [...fixed.store.keys()].filter(
      (k) => k.startsWith(CONTAINER) && k !== CONTAINER && !k.endsWith(".acl"),
    );
    expect(bodies).toHaveLength(1);
  });

  // --------------------------------------------------------------------------
  // POSITIVE-VALIDATION ACL matrix (suite-tracker-uf6 — HIGH fail-open fix).
  //
  // `containerIsAlreadyOwnerPrivate()` must POSITIVELY prove the existing container
  // `.acl` is owner-only before the 405 path is allowed to proceed. Every malformed
  // / under-specified / over-permissive ACL below must FAIL CLOSED: create() throws
  // and writes NO resource body. Only a complete owner-only accessTo+default+RWC
  // authorization (and no other grant) lets create() succeed.
  // --------------------------------------------------------------------------
  const ACL_PREFIXES =
    "@prefix acl: <http://www.w3.org/ns/auth/acl#> .\n" +
    "@prefix foaf: <http://xmlns.com/foaf/0.1/> .\n";

  /** Assert: a 405 container ACL with the given existing `.acl` body FAILS CLOSED. */
  async function expectFailsClosed(existingContainerAcl: string) {
    const hostile = fakePod({ containerAclStatus: 405, existingContainerAcl });
    const s = new PodStore({ container: CONTAINER, webId: WEBID, fetch: hostile.fetchFn });
    await expect(s.create({ url: "https://example.org/x", title: "X" })).rejects.toThrow(
      /owner-only ACL|container/i,
    );
    // Nothing was written — we refused before creating any resource body.
    const bodies = [...hostile.store.keys()].filter(
      (k) => k.startsWith(CONTAINER) && k !== CONTAINER && !k.endsWith(".acl"),
    );
    expect(bodies).toEqual([]);
  }

  it("FAILS CLOSED: an EMPTY container ACL is not owner-private", async () => {
    // An empty `.acl` proves nothing — the old negative check wrongly passed it.
    await expectFailsClosed(ACL_PREFIXES);
  });

  it("FAILS CLOSED: owner accessTo but MISSING acl:default (children unprotected)", async () => {
    // Without acl:default, created CHILD resources are NOT covered — fail closed.
    await expectFailsClosed(
      ACL_PREFIXES +
        `[ a acl:Authorization; acl:accessTo <${CONTAINER}>;` +
        ` acl:agent <${WEBID}>; acl:mode acl:Read, acl:Write, acl:Control ] .\n`,
    );
  });

  it("FAILS CLOSED: missing acl:accessTo (only default) is not a complete owner authz", async () => {
    await expectFailsClosed(
      ACL_PREFIXES +
        `[ a acl:Authorization; acl:default <${CONTAINER}>;` +
        ` acl:agent <${WEBID}>; acl:mode acl:Read, acl:Write, acl:Control ] .\n`,
    );
  });

  it("FAILS CLOSED: owner authz MISSING acl:Control mode", async () => {
    await expectFailsClosed(
      ACL_PREFIXES +
        `[ a acl:Authorization; acl:accessTo <${CONTAINER}>; acl:default <${CONTAINER}>;` +
        ` acl:agent <${WEBID}>; acl:mode acl:Read, acl:Write ] .\n`,
    );
  });

  it("FAILS CLOSED: owner authz MISSING acl:Write mode", async () => {
    await expectFailsClosed(
      ACL_PREFIXES +
        `[ a acl:Authorization; acl:accessTo <${CONTAINER}>; acl:default <${CONTAINER}>;` +
        ` acl:agent <${WEBID}>; acl:mode acl:Read, acl:Control ] .\n`,
    );
  });

  it("FAILS CLOSED: a NON-owner third-party acl:agent grant alongside the owner", async () => {
    // A complete owner authz exists, but a SECOND authz grants a third party — the
    // foreign-grant guard must disqualify the whole document.
    await expectFailsClosed(
      ACL_PREFIXES +
        `[ a acl:Authorization; acl:accessTo <${CONTAINER}>; acl:default <${CONTAINER}>;` +
        ` acl:agent <${WEBID}>; acl:mode acl:Read, acl:Write, acl:Control ] .\n` +
        `[ a acl:Authorization; acl:accessTo <${CONTAINER}>; acl:default <${CONTAINER}>;` +
        " acl:agent <https://eve.pod/profile/card#me>; acl:mode acl:Read ] .\n",
    );
  });

  it("FAILS CLOSED: an acl:agentClass foaf:Agent (public) grant", async () => {
    await expectFailsClosed(
      ACL_PREFIXES +
        `[ a acl:Authorization; acl:accessTo <${CONTAINER}>; acl:default <${CONTAINER}>;` +
        ` acl:agent <${WEBID}>; acl:mode acl:Read, acl:Write, acl:Control ] .\n` +
        `[ a acl:Authorization; acl:accessTo <${CONTAINER}>; acl:default <${CONTAINER}>;` +
        " acl:agentClass foaf:Agent; acl:mode acl:Read ] .\n",
    );
  });

  it("FAILS CLOSED: an acl:agentClass acl:AuthenticatedAgent grant", async () => {
    await expectFailsClosed(
      ACL_PREFIXES +
        `[ a acl:Authorization; acl:accessTo <${CONTAINER}>; acl:default <${CONTAINER}>;` +
        ` acl:agent <${WEBID}>; acl:mode acl:Read, acl:Write, acl:Control ] .\n` +
        `[ a acl:Authorization; acl:accessTo <${CONTAINER}>; acl:default <${CONTAINER}>;` +
        " acl:agentClass acl:AuthenticatedAgent; acl:mode acl:Read ] .\n",
    );
  });

  it("FAILS CLOSED: owner authz for a DIFFERENT container target (wrong accessTo/default)", async () => {
    // The complete owner authz targets some OTHER container — it does not protect
    // THIS container, so it is no proof for this one.
    const other = "https://alice.pod/other/";
    await expectFailsClosed(
      ACL_PREFIXES +
        `[ a acl:Authorization; acl:accessTo <${other}>; acl:default <${other}>;` +
        ` acl:agent <${WEBID}>; acl:mode acl:Read, acl:Write, acl:Control ] .\n`,
    );
  });

  it("FAILS CLOSED: an unfetchable / unparseable existing container ACL", async () => {
    // A 405 with no readable existing `.acl` (GET 404s) → cannot confirm → fail closed.
    const hostile = fakePod({ containerAclStatus: 405 });
    const s = new PodStore({ container: CONTAINER, webId: WEBID, fetch: hostile.fetchFn });
    await expect(s.create({ url: "https://example.org/x", title: "X" })).rejects.toThrow(
      /owner-only ACL|container/i,
    );
    const bodies = [...hostile.store.keys()].filter(
      (k) => k.startsWith(CONTAINER) && k !== CONTAINER && !k.endsWith(".acl"),
    );
    expect(bodies).toEqual([]);
  });

  it("POSITIVE: a complete owner-only accessTo+default+RWC ACL lets create SUCCEED", async () => {
    // Owner authz with accessTo + default + Read/Write/Control + no other grant — the
    // single shape that positively proves owner-only. create() must succeed.
    const ownerOnly =
      ACL_PREFIXES +
      `[ a acl:Authorization; acl:accessTo <${CONTAINER}>; acl:default <${CONTAINER}>;` +
      ` acl:agent <${WEBID}>; acl:mode acl:Read, acl:Write, acl:Control ] .\n`;
    const fixed = fakePod({
      containerAclStatus: 405,
      resourceAclStatus: 405,
      existingContainerAcl: ownerOnly,
    });
    const s = new PodStore({ container: CONTAINER, webId: WEBID, fetch: fixed.fetchFn });
    const created = await s.create({ url: "https://example.org/ok", title: "OK" });
    expect(created.iri.startsWith(CONTAINER)).toBe(true);
    const bodies = [...fixed.store.keys()].filter(
      (k) => k.startsWith(CONTAINER) && k !== CONTAINER && !k.endsWith(".acl"),
    );
    expect(bodies).toHaveLength(1);
  });

  it("POSITIVE: a SPLIT owner-only ACL (accessTo + default on SEPARATE authzs) lets create SUCCEED", async () => {
    // WAC validly expresses access + default as TWO separate owner-only
    // authorizations. Both are owner+RWC, no other grant — independently they cover
    // accessTo and default, so the document IS owner-private. create() must succeed.
    // (This is the round-2 regression: the over-strict same-subject check rejected it.)
    const splitOwnerOnly =
      ACL_PREFIXES +
      `[ a acl:Authorization; acl:accessTo <${CONTAINER}>;` +
      ` acl:agent <${WEBID}>; acl:mode acl:Read, acl:Write, acl:Control ] .\n` +
      `[ a acl:Authorization; acl:default <${CONTAINER}>;` +
      ` acl:agent <${WEBID}>; acl:mode acl:Read, acl:Write, acl:Control ] .\n`;
    const fixed = fakePod({
      containerAclStatus: 405,
      resourceAclStatus: 405,
      existingContainerAcl: splitOwnerOnly,
    });
    const s = new PodStore({ container: CONTAINER, webId: WEBID, fetch: fixed.fetchFn });
    const created = await s.create({ url: "https://example.org/split-ok", title: "OK" });
    expect(created.iri.startsWith(CONTAINER)).toBe(true);
    const bodies = [...fixed.store.keys()].filter(
      (k) => k.startsWith(CONTAINER) && k !== CONTAINER && !k.endsWith(".acl"),
    );
    expect(bodies).toHaveLength(1);
  });

  it("establishes the container ACL only ONCE across multiple creates", async () => {
    await podStore.create({ url: "https://example.org/1", title: "1" });
    await podStore.create({ url: "https://example.org/2", title: "2" });
    const containerAclWrites = pod.requests.filter(
      (r) => r.method === "PUT" && r.url === `${CONTAINER}.acl`,
    );
    expect(containerAclWrites).toHaveLength(1); // memoised
  });

  it("create round-trips through list/get", async () => {
    const created = await podStore.create({
      url: "https://example.org/article",
      title: "Great article",
      description: "blurb",
      notes: "## why",
      tags: ["solid", "rdf"],
    });
    expect(created.iri.startsWith(CONTAINER)).toBe(true);
    expect(created.etag).toBeTruthy();

    const list = await podStore.list();
    expect(list).toHaveLength(1);
    expect(list[0].url).toBe("https://example.org/article");
    expect(list[0].title).toBe("Great article");
    expect([...(list[0].tags ?? [])].sort()).toEqual(["rdf", "solid"]);
    expect(list[0].notes).toBe("## why");
    expect(list[0].archived).toBe(false);
  });

  it("list returns empty for a missing container", async () => {
    expect(await podStore.list()).toEqual([]);
  });

  it("update sends If-Match with the prior ETag", async () => {
    const created = await podStore.create({ url: "https://example.org/x", title: "X" });
    pod.requests.length = 0;
    await podStore.update({ ...created, title: "X edited" });
    const put = pod.requests.find((r) => r.method === "PUT" && !r.url.endsWith(".acl"));
    expect(put?.headers["if-match"]).toBe(created.etag);
    const reread = await podStore.get(created.iri);
    expect(reread?.title).toBe("X edited");
  });

  it("setArchived flips the archived flag", async () => {
    const created = await podStore.create({ url: "https://example.org/y" });
    const archived = await podStore.setArchived(created, true);
    expect(archived.archived).toBe(true);
    const reread = await podStore.get(created.iri);
    expect(reread?.archived).toBe(true);
  });

  it("remove deletes the resource", async () => {
    const created = await podStore.create({ url: "https://example.org/z" });
    await podStore.remove(created.iri);
    expect(await podStore.get(created.iri)).toBeUndefined();
  });

  it("get returns undefined for a non-bookmark resource", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response("@prefix foaf: <http://xmlns.com/foaf/0.1/> .\n<#me> a foaf:Person .", {
          status: 200,
          headers: { "content-type": "text/turtle" },
        }),
    ) as unknown as typeof globalThis.fetch;
    const s = new PodStore({ container: CONTAINER, webId: WEBID, fetch: fetchSpy });
    expect(await s.get(`${CONTAINER}not-a-bookmark`)).toBeUndefined();
  });

  it("list skips resources that fail to parse, keeping the valid ones", async () => {
    await podStore.create({ url: "https://example.org/ok" });
    // Inject a junk resource directly into the fake pod + listing.
    pod.store.set(`${CONTAINER}junk`, {
      body: "<<< not turtle >>>",
      contentType: "text/turtle",
      etag: '"junk"',
    });
    const list = await podStore.list();
    expect(list.map((b) => b.url)).toEqual(["https://example.org/ok"]);
  });

  it("uses the serializer that produces parseable bookmark Turtle", async () => {
    // sanity: the package serializer + our parse agree (no hand-built RDF drift)
    const ttl = await serializeBookmark(`${CONTAINER}s`, { url: "https://e.org/s", title: "S" });
    expect(ttl).toContain("https://e.org/s");
  });
});
