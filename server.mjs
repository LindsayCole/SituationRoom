import http from 'node:http';
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildAuthorizationUrl, exchangeAuthorizationCode, fetchYahooXml, getValidToken, yahooConfigured, yahooMissingConfig } from './lib/yahoo.mjs';
import { deleteToken } from './lib/token-store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
loadDotEnv(path.join(__dirname, '.env'));

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8787);
const APP_ORIGIN = process.env.APP_ORIGIN || `http://${HOST}:${PORT}`;
const WRITE_ENABLED = String(process.env.YAHOO_WRITE_ENABLED || '').toLowerCase() === 'true';

function loadDotEnv(file) {
  try {
    const text = readFileSync(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx < 1) continue;
      const key = trimmed.slice(0, idx).trim();
      let value = trimmed.slice(idx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {}
}


function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control':'no-store', ...securityHeaders() });
  res.end(body);
}
function xml(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/xml; charset=utf-8', 'Content-Length': Buffer.byteLength(value), 'Cache-Control':'no-store', ...securityHeaders() });
  res.end(value);
}
function redirect(res, location, headers={}) {
  res.writeHead(302, { Location: location, 'Cache-Control':'no-store', ...headers, ...securityHeaders() });
  res.end();
}
function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; connect-src 'self' https://api-web.nhle.com; base-uri 'none'; frame-ancestors 'none'"
  };
}
function parseCookies(req) {
  const out = {};
  for (const item of String(req.headers.cookie || '').split(';')) {
    const idx = item.indexOf('=');
    if (idx < 1) continue;
    out[item.slice(0, idx).trim()] = decodeURIComponent(item.slice(idx + 1).trim());
  }
  return out;
}
function oauthCookie(value, clear=false) {
  const secure = APP_ORIGIN.startsWith('https://') ? '; Secure' : '';
  return `dps_yahoo_state=${encodeURIComponent(value)}; Path=/api/yahoo; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : 600}${secure}`;
}
function validateTeamKey(v) { return /^[A-Za-z0-9]+\.l\.\d+\.t\.\d+$/.test(v || ''); }
function validateLeagueKey(v) { return /^[A-Za-z0-9]+\.l\.\d+$/.test(v || ''); }
function validateDate(v) { return /^20\d{2}-\d{2}-\d{2}$/.test(v || ''); }
function intParam(v, fallback, min, max) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

