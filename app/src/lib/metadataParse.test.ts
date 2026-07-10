import { describe, it, expect } from "vitest";
import { parseArtistTitle, stripYoutubeId, sanitizeForFilename, YT_ID_SUFFIX } from "./metadataParse";

describe("parseArtistTitle", () => {
  it("splits a clean 'Artist - Title'", () => {
    expect(parseArtistTitle("Daft Punk - Around the World")).toEqual({
      artist: "Daft Punk",
      title: "Around the World",
    });
  });

  it("strips a file extension before splitting", () => {
    expect(parseArtistTitle("Boards of Canada - Roygbiv.flac")).toEqual({
      artist: "Boards of Canada",
      title: "Roygbiv",
    });
  });

  it("strips a trailing YouTube ID before splitting", () => {
    expect(parseArtistTitle("Aphex Twin - Xtal [dQw4w9WgXcQ].mp3")).toEqual({
      artist: "Aphex Twin",
      title: "Xtal",
    });
  });

  it("returns null when there is no ' - ' separator", () => {
    expect(parseArtistTitle("just_a_title.mp3")).toBeNull();
  });

  it("returns null when the separator is at the very start", () => {
    expect(parseArtistTitle(" - Title")).toBeNull();
  });

  it("keeps a hyphen that isn't a ' - ' separator", () => {
    expect(parseArtistTitle("Jay-Z - 99 Problems")).toEqual({
      artist: "Jay-Z",
      title: "99 Problems",
    });
  });
});

describe("stripYoutubeId", () => {
  it("removes a bracketed 11-char id at the end", () => {
    expect(stripYoutubeId("Song Title [abcdefghijk]")).toBe("Song Title");
  });

  it("removes the id even before an extension", () => {
    expect(stripYoutubeId("Song [abcdefghijk].opus")).toBe("Song.opus");
  });

  it("leaves ids of the wrong length alone", () => {
    expect(stripYoutubeId("Song [tooshort]")).toBe("Song [tooshort]");
  });

  it("YT_ID_SUFFIX matches an 11-char id", () => {
    expect(YT_ID_SUFFIX.test("x [ABCDEFGHIJK]")).toBe(true);
  });
});

describe("sanitizeForFilename", () => {
  it("replaces filesystem-reserved characters with underscores", () => {
    expect(sanitizeForFilename('a/b:c*d?"e<f>g|h\\i')).toBe("a_b_c_d__e_f_g_h_i");
  });

  it("leaves ordinary characters untouched", () => {
    expect(sanitizeForFilename("Simon & Garfunkel")).toBe("Simon & Garfunkel");
  });
});
