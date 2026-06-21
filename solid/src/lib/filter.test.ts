// AUTHORED-BY Claude Opus 4.8
import { describe, expect, it } from "vitest";
import { applyQuery, EMPTY_QUERY, parseSearch, tagCloud } from "./filter.js";
import type { PodBookmark } from "./types.js";

function bm(partial: Partial<PodBookmark> & { iri: string; url: string }): PodBookmark {
  return { ...partial };
}

const fixtures: PodBookmark[] = [
  bm({ iri: "a", url: "https://solidproject.org", title: "Solid", tags: ["solid", "rdf"] }),
  bm({ iri: "b", url: "https://react.dev", title: "React docs", tags: ["js", "react"] }),
  bm({
    iri: "c",
    url: "https://example.org/archived",
    title: "Old thing",
    tags: ["solid"],
    archived: true,
  }),
  bm({ iri: "d", url: "https://nodejs.org", description: "JS runtime", tags: ["js"] }),
];

describe("parseSearch", () => {
  it("splits free-text terms and #tag tokens", () => {
    expect(parseSearch("hello #solid world #rdf")).toEqual({
      terms: ["hello", "world"],
      tags: ["solid", "rdf"],
    });
  });
  it("lowercases everything", () => {
    expect(parseSearch("FOO #BAR")).toEqual({ terms: ["foo"], tags: ["bar"] });
  });
  it("ignores a bare #", () => {
    expect(parseSearch("# hi")).toEqual({ terms: ["#", "hi"], tags: [] });
  });
});

describe("applyQuery", () => {
  it("default shows only active bookmarks", () => {
    const out = applyQuery(fixtures, EMPTY_QUERY);
    expect(out.map((b) => b.iri).sort()).toEqual(["a", "b", "d"]);
  });

  it("archived view shows only archived", () => {
    const out = applyQuery(fixtures, { ...EMPTY_QUERY, view: "archived" });
    expect(out.map((b) => b.iri)).toEqual(["c"]);
  });

  it("free-text term matches title/description/url/tags", () => {
    expect(applyQuery(fixtures, { ...EMPTY_QUERY, search: "react" }).map((b) => b.iri)).toEqual([
      "b",
    ]);
    expect(applyQuery(fixtures, { ...EMPTY_QUERY, search: "runtime" }).map((b) => b.iri)).toEqual([
      "d",
    ]);
  });

  it("all terms must match (AND)", () => {
    expect(applyQuery(fixtures, { ...EMPTY_QUERY, search: "js nope" })).toHaveLength(0);
  });

  it("#tag in search filters by tag (AND)", () => {
    const out = applyQuery(fixtures, { ...EMPTY_QUERY, search: "#js" });
    expect(out.map((b) => b.iri).sort()).toEqual(["b", "d"]);
  });

  it("selectedTags combine with search tags", () => {
    const out = applyQuery(fixtures, { ...EMPTY_QUERY, selectedTags: ["solid"] });
    expect(out.map((b) => b.iri)).toEqual(["a"]); // c is archived
  });

  it("tag matching is case-insensitive", () => {
    const out = applyQuery(fixtures, { ...EMPTY_QUERY, selectedTags: ["SOLID"] });
    expect(out.map((b) => b.iri)).toEqual(["a"]);
  });
});

describe("tagCloud", () => {
  it("counts tags across active bookmarks, sorted", () => {
    expect(tagCloud(fixtures)).toEqual([
      { tag: "js", count: 2 },
      { tag: "rdf", count: 1 },
      { tag: "react", count: 1 },
      { tag: "solid", count: 1 }, // c (archived) not counted
    ]);
  });
});
