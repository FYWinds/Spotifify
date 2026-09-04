import { describe, expect, test } from "bun:test";
import { normalizeArtists, normalizeText, normalizeTitle, similarity } from "../src/match/normalize.ts";

describe("normalizeText", () => {
  test("converts traditional to simplified so cross-strait spellings compare equal", () => {
    expect(normalizeText("周杰倫 葉惠美")).toBe(normalizeText("周杰伦 叶惠美"));
    expect(normalizeText("龍捲風")).toBe("龙卷风");
  });

  test("folds fullwidth forms, case, punctuation, and whitespace", () => {
    expect(normalizeText("Ｈｅｌｌｏ　ＷＯＲＬＤ！")).toBe("helloworld");
    expect(normalizeText("Rock & Roll... (2)")).toBe("rockroll2");
    expect(normalizeText("Beyoncé")).toBe("beyoncé");
  });
});

describe("normalizeTitle", () => {
  test("extracts version tags from any bracket style", () => {
    expect(normalizeTitle("晴天 (Live)")).toEqual({ core: "晴天", versionTags: new Set(["live"]) });
    expect(normalizeTitle("晴天（伴奏）").versionTags).toEqual(new Set(["instrumental"]));
    expect(normalizeTitle("晴天【DJ版】").versionTags).toEqual(new Set(["dj"]));
    expect(normalizeTitle("Song [Radio Edit]").versionTags).toEqual(new Set(["radio"]));
  });

  test("treats the ' - ' suffix as an annotation", () => {
    expect(normalizeTitle("Song - Live at Wembley")).toEqual({ core: "song", versionTags: new Set(["live"]) });
    expect(normalizeTitle("龍捲風 - 鋼琴版")).toEqual({ core: "龙卷风", versionTags: new Set(["piano"]) });
  });

  test("drops non-version annotations (remaster, feat., translations) without tagging", () => {
    expect(normalizeTitle("Song - Remastered 2011")).toEqual({ core: "song", versionTags: new Set() });
    expect(normalizeTitle("Song (Remastered)").versionTags.size).toBe(0);
    expect(normalizeTitle("Lemon (柠檬) feat. Kenshi")).toEqual({ core: "lemon", versionTags: new Set() });
    expect(normalizeTitle("Song ft. Someone").core).toBe("song");
  });

  test("keyword inside the main title is not a version tag", () => {
    expect(normalizeTitle("Live Forever")).toEqual({ core: "liveforever", versionTags: new Set() });
    expect(normalizeTitle("Oliver (Oliver's Version)").versionTags.size).toBe(0);
  });

  test("falls back to the whole title when only an annotation remains", () => {
    expect(normalizeTitle("(Instrumental)")).toEqual({ core: "instrumental", versionTags: new Set(["instrumental"]) });
  });
});

describe("normalizeArtists", () => {
  test("splits joint credits on every separator and dedupes", () => {
    expect(normalizeArtists(["周杰倫 / 費玉清", "費玉清"], {})).toEqual(["周杰伦", "费玉清"]);
    expect(normalizeArtists(["A feat. B", "C ft. D", "E & F", "G、H", "I x J", "K featuring L"], {})).toEqual([
      "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l",
    ]);
  });

  test("does not split on a bare 'x' inside a name", () => {
    expect(normalizeArtists(["X Japan"], {})).toEqual(["xjapan"]);
  });

  test("applies aliases after normalization on both sides", () => {
    expect(normalizeArtists(["Jay Chou"], { "jay chou": "周杰倫" })).toEqual(["周杰伦"]);
    expect(normalizeArtists(["JAY  CHOU"], { "Jay Chou": "周杰伦" })).toEqual(["周杰伦"]);
  });

  test("drops empties", () => {
    expect(normalizeArtists(["", " / ", "…"], {})).toEqual([]);
  });
});

describe("similarity", () => {
  test("is 1 for identical (including empty) strings and 0 for disjoint ones", () => {
    expect(similarity("", "")).toBe(1);
    expect(similarity("abc", "abc")).toBe(1);
    expect(similarity("abc", "xyz")).toBe(0);
  });

  test("scales edit distance by the longer string", () => {
    expect(similarity("abcd", "abce")).toBeCloseTo(0.75);
    expect(similarity("ab", "abcd")).toBeCloseTo(0.5);
  });
});
