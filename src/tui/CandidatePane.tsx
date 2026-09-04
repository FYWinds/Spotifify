import { Box, Text } from "ink";
import type { Candidate } from "../match/types.ts";
import { fmtDelta, fmtDuration, scoreColor, sourceOrigin, type ReviewItem } from "./model.ts";

/** Only 1-9 are addressable from the keyboard; the stored list may be longer. */
export const MAX_SHOWN_CANDIDATES = 9;

interface Props {
  item: ReviewItem | undefined;
  selected: number;
  busy: boolean;
}

interface Cells {
  idx: string;
  title: string;
  artists: string;
  album: string;
  duration: string;
  score: string;
  flag: string;
}

interface RowStyle {
  color?: string;
  scoreColor?: string;
  flagColor?: string;
  bold?: boolean;
  inverse?: boolean;
  dim?: boolean;
}

function Row({ cells, style }: { cells: Cells; style: RowStyle }) {
  const text = { color: style.color, bold: style.bold, inverse: style.inverse, dimColor: style.dim } as const;
  return (
    <Box flexDirection="row">
      <Box width={3} flexShrink={0}>
        <Text {...text}>{cells.idx}</Text>
      </Box>
      <Box flexGrow={3} flexBasis={0} overflow="hidden" marginRight={1}>
        <Text {...text} wrap="truncate-end">
          {cells.title}
        </Text>
      </Box>
      <Box flexGrow={2} flexBasis={0} overflow="hidden" marginRight={1}>
        <Text {...text} wrap="truncate-end">
          {cells.artists}
        </Text>
      </Box>
      <Box flexGrow={2} flexBasis={0} overflow="hidden" marginRight={1}>
        <Text {...text} wrap="truncate-end">
          {cells.album}
        </Text>
      </Box>
      <Box width={11} flexShrink={0}>
        <Text {...text}>{cells.duration}</Text>
      </Box>
      <Box width={5} flexShrink={0}>
        <Text {...text} color={style.scoreColor ?? style.color}>
          {cells.score}
        </Text>
      </Box>
      <Box width={12} flexShrink={0}>
        <Text {...text} color={style.flagColor ?? style.color}>
          {cells.flag}
        </Text>
      </Box>
    </Box>
  );
}

const HEADER: Cells = { idx: "#", title: "title", artists: "artists", album: "album", duration: "duration", score: "score", flag: "" };

function candidateCells(c: Candidate, i: number, sourceMs: number | undefined): Cells {
  return {
    idx: String(i + 1),
    title: c.title,
    artists: c.artists.join(", "),
    album: c.album,
    duration: `${fmtDuration(c.durationMs)} ${fmtDelta(c.durationMs, sourceMs)}`,
    score: c.score.toFixed(2),
    flag: c.isPlayable ? "playable" : "unavailable",
  };
}

export function CandidatePane({ item, selected, busy }: Props) {
  if (!item) {
    return (
      <Box flexDirection="column" flexGrow={1} paddingLeft={1}>
        <Text dimColor>Nothing selected.</Text>
      </Box>
    );
  }
  const { track, match } = item;
  const shown = match.candidates.slice(0, MAX_SHOWN_CANDIDATES);
  const current = shown[selected];
  const sourceCells: Cells = {
    idx: "S",
    title: track.title,
    artists: track.artists.join(", "),
    album: track.album ?? "",
    duration: fmtDuration(track.durationMs),
    score: "",
    flag: "source",
  };

  return (
    <Box flexDirection="column" flexGrow={1} paddingLeft={1} overflow="hidden">
      <Text>
        <Text bold color="magenta">
          {track.title}
        </Text>
        <Text> — {track.artists.join(", ")}</Text>
      </Text>
      <Text dimColor wrap="truncate-end">
        {sourceOrigin(track)}
        {track.isrc ? `  isrc ${track.isrc}` : ""}
        {track.aliases.length > 0 ? `  aka ${track.aliases.join(" / ")}` : ""}
      </Text>
      <Text dimColor wrap="truncate-end">
        {item.playlists.length > 0 ? `in: ${item.playlists.join(", ")}` : "in: (no playlist)"}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Row cells={HEADER} style={{ dim: true }} />
        <Row cells={sourceCells} style={{ color: "magenta" }} />
        {busy ? (
          <Text color="yellow">searching…</Text>
        ) : shown.length === 0 ? (
          <Text dimColor>No candidates. Press / to search or p to paste a Spotify link.</Text>
        ) : (
          shown.map((c, i) => (
            <Row
              key={c.id}
              cells={candidateCells(c, i, track.durationMs)}
              style={{
                bold: i === selected,
                inverse: i === selected,
                dim: !c.isPlayable,
                scoreColor: scoreColor(c.score),
                flagColor: c.isPlayable ? "green" : "red",
              }}
            />
          ))
        )}
        {!busy && match.candidates.length > shown.length ? (
          <Text dimColor>{`+${match.candidates.length - shown.length} more not shown`}</Text>
        ) : null}
      </Box>
      {current && !busy ? (
        <Box marginTop={1}>
          <Text dimColor wrap="truncate-end">
            {`[${selected + 1}] title ${current.parts.title.toFixed(2)}  artist ${current.parts.artist.toFixed(2)}  album ${current.parts.album.toFixed(2)}  duration ${current.parts.duration.toFixed(2)}  version tags ${current.parts.versionTagsAgree ? "agree" : "DIFFER"}  ${current.uri}`}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
