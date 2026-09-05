import { describe, expect, test } from "bun:test";
import { buildLocalUri } from "../src/spotify/localUri.ts";
import { computePlaylistPlan, resolveRemoteLocalUri, type DesiredItem, type PlaylistPlanInput } from "../src/sync/plan.ts";
import { applyMove } from "../src/sync/reorder.ts";

const t = (id: string) => `spotify:track:${id}`;
const item = (uri: string, kind: DesiredItem["kind"] = "spotify"): DesiredItem => ({ uri, kind, canonicalKey: `k:${uri}` });

function base(over: Partial<PlaylistPlanInput>): PlaylistPlanInput {
  return {
    sourcePlaylistId: 1,
    sourceName: "P",
    targetName: "P",
    spotify: { id: "pl", name: "P" },
    snapshotId: "snap0",
    desired: [],
    remote: [],
    managed: new Set(),
    pruneEnabled: false,
    ...over,
  };
}

function simulate(current: string[], moves: ReturnType<typeof computePlaylistPlan>["moves"]): string[] {
  return moves.reduce<string[]>((arr, m) => applyMove(arr, m), current);
}

describe("computePlaylistPlan", () => {
  test("creates the playlist and adds spotify items; local items await paste", () => {
    const p = computePlaylistPlan(base({ spotify: null, desired: [item(t("a")), item("spotify:local:x:y:z:10", "local"), item(t("b"))] }));
    expect(p.create).toEqual({ name: "P" });
    expect(p.adds).toEqual([t("a"), t("b")]);
    expect(p.awaiting.map((a) => a.uri)).toEqual(["spotify:local:x:y:z:10"]);
    expect(p.moves).toEqual([]);
  });

  test("splits stale items into prune (managed) and foreign, keeps them at the tail when prune is off", () => {
    const remote = [t("a"), t("b"), t("x"), t("y")].map((uri) => ({ uri, isLocal: false, owned: false }));
    const p = computePlaylistPlan(
      base({ desired: [item(t("b")), item(t("a")), item("spotify:local:l:l:l:100", "local")], remote, managed: new Set([t("a"), t("b"), t("x")]) }),
    );
    expect(p.adds).toEqual([]);
    expect(p.awaiting.map((a) => a.uri)).toEqual(["spotify:local:l:l:l:100"]);
    expect(p.prune).toEqual([{ uri: t("x"), positions: [2] }]);
    expect(p.foreign).toEqual([t("y")]);
    expect(p.targetOrder).toEqual([t("b"), t("a"), t("x"), t("y")]);
    expect(simulate(remote.map((r) => r.uri), p.moves)).toEqual(p.targetOrder);
    expect(p.moves.length).toBe(1);
  });

  test("with prune enabled the target order excludes pruned items and adds are appended before reordering", () => {
    const remote = [t("a"), t("x"), t("b")].map((uri) => ({ uri, isLocal: false, owned: false }));
    const p = computePlaylistPlan(
      base({ desired: [item(t("c")), item(t("b")), item(t("a"))], remote, managed: new Set([t("a"), t("b"), t("x")]), pruneEnabled: true }),
    );
    expect(p.adds).toEqual([t("c")]);
    expect(p.targetOrder).toEqual([t("c"), t("b"), t("a")]);
    const afterAddsAndPrune = [t("a"), t("b"), t("c")];
    expect(simulate(afterAddsAndPrune, p.moves)).toEqual(p.targetOrder);
  });

  test("duplicate remote items: first occurrence follows source order, extras trail as foreign", () => {
    const remote = [t("a"), t("a"), t("b")].map((uri) => ({ uri, isLocal: false, owned: false }));
    const p = computePlaylistPlan(base({ desired: [item(t("b")), item(t("a"))], remote, managed: new Set([t("a"), t("b")]) }));
    expect(p.prune).toEqual([]);
    expect(p.targetOrder).toEqual([t("b"), t("a"), t("a")]);
    expect(simulate(remote.map((r) => r.uri), p.moves)).toEqual(p.targetOrder);
  });

  test("replace is disallowed when any local item is involved", () => {
    const withLocal = computePlaylistPlan(base({ remote: [{ uri: "spotify:local:a:b:c", isLocal: true, owned: false }] }));
    expect(withLocal.replaceAllowed).toBe(false);
    const without = computePlaylistPlan(base({ remote: [{ uri: t("a"), isLocal: false, owned: false }] }));
    expect(without.replaceAllowed).toBe(true);
  });

  test("owned local entries are pruned even though no local item is ever managed", () => {
    const stale = { uri: "spotify:local:a:b:c+(local):120", isLocal: true, owned: true };
    const p = computePlaylistPlan(base({ desired: [item("spotify:local:a:b:c:120", "local")], remote: [{ uri: t("z"), isLocal: false, owned: false }, stale] }));
    expect(p.prune).toEqual([{ uri: stale.uri, positions: [1] }]);
    expect(p.foreign).toEqual([t("z")]);
    expect(p.awaiting.map((a) => a.uri)).toEqual(["spotify:local:a:b:c:120"]);
  });

  test("an owned local entry whose track is now matched on Spotify is superseded: pruned, not foreign", () => {
    const superseded = { uri: "spotify:local:a:b:c:120", isLocal: true, owned: true };
    const p = computePlaylistPlan(base({ desired: [item(t("a"))], remote: [superseded, { uri: t("a"), isLocal: false, owned: false }], pruneEnabled: true }));
    expect(p.prune).toEqual([{ uri: superseded.uri, positions: [0] }]);
    expect(p.foreign).toEqual([]);
    expect(p.targetOrder).toEqual([t("a")]);
  });

  test("rename is planned when the remote name drifted from the target", () => {
    const p = computePlaylistPlan(base({ targetName: "NE · P", spotify: { id: "pl", name: "P" } }));
    expect(p.rename).toEqual({ from: "P", to: "NE · P" });
  });
});

