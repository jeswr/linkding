// AUTHORED-BY Claude Opus 4.8
import { Parser } from "n3";
import { describe, expect, it } from "vitest";
import { ownerOnlyAcl } from "./acl.js";

const ACL = "http://www.w3.org/ns/auth/acl#";

describe("ownerOnlyAcl", () => {
  it("grants the owner Read/Write/Control and names no other agent", async () => {
    const ttl = await ownerOnlyAcl(
      "https://alice.pod/bookmarks/1",
      "https://alice.pod/profile/card#me",
    );
    const quads = new Parser().parse(ttl);

    const modes = quads
      .filter((q) => q.predicate.value === `${ACL}mode`)
      .map((q) => q.object.value)
      .sort();
    expect(modes).toEqual([`${ACL}Control`, `${ACL}Read`, `${ACL}Write`]);

    const agents = quads
      .filter((q) => q.predicate.value === `${ACL}agent`)
      .map((q) => q.object.value);
    expect(agents).toEqual(["https://alice.pod/profile/card#me"]);

    // No agentClass (no public/authenticated grant) — owner-only.
    expect(quads.some((q) => q.predicate.value === `${ACL}agentClass`)).toBe(false);

    // accessTo points at the protected resource.
    const accessTo = quads
      .filter((q) => q.predicate.value === `${ACL}accessTo`)
      .map((q) => q.object.value);
    expect(accessTo).toEqual(["https://alice.pod/bookmarks/1"]);
  });

  it("declares the authorization type", async () => {
    const ttl = await ownerOnlyAcl("https://alice.pod/b/1", "https://alice.pod/me#me");
    const quads = new Parser().parse(ttl);
    expect(
      quads.some(
        (q) =>
          q.predicate.value === "http://www.w3.org/1999/02/22-rdf-syntax-ns#type" &&
          q.object.value === `${ACL}Authorization`,
      ),
    ).toBe(true);
  });
});
