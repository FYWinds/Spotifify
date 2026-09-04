import { describe, expect, test } from "bun:test";
import { ConfigSchema } from "../src/config.ts";
import { passesAutoGate, scoreCandidate, type ScoreInput } from "../src/match/score.ts";
import type { SpotifyTrack } from "../src/spotify/types.ts";

const cfg = ConfigSchema.parse({ matching: { artist_aliases: { 周杰倫: "周杰伦" } } }).matching;

const src: ScoreInput = { title: "晴天", aliases: ["Sunny Day"], artists: ["周杰伦"], album: "叶惠美", durationMs: 269_000 };

function track(over: Partial<SpotifyTrack> = {}): SpotifyTrack {
  return {
    id: "4uLU6hMCjMI75M1A2tKUQC",
    uri: "spotify:track:4uLU6hMCjMI75M1A2tKUQC",
    name: "晴天",
    artists: [{ id: "a1", name: "周杰倫" }],
    album: { id: "al1", name: "葉惠美" },
    duration_ms: 269_500,
    is_local: false,
    is_playable: true,
    ...over,
  };
}

describe("scoreCandidate", () => {
  test("exact match (modulo script and alias table) scores 1 and passes the gate", () => {
    const { score, parts } = scoreCandidate(src, track(), cfg);
    expect(score).toBeCloseTo(1);
    expect(parts).toEqual({ title: 1, artist: 1, album: 1, duration: 1, versionTagsAgree: true });
    expect(passesAutoGate(score, parts, cfg)).toBe(true);
  });

  test("title takes the best of title and aliases", () => {
    const { parts } = scoreCandidate(src, track({ name: "Sunny Day" }), cfg);
    expect(parts.title).toBe(1);
  });

  test("missing source album and duration contribute the neutral 0.5", () => {
    const { parts } = scoreCandidate({ title: "晴天", aliases: [], artists: ["周杰伦"] }, track(), cfg);
    expect(parts.album).toBe(0.5);
    expect(parts.duration).toBe(0.5);
  });

  test("duration steps: within tolerance 1, within 10 s 0.5, beyond 0", () => {
    expect(scoreCandidate(src, track({ duration_ms: 269_000 + cfg.duration_tolerance_ms }), cfg).parts.duration).toBe(1);
    expect(scoreCandidate(src, track({ duration_ms: 269_000 + cfg.duration_tolerance_ms + 1 }), cfg).parts.duration).toBe(0.5);
    expect(scoreCandidate(src, track({ duration_ms: 279_000 }), cfg).parts.duration).toBe(0.5);
    expect(scoreCandidate(src, track({ duration_ms: 279_001 }), cfg).parts.duration).toBe(0);
  });

  test("artist is 0 when either side has no artists", () => {
    expect(scoreCandidate({ ...src, artists: [] }, track(), cfg).parts.artist).toBe(0);
    expect(scoreCandidate(src, track({ artists: [] }), cfg).parts.artist).toBe(0);
  });
});

describe("passesAutoGate", () => {
  test("duration just over tolerance still scores above threshold but fails the gate", () => {
    const { score, parts } = scoreCandidate(src, track({ duration_ms: 269_000 + cfg.duration_tolerance_ms + 1 }), cfg);
    expect(score).toBeGreaterThanOrEqual(cfg.auto_threshold);
    expect(passesAutoGate(score, parts, cfg)).toBe(false);
  });

  test("version tag mismatch fails the gate even with identical core title", () => {
    const { score, parts } = scoreCandidate(src, track({ name: "晴天 - Live" }), cfg);
    expect(parts.title).toBe(1);
    expect(parts.versionTagsAgree).toBe(false);
    expect(score).toBeGreaterThanOrEqual(cfg.auto_threshold);
    expect(passesAutoGate(score, parts, cfg)).toBe(false);
  });

  test("matching version tags on both sides agree", () => {
    const { parts } = scoreCandidate({ ...src, title: "晴天 (Live)" }, track({ name: "晴天 - Live at Taipei" }), cfg);
    expect(parts.versionTagsAgree).toBe(true);
  });

  test("weak artist match fails the gate regardless of score", () => {
    const { parts } = scoreCandidate(src, track({ artists: [{ id: "x", name: "Someone Else" }] }), cfg);
    expect(parts.artist).toBeLessThan(0.8);
    expect(passesAutoGate(1, parts, cfg)).toBe(false);
  });

  test("score threshold is inclusive", () => {
    const parts = { title: 1, artist: 1, album: 1, duration: 1, versionTagsAgree: true };
    expect(passesAutoGate(cfg.auto_threshold, parts, cfg)).toBe(true);
    expect(passesAutoGate(cfg.auto_threshold - 1e-9, parts, cfg)).toBe(false);
  });
});
