export interface YahooBindings {
  DB: D1Database;
  YAHOO_CLIENT_ID?: string;
  YAHOO_CLIENT_SECRET?: string;
  YAHOO_REDIRECT_URI?: string;
  YAHOO_TOKEN_ENCRYPTION_KEY?: string;
}

interface YahooToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

const AUTH_URL = "https://api.login.yahoo.com/oauth2/request_auth";
const TOKEN_URL = "https://api.login.yahoo.com/oauth2/get_token";
const FANTASY_BASE = "https://fantasysports.yahooapis.com/fantasy/v2";
const refreshes = new Map<string, Promise<YahooToken>>();

export function yahooMissingConfig(env: YahooBindings): string[] {
  return (["YAHOO_CLIENT_ID", "YAHOO_CLIENT_SECRET", "YAHOO_REDIRECT_URI", "YAHOO_TOKEN_ENCRYPTION_KEY"] as const)
    .filter((key) => !env[key]?.trim());
}

export function yahooRedirectUri(env: YahooBindings, request: Request): string | null {
  try {
    const configured = new URL(env.YAHOO_REDIRECT_URI ?? "");
    const origin = new URL(request.url);
    if (configured.origin !== origin.origin || configured.pathname !== "/api/yahoo/callback") return null;
    return configured.toString();
  } catch { return null; }
}

export async function createYahooAuthorization(env: YahooBindings, ownerId: string): Promise<{ state: string; location: string }> {
  const state = crypto.randomUUID() + crypto.randomUUID();
  await env.DB.prepare(`DELETE FROM situation_room_yahoo_oauth_states WHERE expires_at < ?`)
    .bind(Date.now()).run();
  await env.DB.prepare(
    `INSERT INTO situation_room_yahoo_oauth_states (state, owner_id, expires_at) VALUES (?, ?, ?)`
  ).bind(state, ownerId, Date.now() + 600_000).run();
  const location = new URL(AUTH_URL);
  location.searchParams.set("client_id", env.YAHOO_CLIENT_ID!);
  location.searchParams.set("redirect_uri", env.YAHOO_REDIRECT_URI!);
  location.searchParams.set("response_type", "code");
  location.searchParams.set("state", state);
  location.searchParams.set("language", "en-us");
  return { state, location: location.toString() };
}

export async function consumeYahooAuthorization(env: YahooBindings, ownerId: string, state: string): Promise<boolean> {
  const result = await env.DB.prepare(
    `DELETE FROM situation_room_yahoo_oauth_states
     WHERE state = ? AND owner_id = ? AND expires_at > ? RETURNING state`
  ).bind(state, ownerId, Date.now()).first();
  return !!result;
}

export async function exchangeYahooCode(env: YahooBindings, ownerId: string, code: string): Promise<void> {
  const data = await requestToken(env, { grant_type: "authorization_code", redirect_uri: env.YAHOO_REDIRECT_URI!, code });
  await saveToken(env, ownerId, normalizeToken(data));
}

