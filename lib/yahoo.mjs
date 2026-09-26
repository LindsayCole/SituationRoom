import { loadToken, saveToken } from './token-store.mjs';

const AUTH_URL = 'https://api.login.yahoo.com/oauth2/request_auth';
const TOKEN_URL = 'https://api.login.yahoo.com/oauth2/get_token';
const FANTASY_BASE = 'https://fantasysports.yahooapis.com/fantasy/v2';

function basicAuth(clientId, clientSecret) {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}`;
}

export function yahooConfigured(env = process.env) {
  return Boolean(env.YAHOO_CLIENT_ID && env.YAHOO_CLIENT_SECRET && env.YAHOO_REDIRECT_URI && env.YAHOO_TOKEN_ENCRYPTION_KEY);
}

export function buildAuthorizationUrl({ clientId, redirectUri, state }) {
  const u = new URL(AUTH_URL);
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('state', state);
  u.searchParams.set('language', 'en-us');
  return u.toString();
}

async function tokenRequest(body, env = process.env) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': basicAuth(env.YAHOO_CLIENT_ID, env.YAHOO_CLIENT_SECRET),
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json'
    },
    body: new URLSearchParams(body)
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok) {
    const err = new Error(`Yahoo token request failed (${response.status}).`);
    err.status = response.status;
    err.details = data;
    throw err;
  }
  return data;
}

function normalizeToken(data, previous = null) {
  const now = Date.now();
  const expiresIn = Number(data.expires_in || 3600);
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || previous?.refreshToken || null,
    tokenType: data.token_type || 'bearer',
    expiresIn,
    expiresAt: now + Math.max(60, expiresIn - 60) * 1000,
    xoauthYahooGuid: data.xoauth_yahoo_guid || previous?.xoauthYahooGuid || null,
    updatedAt: new Date(now).toISOString()
  };
}

export async function exchangeAuthorizationCode(code, env = process.env) {
  const data = await tokenRequest({
    grant_type: 'authorization_code',
    redirect_uri: env.YAHOO_REDIRECT_URI,
    code
  }, env);
  const token = normalizeToken(data);
  await saveToken(token, env.YAHOO_TOKEN_ENCRYPTION_KEY);
  return token;
}

export async function refreshAccessToken(current, env = process.env) {
  if (!current?.refreshToken) throw new Error('No Yahoo refresh token is available. Reconnect Yahoo.');
  const data = await tokenRequest({
    grant_type: 'refresh_token',
    redirect_uri: env.YAHOO_REDIRECT_URI,
    refresh_token: current.refreshToken
  }, env);
  const token = normalizeToken(data, current);
  await saveToken(token, env.YAHOO_TOKEN_ENCRYPTION_KEY);
  return token;
}

export async function getValidToken(env = process.env) {
  let token = await loadToken(env.YAHOO_TOKEN_ENCRYPTION_KEY);
  if (!token) return null;
  if (!token.accessToken || Date.now() >= Number(token.expiresAt || 0)) {
    token = await refreshAccessToken(token, env);
  }
  return token;
}

export async function fetchYahooXml(pathname, env = process.env) {
  const token = await getValidToken(env);
  if (!token) {
    const err = new Error('Yahoo is not connected.');
    err.status = 401;
    throw err;
  }
  if (!pathname.startsWith('/')) throw new Error('Yahoo API path must begin with /.');
  const response = await fetch(`${FANTASY_BASE}${pathname}`, {
    headers: {
      'Authorization': `Bearer ${token.accessToken}`,
      'Accept': 'application/xml,text/xml;q=0.9,*/*;q=0.8'
    }
  });
  const text = await response.text();
  if (!response.ok) {
    const err = new Error(`Yahoo Fantasy request failed (${response.status}).`);
    err.status = response.status;
    err.details = text.slice(0, 4000);
    throw err;
  }
  return text;
}
