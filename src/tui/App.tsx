import { Box, Text, useApp, useInput, useStdout } from "ink";
import { useEffect, useRef, useState } from "react";
import type { Candidate, MatchRow } from "../match/types.ts";
import type { SourceTrackRow } from "../state/repo.ts";
import { openExternal } from "../util/open.ts";
import { CandidatePane, MAX_SHOWN_CANDIDATES } from "./CandidatePane.tsx";
import { SearchInput, type InputMode } from "./SearchInput.tsx";
import { ReviewList } from "./ReviewList.tsx";
import { TABS, type Queues, type ReviewItem, type Tab } from "./model.ts";

/** The subset of the matcher the TUI drives; see src/match/matcher.ts. */
export interface ReviewMatcher {
  candidatesFor(track: SourceTrackRow, query?: string): Promise<Candidate[]>;
  candidateFromUri(track: SourceTrackRow, uriOrUrl: string): Promise<Candidate | null>;
}

export interface ReviewRepo {
  upsertMatch(m: MatchRow): void;
}

export interface AppProps {
  repo: ReviewRepo;
  matcher: ReviewMatcher;
  market: string;
  initialQueues: Queues;
  /** Called with the decision count right before the app unmounts. */
  onExit: (decided: number) => void;
}

interface Status {
  text: string;
  kind: "info" | "error";
}

interface UndoEntry {
  tab: Tab;
  index: number;
  item: ReviewItem;
}

interface Location {
  tab: Tab;
  index: number;
  item: ReviewItem;
}

interface UiState {
  queues: Queues;
  tab: Tab;
  cursor: Record<Tab, number>;
  /** Candidate index for the item under the cursor. */
  selected: number;
  mode: { kind: "normal" } | { kind: "input"; input: InputMode; value: string };
  /** Canonical keys with a matcher call in flight. */
  busy: Set<string>;
  status: Status;
  decided: number;
  undo: UndoEntry[];
  showHelp: boolean;
}

const HELP =
  "j/k ↑/↓ move   Tab switch tab   1-9 select candidate   Enter confirm   o open candidate   O open source   l mark local   s skip   / search   p paste Spotify link   u undo   ? help   q quit";

const SPINNER = ["-", "\\", "|", "/"];

/** Where the source track can be inspected: the netease song page, or the local file itself. */
function sourceLink(track: SourceTrackRow): string | null {
  if (track.neteaseId !== undefined) return `https://music.163.com/#/song?id=${track.neteaseId}`;
  return track.file?.path ?? null;
}

function findItem(queues: Queues, key: string): Location | undefined {
  for (const tab of TABS) {
    const index = queues[tab].findIndex((it) => it.match.canonicalKey === key);
    if (index >= 0) return { tab, index, item: queues[tab][index]! };
  }
  return undefined;
}

function withoutKey(set: Set<string>, key: string): Set<string> {
  const next = new Set(set);
  next.delete(key);
  return next;
}

