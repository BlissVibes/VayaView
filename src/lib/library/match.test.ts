import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CATALOG } from "./catalog.ts";
import { queryTokens, searchLibrary, searchNote } from "./match.ts";
import { createFactoryState } from "./factory.ts";

function ids(query: string): string[] {
  return searchLibrary(CATALOG, query).map((hit) => hit.entry.id);
}

describe("searchLibrary", () => {
  it("pulls a whole collection, including titles that do not contain the query", () => {
    const hits = searchLibrary(CATALOG, "iron harvest");
    assert.ok(ids("iron harvest").includes("age-of-rust"));
    assert.ok(ids("iron harvest").includes("blueprints"));
    const rust = hits.find((hit) => hit.entry.id === "age-of-rust");
    assert.equal(rust?.reasons.some((reason) => reason.kind === "collection"), true);
    assert.equal(rust?.reasons.some((reason) => reason.kind === "title"), false);
    assert.equal(searchNote("iron harvest", hits)?.includes("collection"), true);
  });

  it("matches horror from the genre tag, not the title", () => {
    const hits = searchLibrary(CATALOG, "horror");
    const lantern = hits.find((hit) => hit.entry.id === "lantern-night");
    assert.ok(lantern);
    assert.equal(lantern.entry.title.toLowerCase().includes("horror"), false);
    assert.equal(lantern.reasons.some((reason) => reason.kind === "genre"), true);
    assert.equal(ids("horror").includes("iron-harvest"), false);
    assert.ok(searchNote("horror", hits)?.toLowerCase().includes("genre"));
  });

  it("treats a director and a theme as different lists", () => {
    const voss = ids("lena voss");
    const growing = ids("coming of age");
    assert.deepEqual(voss, ["winter-index", "june-roof", "longest-august", "manual-for-leaving"]);
    assert.ok(growing.includes("paper-coast"));
    assert.ok(growing.includes("manual-for-leaving"));
    assert.equal(growing.includes("winter-index"), false);
    assert.equal(voss.includes("second-bell"), false);
  });

  it("ignores empty and stop-word queries", () => {
    assert.deepEqual(queryTokens("the"), []);
    assert.deepEqual(searchLibrary(CATALOG, "  "), []);
    assert.deepEqual(searchLibrary(CATALOG, "the"), []);
  });
});

describe("factory channels", () => {
  it("are built by the same search the lineup box uses", () => {
    const state = createFactoryState();
    const iron = state.channels.find((channel) => channel.id === "ch-iron");
    const dark = state.channels.find((channel) => channel.id === "ch-dark");
    const grow = state.channels.find((channel) => channel.id === "ch-grow");
    const voss = state.channels.find((channel) => channel.id === "ch-voss");
    assert.deepEqual(iron?.mediaIds, ids("iron harvest"));
    assert.deepEqual(dark?.mediaIds, ids("horror"));
    assert.ok(grow?.mediaIds.includes("manual-for-leaving"));
    assert.equal(voss?.mediaIds.includes("second-bell"), false);
    assert.equal(iron?.mode, "loop");
    assert.equal(dark?.mode, "shuffle");
    assert.deepEqual(state.missingIds, ["blueprints", "milk-glass"]);
  });
});
