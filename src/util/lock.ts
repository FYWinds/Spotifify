import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";

export class LockHeldError extends Error {
  constructor(readonly pid: number) {
    super(`another sync is running (pid ${pid})`);
    this.name = "LockHeldError";
  }
}

/**
 * Acquire a pid lock file. A lock whose pid is no longer alive is treated as stale and taken over.
 * Returns a release function; callers must invoke it in `finally`.
 */
export function acquireLock(path: string): () => void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(path, { force: true });
    } catch (e) {
      if (!(e instanceof Error) || !("code" in e) || e.code !== "EEXIST") throw e;
      const pid = Number.parseInt(readFileSync(path, "utf-8").trim(), 10);
      if (Number.isInteger(pid) && pid !== process.pid && isAlive(pid)) throw new LockHeldError(pid);
      rmSync(path, { force: true }); // stale: owner died without cleanup
    }
  }
  throw new Error(`could not acquire lock ${path}`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e instanceof Error && "code" in e && e.code === "EPERM";
  }
}
