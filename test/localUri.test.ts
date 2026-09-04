import { describe, expect, test } from "bun:test";
import { buildLocalUri, canonicalLocalUri, parseLocalUri } from "../src/spotify/localUri.ts";

describe("spotify:local URI", () => {
  test("round-trips CJK, spaces, reserved characters and the duration", () => {
    const parts = { artist: "周杰伦 / 費玉清", album: "葉惠美", title: "晴天 (Live) + 100%:ok", durationSec: 269 };
    const uri = buildLocalUri(parts);
    expect(uri.startsWith("spotify:local:")).toBe(true);
    expect(uri.split(":").length).toBe(6);
    expect(parseLocalUri(uri)).toEqual(parts);
  });

  test("matches the identity the desktop client indexes for a real exported file", () => {
    // artist/album/title from the file's tags; 156 is what the client's local-files index holds for a 156.79 s file
    expect(buildLocalUri({ artist: "WOVOP, 洛天依", album: "夏至又至", title: "夏至又至", durationSec: 156 })).toBe(
      "spotify:local:WOVOP%2C+%E6%B4%9B%E5%A4%A9%E4%BE%9D:%E5%A4%8F%E8%87%B3%E5%8F%88%E8%87%B3:%E5%A4%8F%E8%87%B3%E5%8F%88%E8%87%B3:156",
    );
  });

  test("a bare three-segment uri parses with a null duration and is not equal to any timed identity", () => {
    expect(parseLocalUri("spotify:local:a:b:c")).toEqual({ artist: "a", album: "b", title: "c", durationSec: null });
    expect(canonicalLocalUri("spotify:local:a:b:c")).toBe("spotify:local:a:b:c");
    expect(canonicalLocalUri("spotify:local:a:b:c")).not.toBe(canonicalLocalUri("spotify:local:a:b:c:0"));
  });

  test("canonical form equates %20, + and %28 encodings but not durations", () => {
    const plus = "spotify:local:Some+Artist:Some+Album:Some+Title+(x):200";
    const pct = "spotify:local:Some%20Artist:Some%20Album:Some%20Title%20%28x%29:200";
    expect(canonicalLocalUri(plus)).toBe(canonicalLocalUri(pct));
    expect(canonicalLocalUri(plus)).not.toBe(canonicalLocalUri(pct.replace(/:200$/, ":201")));
  });

  test("rejects non-local and malformed URIs", () => {
    expect(parseLocalUri("spotify:track:4uLU6hMCjMI75M1A2tKUQC")).toBeNull();
    expect(parseLocalUri("spotify:local:a:b")).toBeNull();
    expect(parseLocalUri("spotify:local:a:b:c:notanumber")).toBeNull();
    expect(parseLocalUri("spotify:local:a:b:c:-1")).toBeNull();
    expect(canonicalLocalUri("spotify:local:a:b:%E0%A4%A:1")).toBeNull();
  });
});
