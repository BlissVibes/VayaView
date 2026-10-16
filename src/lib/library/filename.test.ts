import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseReleaseName, sampleReleaseName } from "./filename.ts";

describe("parseReleaseName", () => {
  it("reads title and year and ignores release junk", () => {
    assert.deepEqual(parseReleaseName("Lantern.Night.2019.1080p.BluRay.x264.mkv"), {
      title: "Lantern Night",
      year: 2019,
    });
    assert.deepEqual(parseReleaseName("Age of Rust (2014).mkv"), {
      title: "Age of Rust",
      year: 2014,
    });
    assert.deepEqual(parseReleaseName("/movies/The.Cinder.Stair.2016.1080p.BluRay.x264.mkv"), {
      title: "The Cinder Stair",
      year: 2016,
    });
  });

  it("does not invent a genre from the words in the name", () => {
    const parsed = parseReleaseName("Horror.Movie.2020.1080p.mkv");
    assert.deepEqual(parsed, { title: "Horror Movie", year: 2020 });
    assert.equal("genres" in parsed, false);
  });

  it("round-trips a dotted sample name back to title and year", () => {
    const name = sampleReleaseName("Age of Rust", 2014);
    assert.equal(name, "Age.of.Rust.2014.1080p.BluRay.x264.mkv");
    assert.deepEqual(parseReleaseName(name), { title: "Age of Rust", year: 2014 });
  });
});
