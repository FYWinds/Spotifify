import { log } from "./log.ts";

/**
 * Open a URL or file with the OS default handler, detached.
 * Windows: `cmd /c start` would parse `&` in query strings as a command separator and mangle URLs;
 * rundll32's protocol handler passes the argument through verbatim.
 */
export function openExternal(target: string): boolean {
  const cmd =
    process.platform === "win32"
      ? ["rundll32", "url.dll,FileProtocolHandler", target]
      : process.platform === "darwin"
        ? ["open", target]
        : ["xdg-open", target];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore", stdin: "ignore" }).unref();
    return true;
  } catch (e) {
    log.warn("could not open externally", { target, error: String(e) });
    return false;
  }
}
