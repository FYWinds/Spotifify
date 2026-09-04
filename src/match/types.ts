export type MatchStatus = "pending" | "matched" | "review" | "local" | "skipped";

export type DecidedBy = "auto" | "isrc" | "fingerprint" | "user";

/** Per-component similarity in [0, 1]; see DESIGN.md §5.3 */
export interface ScoreParts {
  title: number;
  artist: number;
  album: number;
  duration: number;
  versionTagsAgree: boolean;
}

export interface Candidate {
  id: string;
  uri: string;
  title: string;
  artists: string[];
  album: string;
  durationMs: number;
  isPlayable: boolean;
  score: number;
  parts: ScoreParts;
}

export interface MatchRow {
  canonicalKey: string;
  status: MatchStatus;
  spotifyId: string | null;
  spotifyUri: string | null;
  score: number | null;
  decidedBy: DecidedBy | null;
  candidates: Candidate[];
  decidedAt: number | null;
  lastSearchAt: number | null;
  searchCount: number;
}

/** A user decision from the review TUI or `rematch`. */
export type Decision =
  | { kind: "pick"; candidate: Candidate }
  | { kind: "uri"; spotifyUri: string }
  | { kind: "local" }
  | { kind: "skip" }
  | { kind: "reset" };