describe("resolveRemoteLocalUri", () => {
  const exported = buildLocalUri({ artist: "周杰伦", album: "叶惠美", title: "晴天", durationSec: 269 });
  const exports = [{ canonicalKey: "k", exportPath: "x.mp3", localUri: exported, contentHash: "h", exportedAt: 0 }];

  test("a client entry with the same identity resolves to the export record whatever its percent-encoding, and is ours", () => {
    expect(resolveRemoteLocalUri("spotify:local:%E5%91%A8%E6%9D%B0%E4%BC%A6:%E5%8F%B6%E6%83%A0%E7%BE%8E:%E6%99%B4%E5%A4%A9:269", exports)).toEqual({ uri: exported, owned: true });
  });

  test("wrong identities of our own export (other duration, `:0` from a bare paste, no duration, title suffix) are ours but keep their uri", () => {
    for (const wrong of [
      buildLocalUri({ artist: "周杰伦", album: "叶惠美", title: "晴天", durationSec: 270 }),
      buildLocalUri({ artist: "周杰伦", album: "叶惠美", title: "晴天", durationSec: 0 }),
      buildLocalUri({ artist: "周杰伦", album: "叶惠美", title: "晴天", durationSec: null }),
      buildLocalUri({ artist: "周杰伦", album: "叶惠美", title: "晴天 (local)", durationSec: 269 }),
    ]) {
      expect(resolveRemoteLocalUri(wrong, exports)).toEqual({ uri: wrong, owned: true });
    }
  });

  test("unrelated local files stay foreign, non-local URIs pass through", () => {
    const other = buildLocalUri({ artist: "周杰伦", album: "叶惠美", title: "七里香", durationSec: 269 });
    expect(resolveRemoteLocalUri(other, exports)).toEqual({ uri: other, owned: false });
    expect(resolveRemoteLocalUri(t("a"), exports)).toEqual({ uri: t("a"), owned: false });
  });
});
