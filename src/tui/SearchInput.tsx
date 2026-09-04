import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";

export type InputMode = "search" | "uri";

const PROMPT: Record<InputMode, { label: string; placeholder: string }> = {
  search: { label: "search:", placeholder: "custom query, e.g. title artist" },
  uri: { label: "spotify:", placeholder: "spotify:track:ID or https://open.spotify.com/track/ID" },
};

interface Props {
  mode: InputMode;
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

/** One-line prompt for `/` (custom query) and `p` (paste URI). Esc cancels; Enter submits. */
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
