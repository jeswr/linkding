// AUTHORED-BY Claude Opus 4.8
import { describe, expect, it } from "vitest";
import { isValidWebId, resolveIssuers, resolveStorages } from "./auth.js";

const PROFILE = `
@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix pim: <http://www.w3.org/ns/pim/space#> .
<https://alice.pod/profile/card#me>
  solid:oidcIssuer <https://idp.example/> ;
  pim:storage <https://alice.pod/> .
`;

function stubFetch(body: string): typeof globalThis.fetch {
  return (async () =>
    new Response(body, {
      status: 200,
      headers: { "content-type": "text/turtle" },
    })) as typeof globalThis.fetch;
}

describe("isValidWebId", () => {
  it("accepts https/http URLs", () => {
    expect(isValidWebId("https://x.pod/me#me")).toBe(true);
    expect(isValidWebId("http://localhost:3000/me#me")).toBe(true);
  });
  it("rejects non-URLs and other schemes", () => {
    expect(isValidWebId("not a url")).toBe(false);
    expect(isValidWebId("ftp://x/me")).toBe(false);
    expect(isValidWebId("javascript:alert(1)")).toBe(false);
  });
});

describe("resolveIssuers", () => {
  it("reads solid:oidcIssuer from a profile", async () => {
    const out = await resolveIssuers("https://alice.pod/profile/card#me", stubFetch(PROFILE));
    expect(out).toEqual(["https://idp.example/"]);
  });
  it("returns empty when no issuer is advertised", async () => {
    const out = await resolveIssuers(
      "https://alice.pod/profile/card#me",
      stubFetch("@prefix foaf: <http://xmlns.com/foaf/0.1/> .\n<#me> a foaf:Person ."),
    );
    expect(out).toEqual([]);
  });
});

describe("resolveStorages", () => {
  it("reads pim:storage from a profile", async () => {
    const out = await resolveStorages("https://alice.pod/profile/card#me", stubFetch(PROFILE));
    expect(out).toEqual(["https://alice.pod/"]);
  });

  it("rejects a non-http(s) pim:storage value (e.g. file:/javascript:)", async () => {
    const profile = `
@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix pim: <http://www.w3.org/ns/pim/space#> .
<https://alice.pod/profile/card#me>
  solid:oidcIssuer <https://idp.example/> ;
  pim:storage <file:///etc/passwd> ;
  pim:storage <javascript:alert(1)> .
`;
    const out = await resolveStorages("https://alice.pod/profile/card#me", stubFetch(profile));
    expect(out).toEqual([]);
  });

  it("drops a pim:storage value carrying a query or fragment, keeping valid entries", async () => {
    const profile = `
@prefix pim: <http://www.w3.org/ns/pim/space#> .
<https://alice.pod/profile/card#me>
  pim:storage <https://alice.pod/?q=/> ;
  pim:storage <https://alice.pod/storage/#/> ;
  pim:storage <https://alice.pod/real/> .
`;
    const out = await resolveStorages("https://alice.pod/profile/card#me", stubFetch(profile));
    expect(out).toEqual(["https://alice.pod/real/"]);
  });

  it("accepts a real storage root and normalises a resource-shaped value to a container", async () => {
    const profile = `
@prefix pim: <http://www.w3.org/ns/pim/space#> .
<https://alice.pod/profile/card#me>
  pim:storage <https://alice.pod/> ;
  pim:storage <https://alice.pod/storage> .
`;
    const out = await resolveStorages("https://alice.pod/profile/card#me", stubFetch(profile));
    expect(out).toEqual(["https://alice.pod/", "https://alice.pod/storage/"]);
  });
});
