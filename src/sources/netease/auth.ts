import { login_qr_check, login_qr_create, login_qr_key } from "./lib.ts";
import { z } from "zod";
import { log } from "../../util/log.ts";
import { sleep } from "../../util/retry.ts";

const QrKeyRes = z.object({ body: z.object({ data: z.object({ unikey: z.string().min(1) }) }) });
const QrCreateRes = z.object({ body: z.object({ data: z.object({ qrurl: z.string().min(1) }) }) });
const QrCheckRes = z.object({ body: z.object({ code: z.number().optional(), message: z.string().optional(), cookie: z.string().optional() }) });

const QR_EXPIRED = 800;
const QR_WAITING = 801;
const QR_SCANNED = 802;
const QR_CONFIRMED = 803;

/**
 * QR login: renders the login URL via `render`, then polls until the user confirms on the phone.
 * Resolves the cookie header string (`MUSIC_U=...; __csrf=...`).
 */
export async function loginByQr(render: (qrUrl: string) => void, opts: { timeoutMs?: number; pollMs?: number } = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const pollMs = opts.pollMs ?? 2000;

  const keyRes = QrKeyRes.safeParse(await login_qr_key({}));
  if (!keyRes.success) throw new Error("netease login_qr_key returned no unikey");
  const key = keyRes.data.body.data.unikey;

  const createRes = QrCreateRes.safeParse(await login_qr_create({ key, qrimg: false }));
  if (!createRes.success) throw new Error("netease login_qr_create returned no qrurl");
  render(createRes.data.body.data.qrurl);

  const deadline = Date.now() + timeoutMs;
  let scannedLogged = false;
  while (true) {
    await sleep(pollMs);
    if (Date.now() > deadline) throw new Error(`netease QR login timed out after ${timeoutMs} ms`);
    let raw: unknown;
    try {
      raw = await login_qr_check({ key });
    } catch (e) {
      // the library's own catch path throws a ReferenceError on network failure; keep polling until the deadline
      log.debug("netease login_qr_check failed, retrying", { error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    const check = QrCheckRes.safeParse(raw);
    if (!check.success) throw new Error("netease login_qr_check returned an unexpected response");
    const body = check.data.body;
    switch (body.code) {
      case QR_EXPIRED:
        throw new Error("netease QR code expired; run the login again");
      case QR_WAITING:
        continue;
      case QR_SCANNED:
        if (!scannedLogged) {
          log.info("netease QR scanned; confirm on your phone");
          scannedLogged = true;
        }
        continue;
      case QR_CONFIRMED: {
        const cookie = normalizeCookie(body.cookie ?? "");
        if (!cookie.includes("MUSIC_U=")) throw new Error("netease QR login confirmed but no MUSIC_U cookie was returned");
        return cookie;
      }
      default:
        throw new Error(`netease login_qr_check unexpected code ${body.code ?? "?"}${body.message ? `: ${body.message}` : ""}`);
    }
  }
}

const COOKIE_ATTRIBUTE = /^(Max-Age|Expires|Path|Domain|HTTPOnly|Secure|SameSite)$/i;

/**
 * Accepts "MUSIC_U=xxx", a full Cookie header, or the `;`-joined Set-Cookie list returned by login_qr_check.
 * Returns a `k=v; k2=v2` header. When MUSIC_U is present, only MUSIC_U (+ __csrf if present) are kept.
 */
export function normalizeCookie(raw: string): string {
  const pairs: Array<[string, string]> = [];
  for (const part of raw.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (!k || !v || COOKIE_ATTRIBUTE.test(k)) continue;
    pairs.push([k, v]);
  }
  const musicU = pairs.find(([k]) => k === "MUSIC_U");
  if (musicU) {
    const csrf = pairs.find(([k]) => k === "__csrf");
    return csrf ? `MUSIC_U=${musicU[1]}; __csrf=${csrf[1]}` : `MUSIC_U=${musicU[1]}`;
  }
  return pairs.map(([k, v]) => `${k}=${v}`).join("; ");
}
