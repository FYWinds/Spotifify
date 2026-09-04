/** Probe an external binary by running it with `args`; returns the first output line or null. */
export async function probeBinary(cmd: string, args: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn([cmd, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    const line = (out || err).split(/\r?\n/, 1)[0]?.trim();
    return line || `${cmd} (exit ${proc.exitCode})`;
  } catch {
    return null;
  }
}
