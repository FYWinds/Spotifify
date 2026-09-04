import { log } from "../util/log.ts";
import { openExternal } from "../util/open.ts";
import { SCOPES, type SpotifyTokens } from "./types.ts";

const ACCOUNTS = "https://accounts.spotify.com";
/** Refresh this long before the token actually expires so in-flight requests never race the deadline. */
const EXPIRY_MARGIN_MS = 30_000;

export interface TokenStore {
  load(): SpotifyTokens | null;
  save(t: SpotifyTokens): void;
}

/** Refresh rejected (invalid_grant) or no stored tokens: the user must run `auth spotify` again. */
export class AuthExpiredError extends Error {
  constructor(message = "Spotify authorization expired; run `spotifify auth spotify`") {
    super(message);
    this.name = "AuthExpiredError";
  }
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function postToken(form: Record<string, string>, previous?: SpotifyTokens): Promise<SpotifyTokens> {
  const res = await fetch(`${ACCOUNTS}/api/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 400 && text.includes("invalid_grant")) throw new AuthExpiredError(`Spotify token refresh rejected: ${text}`);
    throw new Error(`Spotify token endpoint ${res.status}: ${text}`);
  }
  const body = JSON.parse(text) as TokenResponse;
  const refresh = body.refresh_token ?? previous?.refresh_token;
  if (!refresh) throw new Error("Spotify token response carried no refresh_token");
  return {
    access_token: body.access_token,
    refresh_token: refresh,
    expires_at: Date.now() + body.expires_in * 1000 - EXPIRY_MARGIN_MS,
    scope: body.scope ?? previous?.scope ?? SCOPES.join(" "),
  };
}

/** Authorization Code + PKCE via a one-shot loopback server; resolves once tokens are exchanged and saved. */
export async function loginPkce(opts: { clientId: string; port: number; store: TokenStore }): Promise<SpotifyTokens> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(64)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
  const redirectUri = `http://127.0.0.1:${opts.port}/callback`;

  const { promise: code, resolve, reject } = Promise.withResolvers<string>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/callback") return new Response("Not found", { status: 404 });
      const error = url.searchParams.get("error");
      const got = url.searchParams.get("code");
      if (url.searchParams.get("state") !== state) {
        reject(new Error("Spotify callback state mismatch"));
        return new Response("State mismatch. You can close this tab.", { status: 400 });
      }
      if (error || !got) {
        reject(new Error(`Spotify authorization failed: ${error ?? "no code"}`));
        return new Response(`Authorization failed: ${error ?? "no code"}. You can close this tab.`, { status: 400 });
      }
      resolve(got);
      return new Response("Spotifify: authorization complete. You can close this tab.", { headers: { "Content-Type": "text/plain" } });
    },
  });

  const authorize = new URL(`${ACCOUNTS}/authorize`);
  authorize.search = new URLSearchParams({
    client_id: opts.clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPES.join(" "),
    state,
    code_challenge_method: "S256",
    code_challenge: challenge,
  }).toString();

  log.info(`Open this URL to authorize Spotify:\n${authorize.href}`);
  openExternal(authorize.href);

  try {
    const tokens = await postToken({
      client_id: opts.clientId,
      grant_type: "authorization_code",
      code: await code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
    opts.store.save(tokens);
    return tokens;
  } finally {
    server.stop(true);
  }
}

/** PKCE refresh responses may omit `refresh_token`; the previous one is kept in that case. */
export async function refreshTokens(clientId: string, refreshToken: string): Promise<SpotifyTokens> {
  return postToken({ client_id: clientId, grant_type: "refresh_token", refresh_token: refreshToken }, {
    access_token: "",
    refresh_token: refreshToken,
    expires_at: 0,
    scope: "",
  });
}
