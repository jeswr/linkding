# linkding · pod-backed (Solid frontend)

[Linkding](https://github.com/sissbruecker/linkding)'s bookmark UX, **backed by your
own [Solid](https://solidproject.org) pod** instead of its Django database. A thin,
static, single-page app that does Linkding's bookmark CRUD directly against pod LDP
resources rather than the Django `/api/bookmarks/` endpoints — so your bookmarks are
**user-owned and cross-app** (the suite's Pod Manager bookmarks view reads the same
resources, the same `book:Bookmark` model).

This is the **frontend only** — there is no Django, no server, no hosted backend. It
deploys as a zero-cost static bundle (Vercel free tier, any CDN).

> Experimental, AI-agent-generated. Not a production-hardened or supported service.

## Recognizable Linkding UX, reproduced

- Bookmark **list** with title link, host, tags, description, notes
- **Add / edit** form (url, title, description, tags, notes)
- **Archive / unarchive** and **remove**
- **Tag-cloud** side panel + click-to-filter
- **Search** box with free-text terms and `#tag` tokens (AND-combined)
- **Active / Archived** views
- Light + dark via `prefers-color-scheme`

## Data model — `@jeswr/solid-bookmark`

Bookmarks are stored as RDF via the published
[`@jeswr/solid-bookmark`](https://github.com/jeswr/solid-bookmark) model
(`book:Bookmark` + `book:archived` + `book:notes`, reusing `schema:url` /
`schema:keywords` (tags) + Dublin Core for title/description/created/modified). All
reads/writes go through the package's typed `buildBookmark` / `serializeBookmark` /
`parseBookmark` accessors — **no hand-built RDF**.

## Storage layout — one LDP resource per bookmark (the design choice)

Each bookmark is its **own** Turtle resource in a single container
(`${storage}bookmarks/`), carrying exactly one `book:Bookmark`. Chosen over a single
aggregate document because:

- **Per-resource WAC** — an individual bookmark can be shared or locked independently.
- **Cheap listing** — the bookmark list is the container's `ldp:contains`; enumerating
  doesn't parse a single huge document.
- **No write contention** — each edit is an `If-Match` conditional `PUT` against only
  that bookmark's ETag (optimistic concurrency), not the whole collection.
- **Cross-app parity** — it matches the Pod Manager's per-resource read model, so its
  bookmarks view reads the SAME resources with no translation.

The trade-off — N requests to hydrate the full list — is fine for a personal bookmark
store and is mitigated by client-side caching plus the fact that filter/search run
entirely over the already-fetched in-memory list. An owner-only WAC ACL is written
**first** (before the body) on create, so a bookmark is never briefly world-readable.

## Login — Solid-OIDC, WebID-first

Login uses [`@solid/reactive-authentication`](https://www.npmjs.com/package/@solid/reactive-authentication)
(DPoP-bound Solid-OIDC) behind a clean **auth `fetch` seam**: the whole data layer +
UI depend only on an injectable authenticated `fetch` + the logged-in WebID, so they
are fully unit-testable with a stub and work with any authed-fetch implementation. The
login surface asks for the user's **WebID**, dereferences it for `solid:oidcIssuer`,
and runs the authorization-code flow.

A static [Client Identifier Document](https://solidproject.org/TR/oidc#clientids) is
served at `/clientid.jsonld` (its URL **is** the `client_id`), so the consent screen
shows this app's name. It is **generated per deploy origin** (`npm run gen-federation`)
so `client_id` always equals the served URL byte-for-byte.

## Federation registration

`/clientid.jsonld` carries an inline `fed:App` self-description block:

- `fed:sector` → `https://w3id.org/jeswr/sectors/bookmarks#sector`
- `fed:produces` → `https://w3id.org/jeswr/bookmark#Bookmark`
- `fed:declaresShape` → `https://w3id.org/jeswr/sectors/bookmarks/shapes#BookmarkShape`
- `fed:access` → `Read`, `Write`

`/federation-membership.ttl` is a `fedreg:Membership(status: Active)` record built via
[`@jeswr/federation-registry`](https://github.com/jeswr/federation-registry)'s
`buildMembership` — one of the first real Memberships in the suite registry. Its
`fedreg:assertedBy` is the registry authority's WebID; until the maintainer's WebID is
supplied it is a clearly-marked placeholder (set `ASSERTED_BY=<webid>` before go-live).

## Develop

```bash
npm install
npm run dev          # Vite dev server (http://localhost:5173)
npm run gate         # not a script; run the four below
npm run lint         # tsc --noEmit
npm run test         # vitest run
npm run build        # gen-federation + tsc -b + vite build → dist/
```

## Deploy (static)

```bash
ORIGIN=https://your-app.example \
ASSERTED_BY=https://you.solidcommunity.net/profile/card#me \
npm run build
# upload dist/ to any static host (Vercel config in vercel.json)
```

## Follow-ups

- **Offline-first** via [`@jeswr/solid-offline`](https://github.com/jeswr/solid-offline)
  (stale-while-revalidate, instant paint) — documented follow-up.
- **Silent session restore** via
  [`@jeswr/solid-session-restore`](https://github.com/jeswr/solid-session-restore) —
  the dependency is wired; full IndexedDB refresh-token restore is a follow-up.
- **Multiple issuers / storages** — the MVP takes the first; the UX spec is to let the
  user pick.
- **`@jeswr/app-shell` chrome** — the dependency is available; adopting its
  `ThemeProvider`/`AccountMenu`/`FeedbackButton` for full suite parity is a follow-up.

## License

MIT (inherits Linkding's license).
