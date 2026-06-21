#!/usr/bin/env node
// AUTHORED-BY Claude Opus 4.8
/**
 * Generate the deploy-origin-specific federation files:
 *   - public/clientid.jsonld  — the Solid Client Identifier Document, whose URL
 *     MUST equal `client_id` byte-for-byte (the solid-client-id rule), carrying
 *     an inline `fed:App` self-description block.
 *   - public/federation-membership.ttl — a `fedreg:Membership(status:Active)`
 *     record, built via `@jeswr/federation-registry`'s `buildMembership` (one of
 *     the first real Memberships in the suite registry).
 *
 * Usage:
 *   ORIGIN=https://linkding.vercel.app \
 *   ASSERTED_BY=https://jeswr.solidcommunity.net/profile/card#me \
 *   node scripts/gen-federation.mjs
 *
 * ORIGIN defaults to http://localhost:5173 (Vite dev) so a local run works.
 * ASSERTED_BY (the registry authority's WebID) defaults to a clearly-marked
 * PLACEHOLDER — the maintainer's WebID is a `needs:user` input; the generated
 * file flags it so it is never silently shipped as authoritative.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMembership } from "@jeswr/federation-registry";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, "..", "public");

const ORIGIN = (process.env.ORIGIN ?? "http://localhost:5173").replace(/\/$/, "");
// A syntactically-valid placeholder IRI (no spaces — it must serialise as a clean
// NamedNode). The "needs:user — replace before go-live" note is surfaced in the
// console output below, not baked into the IRI.
const PLACEHOLDER_WEBID = "https://w3id.org/jeswr/PLACEHOLDER-maintainer-webid#me";
const ASSERTED_BY = process.env.ASSERTED_BY ?? PLACEHOLDER_WEBID;

const CLIENT_ID = `${ORIGIN}/clientid.jsonld`;
const SECTOR = "https://w3id.org/jeswr/sectors/bookmarks#sector";
const BOOKMARK_CLASS = "https://w3id.org/jeswr/bookmark#Bookmark";
const BOOKMARK_SHAPE = "https://w3id.org/jeswr/sectors/bookmarks/shapes#BookmarkShape";

const clientIdDoc = {
  "@context": [
    "https://www.w3.org/ns/solid/oidc-context.jsonld",
    {
      fed: "https://w3id.org/jeswr/fed#",
      sector: { "@id": "fed:sector", "@type": "@id" },
      produces: { "@id": "fed:produces", "@type": "@id" },
      declaresShape: { "@id": "fed:declaresShape", "@type": "@id" },
      access: "fed:access",
      App: "fed:App",
    },
  ],
  client_id: CLIENT_ID,
  client_name: "linkding (pod-backed)",
  client_uri: `${ORIGIN}/`,
  logo_uri: `${ORIGIN}/logo.png`,
  redirect_uris: [`${ORIGIN}/callback.html`],
  scope: "openid webid offline_access",
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
  "@type": "App",
  sector: SECTOR,
  access: ["Read", "Write"],
  produces: [BOOKMARK_CLASS],
  declaresShape: [BOOKMARK_SHAPE],
};

const membership = buildMembership({
  id: `${ORIGIN}/federation-membership.ttl#membership`,
  app: CLIENT_ID,
  status: "Active",
  assertedBy: ASSERTED_BY,
});

await mkdir(PUBLIC, { recursive: true });
await writeFile(
  join(PUBLIC, "clientid.jsonld"),
  `${JSON.stringify(clientIdDoc, null, 2)}\n`,
);
await writeFile(
  join(PUBLIC, "federation-membership.ttl"),
  await membership.toString(),
);

console.log(`Generated federation files for origin ${ORIGIN}`);
console.log(`  client_id    = ${CLIENT_ID}`);
console.log(`  sector       = ${SECTOR}`);
console.log(`  produces     = ${BOOKMARK_CLASS}`);
console.log(`  assertedBy   = ${ASSERTED_BY}`);
if (ASSERTED_BY === PLACEHOLDER_WEBID) {
  console.log("  ⚠ assertedBy is a PLACEHOLDER — set ASSERTED_BY=<maintainer WebID> before go-live.");
}
