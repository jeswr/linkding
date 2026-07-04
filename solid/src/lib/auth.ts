// AUTHORED-BY Claude Opus 4.8
import { fetchRdf } from "@jeswr/fetch-rdf";

/**
 * The auth seam. The whole app (data layer + UI) depends only on an injectable
 * authenticated `fetch` plus the logged-in WebID + storage container — NOT on any
 * particular login implementation. `@solid/reactive-authentication` is wired in at
 * the UI edge (see {@link startLogin}); everything else stays server-and-library
 * agnostic and unit-testable with a stub `fetch`.
 */
export interface Session {
  webId: string;
  /** The chosen `pim:storage` base (we derive the bookmarks container from it). */
  storage: string;
  /** The DPoP-authenticated fetch (after login, this is the patched `globalThis.fetch`). */
  fetch: typeof globalThis.fetch;
}

const SOLID_OIDC_ISSUER = "http://www.w3.org/ns/solid/terms#oidcIssuer";
const PIM_STORAGE = "http://www.w3.org/ns/pim/space#storage";

/** Validate a WebID string is an absolute http(s) URL. */
export function isValidWebId(webId: string): boolean {
  try {
    const u = new URL(webId);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/** The OIDC issuer(s) advertised by a WebID profile (`solid:oidcIssuer`). */
export async function resolveIssuers(
  webId: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<string[]> {
  const { dataset } = await fetchRdf(webId, { fetch: fetchFn });
  const issuers: string[] = [];
  for (const q of dataset.match(null, null, null)) {
    if (q.predicate.value === SOLID_OIDC_ISSUER && q.object.termType === "NamedNode") {
      issuers.push(q.object.value);
    }
  }
  return issuers;
}

/**
 * Validate + normalise a raw `pim:storage` value into a canonical container address:
 * an absolute `http(s)` URL, no query/fragment, path forced to end with `/` (a
 * `pim:storage` value names a container, so any resource-shaped value is treated as
 * that container's root). A profile document is untrusted input (it may be someone
 * else's, or forged), so this is the ONLY place `resolveStorages` trusts a
 * `pim:storage` object — everything downstream (this file, `App.tsx`) then builds
 * sub-paths via `new URL(child, base)` against the returned, already-normalised base
 * rather than string-concatenating the raw value.
 *
 * Returns `undefined` (drop, don't throw — a malformed value from one predicate
 * instance must not abort resolution of the others) when the value:
 *   - is not a parseable absolute URL;
 *   - is not `http:`/`https:` (refuses `file:`, `javascript:`, `data:`, …);
 *   - carries a `search` or `hash` (a container address carries neither — a
 *     `?`/`#`-bearing value is not a legitimate storage root).
 */
function normalizeStorageRoot(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return undefined;
  }
  if (url.search !== "" || url.hash !== "") {
    return undefined;
  }
  if (!url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`;
  }
  return url.toString();
}

/** The storage container(s) advertised by a WebID profile (`pim:storage`). */
export async function resolveStorages(
  webId: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<string[]> {
  const { dataset } = await fetchRdf(webId, { fetch: fetchFn });
  const storages: string[] = [];
  for (const q of dataset.match(null, null, null)) {
    if (q.predicate.value === PIM_STORAGE && q.object.termType === "NamedNode") {
      const normalized = normalizeStorageRoot(q.object.value);
      if (normalized !== undefined) {
        storages.push(normalized);
      }
    }
  }
  return storages;
}

/** The static Client Identifier Document URL for this deployment. */
export function clientId(): string {
  return new URL("clientid.jsonld", window.location.href).toString();
}

/**
 * Trigger the Solid login flow via `@solid/reactive-authentication`. Imported
 * dynamically (browser-only: custom elements + popups) so a Node/test bundle
 * never loads it. After this resolves, `globalThis.fetch` is the DPoP-authed
 * fetch and the first protected request silently upgrades on 401.
 *
 * Returns the issuer the WebID resolved to (callers persist the session and
 * derive the storage separately). The actual popup/consent is driven by the
 * mounted `<authorization-code-flow>` element.
 */
export async function startLogin(webId: string): Promise<{ issuer: string }> {
  if (!isValidWebId(webId)) {
    throw new Error("Enter a valid WebID URL (https://…)");
  }
  const issuers = await resolveIssuers(webId);
  if (issuers.length === 0) {
    throw new Error(
      "This WebID can't be used for Solid login — its profile has no solid:oidcIssuer.",
    );
  }
  // Multiple issuers: take the first for the MVP, but surface the choice as a
  // documented follow-up (the skill's guidance is to let the user pick).
  const issuer = issuers[0];

  const { ReactiveFetchManager, DPoPTokenProvider } = await import(
    "@solid/reactive-authentication"
  );
  const ui = document.querySelector<HTMLElement & { getCode: unknown }>(
    "authorization-code-flow",
  );
  if (!ui) throw new Error("Login element <authorization-code-flow> is not mounted");
  const getCode = (ui.getCode as (...args: unknown[]) => unknown).bind(ui);
  const callbackUri = new URL("callback.html", window.location.href).toString();
  // 0.1.3 DPoPTokenProvider is (callbackUri, getCodeCallback, getIssuerCallback).
  // We already resolved the issuer from the WebID, so the callback returns it for
  // every protected request (the pod is single-issuer for this user).
  const getIssuer = async (): Promise<URL> => new URL(issuer);
  const manager = new ReactiveFetchManager([
    new DPoPTokenProvider(callbackUri, getCode as never, getIssuer),
  ]);
  manager.registerGlobally();
  return { issuer };
}
