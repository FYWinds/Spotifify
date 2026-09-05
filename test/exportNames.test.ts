import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../src/config.ts";
import { openDatabase } from "../src/state/db.ts";
import { Repo } from "../src/state/repo.ts";
import { planExportsOnly } from "../src/sync/run.ts";
import { MAX_FILENAME } from "../src/util/fs.ts";

describe("export file names", () => {
  const root = mkdtempSync(join(tmpdir(), "spotifify-names-"));
  const repo = new Repo(openDatabase(join(root, "state")));
  const cfg = ConfigSchema.parse({ local: { dirs: [root] } });

  afterAll(() => {
    repo.db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("two tracks whose names collide at the length limit still get distinct names", () => {
    const title = "T".repeat(MAX_FILENAME + 20);
    const file = (n: number) => ({ path: join(root, `${n}.mp3`), contentHash: `hash${n}`, size: 1, mtimeMs: 1 });
    repo.savePull(
      "local",
      [
        {
          playlist: { kind: "local", externalId: "library", name: "Local Library" },
          tracks: [1, 2, 3].map((n) => ({ kind: "local" as const, externalId: `${n}`, title, artists: ["Artist"], aliases: [], file: file(n) })),
        },
      ],
      1,
    );
    for (const m of repo.listMatches("pending")) repo.upsertMatch({ ...m, status: "local", decidedBy: "auto", decidedAt: 1, lastSearchAt: 1 });

    const names = planExportsOnly(repo, cfg).map((p) => p.baseName);
    expect(new Set(names).size).toBe(3);
    expect(names.every((n) => n.length <= MAX_FILENAME)).toBe(true);
    expect(names.filter((n) => / \(\d\)$/.test(n))).toHaveLength(2);
  });
});
