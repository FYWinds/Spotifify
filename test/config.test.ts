import { describe, expect, test } from "bun:test";
import { parse } from "smol-toml";
import { ConfigSchema, missingConfigKeys, upgradeConfig } from "../src/config.ts";

const OLD = `# written by an older version
[spotify]
client_id = "abc"
redirect_port = 9999

[netease]
enabled = true
exclude_playlists = ["旧歌单"]

[local]
dirs = ["D:/Music", "E:/More"]

[matching]
auto_threshold = 0.95

[matching.artist_aliases]
"周杰倫" = "周杰伦"

[custom]
note = "kept"
`;

describe("upgradeConfig", () => {
  const { text, added } = upgradeConfig(OLD);
  const merged = parse(text) as Record<string, Record<string, unknown>>;

  test("keeps every user value, including nested tables and unknown sections", () => {
    expect(merged.spotify?.client_id).toBe("abc");
    expect(merged.spotify?.redirect_port).toBe(9999);
    expect(merged.netease?.exclude_playlists).toEqual(["旧歌单"]);
    expect(merged.local?.dirs).toEqual(["D:/Music", "E:/More"]);
    expect(merged.matching?.auto_threshold).toBe(0.95);
    expect((merged.matching?.artist_aliases as Record<string, string>)["周杰倫"]).toBe("周杰伦");
    expect(merged.custom?.note).toBe("kept");
  });

  test("adds options the file predates with template defaults", () => {
    expect(added).toContain("netease.include_playlists");
    expect(added).toContain("matching.max_searches_per_run");
    expect(added).toContain("local.mirror_playlist");
    expect(merged.netease?.include_playlists).toEqual([]);
    expect(merged.matching?.max_searches_per_run).toBe(400);
  });

  test("result parses under the schema and is a fixed point", () => {
    expect(() => ConfigSchema.parse(merged)).not.toThrow();
    expect(missingConfigKeys(text)).toEqual([]);
    expect(parse(upgradeConfig(text).text)).toEqual(merged as never);
  });
});