async function yahooProxy(req, res, url) {
  if (url.pathname === '/api/yahoo/teams') {
    return xml(res, 200, await fetchYahooXml('/users;use_login=1/games;game_codes=nhl;is_available=1/teams'));
  }
  if (url.pathname === '/api/yahoo/roster') {
    const teamKey = url.searchParams.get('teamKey');
    const date = url.searchParams.get('date');
    if (!validateTeamKey(teamKey) || !validateDate(date)) return json(res, 400, { error: 'Valid teamKey and date are required.' });
    return xml(res, 200, await fetchYahooXml(`/team/${teamKey}/roster;date=${date}/players;out=stats,percent_owned`));
  }
  if (url.pathname === '/api/yahoo/available') {
    const leagueKey = url.searchParams.get('leagueKey');
    if (!validateLeagueKey(leagueKey)) return json(res, 400, { error: 'Valid leagueKey is required.' });
    const status = ['A','FA','W'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : 'A';
    const start = intParam(url.searchParams.get('start'), 0, 0, 5000);
    const count = intParam(url.searchParams.get('count'), 50, 1, 100);
    const posRaw = String(url.searchParams.get('position') || '').toUpperCase();
    const pos = ['C','LW','RW','D','G'].includes(posRaw) ? `;position=${posRaw}` : '';
    const searchRaw = String(url.searchParams.get('search') || '').trim().slice(0, 60);
    const search = searchRaw ? `;search=${encodeURIComponent(searchRaw)}` : '';
    const apiPath = `/league/${leagueKey}/players;status=${status}${pos}${search};sort=PTS;sort_type=season;start=${start};count=${count};out=stats,ownership,percent_owned`;
    return xml(res, 200, await fetchYahooXml(apiPath));
  }
  if (url.pathname === '/api/yahoo/transactions') {
    const leagueKey = url.searchParams.get('leagueKey');
    const teamKey = url.searchParams.get('teamKey');
    if (!validateLeagueKey(leagueKey) || !validateTeamKey(teamKey)) return json(res, 400, { error: 'Valid leagueKey and teamKey are required.' });
    const count = intParam(url.searchParams.get('count'), 25, 1, 100);
    return xml(res, 200, await fetchYahooXml(`/league/${leagueKey}/transactions;team_key=${teamKey};count=${count}`));
  }
  if (url.pathname === '/api/yahoo/league') {
    const leagueKey = url.searchParams.get('leagueKey');
    if (!validateLeagueKey(leagueKey)) return json(res, 400, { error: 'Valid leagueKey is required.' });
    return xml(res, 200, await fetchYahooXml(`/league/${leagueKey};out=settings,standings`));
  }
  return false;
}

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.resolve(PUBLIC_DIR, '.' + rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== path.join(PUBLIC_DIR, 'index.html')) return false;
  try {
    const st = await fs.stat(file);
    if (!st.isFile()) return false;
    const ext = path.extname(file).toLowerCase();
    const type = ({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml'})[ext] || 'application/octet-stream';
    const data = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length, ...securityHeaders() });
    res.end(data);
    return true;
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, APP_ORIGIN);

    if (url.pathname === '/api/health') return json(res, 200, { ok: true, version: '2.0.0-alpha.1' });

    if (url.pathname === '/api/nhl/schedule') {
      const date = url.searchParams.get('date');
      if (!validateDate(date)) return json(res, 400, { error: 'Valid date is required.' });
      const upstream = await fetch(`https://api-web.nhle.com/v1/schedule/${date}`, { headers:{ 'Accept':'application/json' } });
      const text = await upstream.text();
      if (!upstream.ok) return json(res, upstream.status, { error:`NHL schedule request failed (${upstream.status}).` });
      res.writeHead(200, { 'Content-Type':'application/json; charset=utf-8', 'Content-Length':Buffer.byteLength(text), ...securityHeaders() });
      return res.end(text);
    }

    if (url.pathname === '/api/yahoo/status') {
      const configured = yahooConfigured();
      let token = null;
      if (configured) {
        try { token = await getValidToken(); } catch (err) { return json(res, 200, { configured, connected:false, error:err.message, writeEnabled:WRITE_ENABLED, readOnlyDefault:true }); }
      }
      return json(res, 200, {
        configured,
        missingConfig:yahooMissingConfig(),
        connected:Boolean(token),
        expiresAt:token?.expiresAt || null,
        redirectUri:process.env.YAHOO_REDIRECT_URI || null,
        writeEnabled:WRITE_ENABLED,
        readOnlyDefault:true
      });
    }

    if (url.pathname === '/api/yahoo/login') {
      if (!yahooConfigured()) return json(res, 503, { error: 'Yahoo OAuth is not configured. Copy .env.example to .env and add credentials.' });
      const state = crypto.randomBytes(24).toString('hex');
      const location = buildAuthorizationUrl({ clientId:process.env.YAHOO_CLIENT_ID, redirectUri:process.env.YAHOO_REDIRECT_URI, state });
      return redirect(res, location, { 'Set-Cookie': oauthCookie(state) });
    }

    if (url.pathname === '/api/yahoo/callback') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const expected = parseCookies(req).dps_yahoo_state;
      if (!code || !state || !expected || state !== expected) return json(res, 400, { error: 'Yahoo OAuth state check failed. Start the connection again.' });
      await exchangeAuthorizationCode(code);
      return redirect(res, '/?yahoo=connected', { 'Set-Cookie': oauthCookie('', true) });
    }

    if (url.pathname === '/api/yahoo/disconnect' && req.method === 'POST') {
      await deleteToken();
      return json(res, 200, { ok:true });
    }

    if (url.pathname.startsWith('/api/yahoo/')) {
      const handled = await yahooProxy(req, res, url);
      if (handled !== false) return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (await serveStatic(req, res, url)) return;
    }

    json(res, 404, { error: 'Not found.' });
  } catch (err) {
    console.error(err);
    const details = process.env.NODE_ENV === 'production' ? undefined : (typeof err?.details === 'string' ? err.details : undefined);
    json(res, err?.status || 500, { error: err.message || 'Server error.', details });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Dead Puck Situation Room v2: ${APP_ORIGIN}`);
  console.log(`Yahoo configured: ${yahooConfigured() ? 'yes' : 'no'}`);
  console.log(`Yahoo write feature flag: ${WRITE_ENABLED ? 'enabled (approval required)' : 'disabled'}`);
});
