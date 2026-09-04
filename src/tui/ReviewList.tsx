import { Box, Text } from "ink";
import { scoreColor, type ReviewItem } from "./model.ts";

interface Props {
  items: ReviewItem[];
  cursor: number;
  /** Rows available for item lines. */
  height: number;
  /** Keys with an async search in flight. */
  busy: ReadonlySet<string>;
}

export function ReviewList({ items, cursor, height, busy }: Props) {
  const scrolls = items.length > height;
  const visible = Math.max(1, scrolls ? height - 1 : height);
  const maxTop = Math.max(0, items.length - visible);
  const top = Math.min(maxTop, Math.max(0, cursor - Math.floor(visible / 2)));
  const rows = items.slice(top, top + visible);

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {items.length === 0 ? (
        <Text dimColor>(queue empty)</Text>
      ) : (
        rows.map((item, i) => {
          const index = top + i;
          const active = index === cursor;
          const best = item.match.candidates[0];
          const label = `${item.track.title} — ${item.track.artists.join(", ")}`;
          return (
            <Box key={item.match.canonicalKey} flexDirection="row">
              <Box width={2} flexShrink={0}>
                <Text color="cyan">{active ? ">" : busy.has(item.match.canonicalKey) ? "…" : " "}</Text>
              </Box>
              <Box flexGrow={1} flexShrink={1} overflow="hidden">
                <Text bold={active} inverse={active} wrap="truncate-end">
                  {label}
                </Text>
              </Box>
              <Box width={5} flexShrink={0} justifyContent="flex-end">
                {best ? (
                  <Text color={scoreColor(best.score)}>{best.score.toFixed(2)}</Text>
                ) : (
                  <Text dimColor>none</Text>
                )}
              </Box>
            </Box>
          );
        })
      )}
      {scrolls ? (
        <Text dimColor>{`${top + 1}-${Math.min(items.length, top + visible)} of ${items.length}`}</Text>
      ) : null}
    </Box>
  );
}