function useTerminalSize(): { columns: number; rows: number } {
  const { stdout } = useStdout();
  const [size, setSize] = useState({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
  useEffect(() => {
    const onResize = () => setSize({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);
  return size;
}

export function App({ repo, matcher, market, initialQueues, onExit }: AppProps) {
  const { exit } = useApp();
  const { rows } = useTerminalSize();
  const [state, setState] = useState<UiState>(() => ({
    queues: initialQueues,
    tab: TABS.find((t) => initialQueues[t].length > 0) ?? "review",
    cursor: { review: 0, low: 0, local: 0 },
    selected: 0,
    mode: { kind: "normal" },
    busy: new Set(),
    status: { text: "Enter confirms the highlighted candidate · ? for help", kind: "info" },
    decided: 0,
    undo: [],
    showHelp: false,
  }));
  // Mirror of `state` that handlers read so that a decision and a subsequent async result never see stale data.
  const ref = useRef(state);
  const commit = (next: UiState) => {
    ref.current = next;
    setState(next);
  };

  const [tick, setTick] = useState(0);
  const spinning = state.busy.size > 0;
  useEffect(() => {
    if (!spinning) return;
    const timer = setInterval(() => setTick((t) => t + 1), 120);
    return () => clearInterval(timer);
  }, [spinning]);

  const quit = (s: UiState) => {
    onExit(s.decided);
    exit();
  };

  const move = (s: UiState, delta: number) => {
    const n = s.queues[s.tab].length;
    if (n === 0) return;
    const c = Math.max(0, Math.min(n - 1, s.cursor[s.tab] + delta));
    commit({ ...s, cursor: { ...s.cursor, [s.tab]: c }, selected: 0 });
  };

  /** Persist `next` for `loc.item`, drop it from its queue, remember it for undo. */
  const decide = (s: UiState, loc: Location, next: MatchRow, text: string) => {
    repo.upsertMatch(next);
    const queue = s.queues[loc.tab].filter((_, i) => i !== loc.index);
    const c = s.cursor[loc.tab];
    const cursor = Math.max(0, Math.min(queue.length - 1, c > loc.index ? c - 1 : c));
    commit({
      ...s,
      queues: { ...s.queues, [loc.tab]: queue },
      cursor: { ...s.cursor, [loc.tab]: cursor },
      selected: loc.tab === s.tab && loc.index === c ? 0 : s.selected,
      decided: s.decided + 1,
      undo: [...s.undo, { tab: loc.tab, index: loc.index, item: loc.item }],
      status: { text, kind: "info" },
    });
  };

  const pick = (s: UiState, loc: Location, c: Candidate, candidates: Candidate[]) => {
    decide(
      s,
      loc,
      {
        ...loc.item.match,
        status: "matched",
        spotifyId: c.id,
        spotifyUri: c.uri,
        score: c.score,
        decidedBy: "user",
        decidedAt: Date.now(),
        candidates,
      },
      `matched: ${loc.item.track.title} → ${c.title} — ${c.artists.join(", ")} (${c.score.toFixed(2)})`,
    );
  };

  const unmatched = (s: UiState, loc: Location, status: "local" | "skipped") => {
    decide(
      s,
      loc,
      {
        ...loc.item.match,
        status,
        spotifyId: null,
        spotifyUri: null,
        score: null,
        decidedBy: "user",
        decidedAt: Date.now(),
      },
      `${status === "local" ? "marked local" : "skipped"}: ${loc.item.track.title}`,
    );
  };

  const undo = (s: UiState) => {
    const entry = s.undo[s.undo.length - 1];
    if (!entry) {
      commit({ ...s, status: { text: "nothing to undo", kind: "error" } });
      return;
    }
    repo.upsertMatch(entry.item.match);
    const list = s.queues[entry.tab];
    const index = Math.min(entry.index, list.length);
    const queue = [...list.slice(0, index), entry.item, ...list.slice(index)];
    commit({
      ...s,
      queues: { ...s.queues, [entry.tab]: queue },
      tab: entry.tab,
      cursor: { ...s.cursor, [entry.tab]: index },
      selected: 0,
      decided: s.decided - 1,
      undo: s.undo.slice(0, -1),
      status: { text: `undone: ${entry.item.track.title} is back in ${entry.tab}`, kind: "info" },
    });
  };

  const settle = (key: string, apply: (s: UiState, loc: Location | undefined) => void) => {
    const s = ref.current;
    apply({ ...s, busy: withoutKey(s.busy, key) }, findItem(s.queues, key));
  };

  const search = (s: UiState, item: ReviewItem, query: string) => {
    const key = item.match.canonicalKey;
    commit({ ...s, mode: { kind: "normal" }, busy: new Set(s.busy).add(key), status: { text: `searching "${query}"`, kind: "info" } });
    matcher.candidatesFor(item.track, query).then(
      (candidates) =>
        settle(key, (s2, loc) => {
          if (!loc) {
            commit(s2);
            return;
          }
          const next = { ...loc.item.match, candidates };
          repo.upsertMatch(next);
          const queue = s2.queues[loc.tab].with(loc.index, { ...loc.item, match: next });
          const isCurrent = loc.tab === s2.tab && loc.index === s2.cursor[loc.tab];
          commit({
            ...s2,
            queues: { ...s2.queues, [loc.tab]: queue },
            selected: isCurrent ? 0 : s2.selected,
            status: { text: `${candidates.length} candidate${candidates.length === 1 ? "" : "s"} for "${query}"`, kind: "info" },
          });
        }),
      (err: unknown) =>
        settle(key, (s2) => commit({ ...s2, status: { text: `search failed: ${err instanceof Error ? err.message : String(err)}`, kind: "error" } })),
    );
  };

  const pasteUri = (s: UiState, item: ReviewItem, value: string) => {
    const key = item.match.canonicalKey;
    commit({ ...s, mode: { kind: "normal" }, busy: new Set(s.busy).add(key), status: { text: `resolving ${value}`, kind: "info" } });
    matcher.candidateFromUri(item.track, value).then(
      (c) =>
        settle(key, (s2, loc) => {
          if (!loc) {
            commit(s2);
            return;
          }
          if (!c) {
            commit({ ...s2, status: { text: `no track found for ${value}`, kind: "error" } });
            return;
          }
          pick(s2, loc, c, [c, ...loc.item.match.candidates.filter((x) => x.id !== c.id)]);
        }),
      (err: unknown) =>
        settle(key, (s2) => commit({ ...s2, status: { text: `lookup failed: ${err instanceof Error ? err.message : String(err)}`, kind: "error" } })),
    );
  };

  const finished = TABS.every((t) => state.queues[t].length === 0) && state.undo.length === 0;

  useInput(
    (input, key) => {
      const s = ref.current;
      if (finished || input === "q" || key.escape) {
        quit(s);
        return;
      }
      if (input === "?") {
        commit({ ...s, showHelp: !s.showHelp });
        return;
      }
      if (key.tab) {
        commit({ ...s, tab: TABS[(TABS.indexOf(s.tab) + 1) % TABS.length]!, selected: 0 });
        return;
      }
      if (input === "j" || key.downArrow) {
        move(s, 1);
        return;
      }
      if (input === "k" || key.upArrow) {
        move(s, -1);
        return;
      }
      if (input === "u") {
        undo(s);
        return;
      }
      const index = s.cursor[s.tab];
      const item = s.queues[s.tab][index];
      if (!item) return;
      const loc: Location = { tab: s.tab, index, item };
      if (input >= "1" && input <= "9" && input.length === 1) {
        const n = Number(input) - 1;
        if (n < Math.min(item.match.candidates.length, MAX_SHOWN_CANDIDATES)) commit({ ...s, selected: n });
        return;
      }
      if (input === "o") {
        const c = item.match.candidates[s.selected];
        if (!c) {
          commit({ ...s, status: { text: "no candidate to open", kind: "error" } });
          return;
        }
        const url = `https://open.spotify.com/track/${c.id}`;
        commit({ ...s, status: { text: openExternal(url) ? `opened ${url}` : `could not open ${url}`, kind: "info" } });
        return;
      }
      if (input === "O") {
        const target = sourceLink(item.track);
        if (target === null) {
          commit({ ...s, status: { text: "source has no link to open", kind: "error" } });
          return;
        }
        commit({ ...s, status: { text: openExternal(target) ? `opened ${target}` : `could not open ${target}`, kind: "info" } });
        return;
      }
      if (s.busy.has(item.match.canonicalKey)) {
        commit({ ...s, status: { text: "search in progress for this item; wait or move on", kind: "error" } });
        return;
      }
      if (key.return) {
        const c = item.match.candidates[s.selected];
        if (c) pick(s, loc, c, item.match.candidates);
        else commit({ ...s, status: { text: "no candidate to confirm; / to search, p to paste a link, l for local, s to skip", kind: "error" } });
        return;
      }
      if (input === "l") {
        unmatched(s, loc, "local");
        return;
      }
      if (input === "s") {
        unmatched(s, loc, "skipped");
        return;
      }
      if (input === "/") {
        commit({ ...s, mode: { kind: "input", input: "search", value: `${item.track.title} ${item.track.artists[0] ?? ""}`.trim() } });
        return;
      }
      if (input === "p") {
        commit({ ...s, mode: { kind: "input", input: "uri", value: "" } });
      }
    },
    { isActive: state.mode.kind === "normal" },
  );

  if (finished) {
    return (
      <Box flexDirection="column">
        <Text>Nothing to review. Press any key to exit.</Text>
      </Box>
    );
  }

  const queue = state.queues[state.tab];
  const cursor = state.cursor[state.tab];
  const item = queue[cursor];
  const headerRows = state.showHelp ? 2 : 1;
  const bodyHeight = Math.max(3, rows - headerRows - 2);

  return (
    <Box flexDirection="column" height={rows - 1}>
      <Box flexDirection="row">
        {TABS.map((tab) => (
          <Text key={tab} bold={tab === state.tab} inverse={tab === state.tab}>
            {` ${tab} ${tab === state.tab ? `${queue.length === 0 ? 0 : cursor + 1}/${queue.length}` : state.queues[tab].length} `}
          </Text>
        ))}
        <Text>{`  decided ${state.decided}  market ${market}`}</Text>
        <Text dimColor>{"   ? help  q quit"}</Text>
      </Box>
      {state.showHelp ? (
        <Text color="cyan" wrap="truncate-end">
          {HELP}
        </Text>
      ) : null}
      <Box flexDirection="row" height={bodyHeight} overflow="hidden">
        <Box width="40%" flexShrink={0} borderStyle="single" borderRight borderTop={false} borderBottom={false} borderLeft={false} paddingRight={1}>
          <ReviewList items={queue} cursor={cursor} height={bodyHeight} busy={state.busy} />
        </Box>
        <CandidatePane item={item} selected={state.selected} busy={item ? state.busy.has(item.match.canonicalKey) : false} />
      </Box>
      <Box flexDirection="row">
        {state.mode.kind === "input" && item ? (
          <SearchInput
            mode={state.mode.input}
            value={state.mode.value}
            onChange={(value) => {
              const s = ref.current;
              if (s.mode.kind === "input") commit({ ...s, mode: { ...s.mode, value } });
            }}
            onSubmit={(value) => {
              const s = ref.current;
              const trimmed = value.trim();
              if (trimmed.length === 0) {
                commit({ ...s, mode: { kind: "normal" } });
                return;
              }
              if (s.mode.kind === "input" && s.mode.input === "uri") pasteUri(s, item, trimmed);
              else search(s, item, trimmed);
            }}
            onCancel={() => commit({ ...ref.current, mode: { kind: "normal" } })}
          />
        ) : (
          <Text color={state.status.kind === "error" ? "red" : undefined} wrap="truncate-end">
            {spinning ? `${SPINNER[tick % SPINNER.length]} ` : ""}
            {state.status.text}
          </Text>
        )}
      </Box>
    </Box>
  );
}