export async function removeYahooToken(env: YahooBindings, ownerId: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM situation_room_yahoo_tokens WHERE owner_id = ?`).bind(ownerId).run();
}

export async function yahooConnection(env: YahooBindings, ownerId: string): Promise<{ connected: boolean; expiresAt: number | null }> {
  const token = await validToken(env, ownerId);
  return { connected: !!token, expiresAt: token?.expiresAt ?? null };
}

export async function fetchYahooXml(env: YahooBindings, ownerId: string, pathname: string): Promise<Response> {
  if (!pathname.startsWith("/") || pathname.startsWith("//")) throw new Error("Invalid Yahoo API path.");
  let token = await validToken(env, ownerId);
  if (!token) return Response.json({ error: "Yahoo is not connected." }, { status: 401 });
  let response = await yahooRequest(pathname, token.accessToken);
  if (response.status === 401) {
    token = await refreshToken(env, ownerId, true);
    response = await yahooRequest(pathname, token.accessToken);
  }
  if (response.status === 403) return Response.json({
    error: "Yahoo Fantasy denied this API request (403). Check whether this developer app has been approved for Fantasy API access.",
    code: "YAHOO_FANTASY_ACCESS_DENIED",
  }, { status: 502 });
  if (!response.ok) return Response.json({ error: `Yahoo Fantasy request failed (${response.status}).` }, { status: 502 });
  return new Response(await response.text(), { status: 200,
    headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "no-store" } });
}

async function yahooRequest(pathname: string, accessToken: string): Promise<Response> {
  return fetch(FANTASY_BASE + pathname, { headers: {
    Authorization: `Bearer ${accessToken}`, Accept: "application/xml,text/xml;q=0.9,*/*;q=0.8"
  }, cache: "no-store" });
}

async function validToken(env: YahooBindings, ownerId: string): Promise<YahooToken | null> {
  const token = await loadToken(env, ownerId);
  if (!token) return null;
  return Date.now() < token.expiresAt ? token : refreshToken(env, ownerId);
}

async function refreshToken(env: YahooBindings, ownerId: string, force = false): Promise<YahooToken> {
  const existing = refreshes.get(ownerId);
  if (existing) return existing;
  const promise = (async () => {
    const previous = await loadToken(env, ownerId);
    if (!previous?.refreshToken) throw new Error("Yahoo needs to be reconnected.");
    if (!force && Date.now() < previous.expiresAt) return previous;
    const data = await requestToken(env, { grant_type: "refresh_token", refresh_token: previous.refreshToken });
    const next = normalizeToken(data, previous);
    await saveToken(env, ownerId, next);
    return next;
  })();
  refreshes.set(ownerId, promise);
  try { return await promise; } finally { refreshes.delete(ownerId); }
}

function normalizeToken(data: Record<string, unknown>, previous?: YahooToken): YahooToken {
  if (typeof data.access_token !== "string" || !data.access_token) throw new Error("Yahoo did not return an access token.");
  const refreshToken = typeof data.refresh_token === "string" ? data.refresh_token : previous?.refreshToken;
  if (!refreshToken) throw new Error("Yahoo did not return a refresh token.");
  const seconds = Number(data.expires_in) || 3600;
  return { accessToken: data.access_token, refreshToken,
    expiresAt: Date.now() + Math.max(0, seconds - 60) * 1000 };
}

async function requestToken(env: YahooBindings, body: Record<string, string>): Promise<Record<string, unknown>> {
  const credentials = new TextEncoder().encode(`${env.YAHOO_CLIENT_ID}:${env.YAHOO_CLIENT_SECRET}`);
  const response = await fetch(TOKEN_URL, { method: "POST", cache: "no-store", headers: {
    Authorization: `Basic ${base64(credentials)}`,
    "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json"
  }, body: new URLSearchParams(body) });
  if (!response.ok) throw new Error(`Yahoo token request failed (${response.status}).`);
  return await response.json() as Record<string, unknown>;
}

async function key(env: YahooBindings): Promise<CryptoKey> {
  const hex = env.YAHOO_TOKEN_ENCRYPTION_KEY ?? "";
  if (!/^[a-fA-F0-9]{64}$/.test(hex)) throw new Error("Yahoo token encryption key must be 32 bytes of hex.");
  const bytes = Uint8Array.from(hex.match(/../g)!, (pair) => parseInt(pair, 16));
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function saveToken(env: YahooBindings, ownerId: string, token: YahooToken): Promise<void> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(env),
    new TextEncoder().encode(JSON.stringify(token))));
  const encrypted = `${base64(iv)}.${base64(ciphertext)}`;
  await env.DB.prepare(`INSERT INTO situation_room_yahoo_tokens (owner_id, encrypted_token, updated_at)
    VALUES (?, ?, ?) ON CONFLICT(owner_id) DO UPDATE SET encrypted_token = excluded.encrypted_token,
    updated_at = excluded.updated_at`).bind(ownerId, encrypted, new Date().toISOString()).run();
}

async function loadToken(env: YahooBindings, ownerId: string): Promise<YahooToken | null> {
  const row = await env.DB.prepare(`SELECT encrypted_token FROM situation_room_yahoo_tokens WHERE owner_id = ?`)
    .bind(ownerId).first<{ encrypted_token: string }>();
  if (!row) return null;
  const [iv, ciphertext] = row.encrypted_token.split(".");
  if (!iv || !ciphertext) throw new Error("Stored Yahoo token is invalid.");
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unbase64(iv) }, await key(env), unbase64(ciphertext));
  return JSON.parse(new TextDecoder().decode(plaintext)) as YahooToken;
}

function base64(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)); }
function unbase64(value: string): ArrayBuffer {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0)).buffer as ArrayBuffer;
}
