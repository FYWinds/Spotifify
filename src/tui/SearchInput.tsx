import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";

export type InputMode = "search" | "uri" | "path";

const PROMPT: Record<InputMode, { label: string; placeholder: string }> = {
  search: { label: "search:", placeholder: "custom query, e.g. title artist" },
  uri: { label: "spotify:", placeholder: "spotify:track:ID or https://open.spotify.com/track/ID" },
  path: { label: "file:", placeholder: "audio file to copy into local.dirs for this song (empty: keep local without one)" },
};

interface Props {
  mode: InputMode;
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

/** One-line prompt for `/` (custom query), `p` (paste URI) and `l` (attach a file). Esc cancels; Enter submits. */
export function SearchInput({ mode, value, onChange, onSubmit, onCancel }: Props) {
  useInput(
    (_input, key) => {
      if (key.escape) onCancel();
    },
    { isActive: true },
  );
  const prompt = PROMPT[mode];
  return (
    <Box flexDirection="row">
      <Text color="cyan" bold>
        {prompt.label}{" "}
      </Text>
      <TextInput value={value} onChange={onChange} onSubmit={onSubmit} placeholder={prompt.placeholder} />
      <Text dimColor>{"  (Enter submit · Esc cancel)"}</Text>
    </Box>
  );
}
