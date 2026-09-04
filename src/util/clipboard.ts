/** Copies text to the system clipboard; returns false when no clipboard command is available. */
export async function copyToClipboard(text: string): Promise<boolean> {
  const cmd =
    process.platform === "win32" ? ["clip"] : process.platform === "darwin" ? ["pbcopy"] : ["xclip", "-selection", "clipboard"];
  try {
    const proc = Bun.spawn(cmd, { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    proc.stdin.write(text);
    proc.stdin.end();
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}
