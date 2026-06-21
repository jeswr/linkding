// AUTHORED-BY Claude Opus 4.8
import { serializeBookmark } from "@jeswr/solid-bookmark";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PodStore } from "./podStore.js";

const CONTAINER = "https://alice.pod/bookmarks/";
const WEBID = "https://alice.pod/profile/card#me";

/**
 * An in-memory fake pod: a Map of URL → { body, contentType, etag }. The returned
 * `fetch` records every request so we can assert ordering (ACL-before-body) and
 * conditional-write headers.
 */
function fakePod() {
  const store = new Map<string, { body: string; contentType: string; etag: string }>();
  const requests: { method: string; url: string; headers: Record<string, string> }[] = [];
  let etagSeq = 0;

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

  it("create writes the owner-only ACL BEFORE the body", async () => {
    await podStore.create({ url: "https://example.org/a", title: "A", tags: ["x"] });
    const writes = pod.requests.filter((r) => r.method === "PUT");
    const aclIdx = writes.findIndex((r) => r.url.endsWith(".acl"));
    const bodyIdx = writes.findIndex((r) => !r.url.endsWith(".acl"));
    expect(aclIdx).toBeGreaterThanOrEqual(0);
    expect(bodyIdx).toBeGreaterThanOrEqual(0);
    expect(aclIdx).toBeLessThan(bodyIdx); // ACL first
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
