import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { csrf } from "hono/csrf";
import { secureHeaders } from "hono/secure-headers";
import { getAuthenticatedUser, type AuthUser } from "./auth";
import {
  ensureSchema,
  safeParseJson,
  type ChangeRow,
  type StateRow,
  type SyncRunRow,
} from "./database";
import {
  consumeYahooAuthorization, createYahooAuthorization, exchangeYahooCode,
  fetchYahooXml, removeYahooToken, yahooConnection, yahooMissingConfig,
  yahooRedirectUri, type YahooBindings,
} from "./yahoo";

interface Bindings extends YahooBindings {
  ASSETS: Fetcher;
}

type Variables = {
  user: AuthUser;
};

interface ChangeInput {
  source?: string;
  action?: string;
  entityType?: string | null;
  entityId?: string | null;
  metadata?: unknown;
  clientChangeId?: string | null;
}

interface StateWriteInput {
  state?: unknown;
  baseRevision?: number;
  change?: ChangeInput;
}

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

app.use("/api/*", secureHeaders());
app.use("/api/*", csrf());
app.use(
  "/api/*",
  bodyLimit({
    maxSize: 1024 * 1024,
    onError: (context) => context.json({ error: "Request is too large." }, 413),
  }),
);
app.use("/api/*", async (context, next) => {
  context.header("Cache-Control", "no-store");
  const user = getAuthenticatedUser(context.req.raw);
  if (!user) {
    return context.json(
      {
        error: "Authentication is required.",
        signInPath: "/signin-with-chatgpt?return_to=%2F",
      },
      401,
    );
  }
  context.set("user", user);
  await next();
});

app.get("/api/health", async (context) => {
  await ensureSchema(context.env.DB);
  return context.json({
    ok: true,
    version: "2.3.0-alpha.1",
    runtime: "chatgpt-sites",
    persistence: "d1",
  });
});

app.get("/api/session", (context) => {
  return context.json({ user: context.get("user") });
});

app.get("/api/state", async (context) => {
  await ensureSchema(context.env.DB);
  const row = await context.env.DB.prepare(
    `SELECT owner_id, state_json, revision, created_at, updated_at
     FROM situation_room_state
     WHERE owner_id = ?`,
  )
    .bind(context.get("user").userId)
    .first<StateRow>();

  if (!row) {
    return context.json({
      state: null,
      revision: 0,
      createdAt: null,
      updatedAt: null,
    });
  }

  const state = safeParseJson<unknown>(row.state_json);
  if (state === null) {
    return context.json({ error: "Stored Situation Room state is unreadable." }, 500);
  }

  return context.json({
    state,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
});

app.put("/api/state", async (context): Promise<Response> => {
  const input = (await context.req.json().catch(() => null)) as StateWriteInput | null;
  if (!input || !isValidState(input.state)) {
    return context.json({ error: "A valid Situation Room state is required." }, 400);
  }

  const serializedState = JSON.stringify(input.state);
  if (new TextEncoder().encode(serializedState).length > 900_000) {
    return context.json({ error: "Situation Room state is too large." }, 413);
  }

  const baseRevision = Number(input.baseRevision ?? 0);
  if (!Number.isInteger(baseRevision) || baseRevision < 0) {
    return context.json({ error: "baseRevision must be a non-negative integer." }, 400);
  }

  await ensureSchema(context.env.DB);
  const ownerId = context.get("user").userId;
  const now = new Date().toISOString();
  const change = input.change ?? {};
  const source = cleanLabel(change.source, "manual", 40);
  const action = cleanLabel(change.action, "state-update", 80);
  const entityType = cleanNullable(change.entityType, 80);
  const entityId = cleanNullable(change.entityId, 160);
  const clientChangeId = cleanNullable(change.clientChangeId, 160);
  const metadataJson = encodeOptional(change.metadata);

  if (clientChangeId) {
    const duplicate = await context.env.DB.prepare(
      `SELECT id, revision, created_at
       FROM situation_room_changes
       WHERE owner_id = ? AND client_change_id = ?`,
    )
      .bind(ownerId, clientChangeId)
      .first<{ id: string; revision: number; created_at: string }>();

    if (duplicate) {
      const current = await readStateRow(context.env.DB, ownerId);
      if (current && current.revision === duplicate.revision) {
        return context.json({
          ok: true,
          duplicate: true,
          revision: current.revision,
          updatedAt: current.updated_at,
          changeId: duplicate.id,
        });
      }
      return conflictResponse(
        context,
        current,
        "This save was already applied, but newer Site state now exists.",
        { duplicate: true, duplicateRevision: duplicate.revision },
      );
    }
  }

  const current = await readStateRow(context.env.DB, ownerId);
  const currentRevision = current?.revision ?? 0;
  if (currentRevision !== baseRevision) {
    return conflictResponse(
      context,
      current,
      "Situation Room state changed in another session.",
    );
  }

  const nextRevision = currentRevision + 1;
  const changeId = crypto.randomUUID();
  const diff = stateDiff(current ? safeParseJson(current.state_json) : null, input.state);
  const beforeJson = JSON.stringify(diff.before);
  const afterJson = JSON.stringify(diff.after);

  const writeState = current
    ? context.env.DB.prepare(
        `UPDATE situation_room_state
         SET state_json = ?, revision = ?, updated_at = ?
         WHERE owner_id = ? AND revision = ?`,
      ).bind(serializedState, nextRevision, now, ownerId, currentRevision)
    : context.env.DB.prepare(
        `INSERT INTO situation_room_state
          (owner_id, state_json, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(ownerId, serializedState, nextRevision, now, now);

  const writeChange = context.env.DB.prepare(
    `INSERT INTO situation_room_changes
      (id, owner_id, revision, source, action, entity_type, entity_id,
       before_json, after_json, metadata_json, client_change_id, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1`,
  ).bind(
    changeId,
    ownerId,
    nextRevision,
    source,
    action,
    entityType,
    entityId,
    beforeJson,
    afterJson,
    metadataJson,
    clientChangeId,
    now,
  );
  const writeRevision = context.env.DB.prepare(
    `INSERT INTO situation_room_revisions
      (owner_id, revision, state_json, change_id, created_at)
     SELECT ?, ?, ?, ?, ? WHERE changes() = 1`,
  ).bind(ownerId, nextRevision, serializedState, changeId, now);
  const writeSync = source === "yahoo" && action === "yahoo-sync"
    ? context.env.DB.prepare(
        `INSERT INTO situation_room_sync_runs
          (id, owner_id, provider, status, started_at, completed_at, summary_json, error_text)
         SELECT ?, ?, 'yahoo', 'success', ?, ?, ?, NULL WHERE changes() = 1`,
      ).bind(crypto.randomUUID(), ownerId, now, now, metadataJson)
    : null;

  try {
    const results = await context.env.DB.batch(writeSync
      ? [writeState, writeChange, writeRevision, writeSync]
      : [writeState, writeChange, writeRevision]);
    const stateWrite = results[0];
    if (!stateWrite.success || !stateWrite.meta.changes || !results[1].meta.changes || !results[2].meta.changes) {
      const latest = await readStateRow(context.env.DB, ownerId);
      return conflictResponse(
        context,
        latest,
        "Situation Room state changed during save.",
      );
    }
  } catch (error) {
    if (isUniqueConstraint(error)) {
      if (clientChangeId) {
        const duplicate = await context.env.DB.prepare(
          `SELECT id, revision, created_at
           FROM situation_room_changes
           WHERE owner_id = ? AND client_change_id = ?`,
        )
          .bind(ownerId, clientChangeId)
          .first<{ id: string; revision: number; created_at: string }>();
        if (duplicate) {
          const latest = await readStateRow(context.env.DB, ownerId);
          if (latest && latest.revision === duplicate.revision) {
            return context.json({
              ok: true,
              duplicate: true,
              revision: latest.revision,
              updatedAt: latest.updated_at,
              changeId: duplicate.id,
            });
          }
          return conflictResponse(
            context,
            latest,
            "This save was already applied, but newer Site state now exists.",
            { duplicate: true, duplicateRevision: duplicate.revision },
          );
        }
      }

      const latest = await readStateRow(context.env.DB, ownerId);
      return conflictResponse(
        context,
        latest,
        "Situation Room state changed during save.",
      );
    }
    throw error;
  }

  return context.json({
    ok: true,
    revision: nextRevision,
    updatedAt: now,
    changeId,
  });
});

app.get("/api/changes", async (context) => {
  await ensureSchema(context.env.DB);
  const requested = Number(context.req.query("limit") ?? 100);
  const limit = Number.isFinite(requested)
    ? Math.max(1, Math.min(250, Math.trunc(requested)))
    : 100;

  const result = await context.env.DB.prepare(
    `SELECT id, revision, source, action, entity_type, entity_id,
            before_json, after_json, metadata_json, client_change_id, created_at
     FROM situation_room_changes
     WHERE owner_id = ?
     ORDER BY revision DESC
     LIMIT ?`,
  )
    .bind(context.get("user").userId, limit)
    .all<ChangeRow>();

  return context.json({
    changes: result.results.map((row) => ({
      id: row.id,
      revision: row.revision,
      source: row.source,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      before: safeParseJson(row.before_json),
      after: safeParseJson(row.after_json),
      metadata: safeParseJson(row.metadata_json),
      clientChangeId: row.client_change_id,
      createdAt: row.created_at,
    })),
  });
});

app.get("/api/sync-runs", async (context) => {
  await ensureSchema(context.env.DB);
  const result = await context.env.DB.prepare(
    `SELECT id, provider, status, started_at, completed_at, summary_json, error_text
     FROM situation_room_sync_runs
     WHERE owner_id = ?
     ORDER BY started_at DESC
     LIMIT 100`,
  )
    .bind(context.get("user").userId)
    .all<SyncRunRow>();

  return context.json({
    syncRuns: result.results.map((row) => ({
      id: row.id,
      provider: row.provider,
      status: row.status,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      summary: safeParseJson(row.summary_json),
      error: row.error_text,
    })),
  });
});

app.get("/api/yahoo/status", async (context) => {
  await ensureSchema(context.env.DB);
  const missingConfig = yahooMissingConfig(context.env);
  if (!yahooRedirectUri(context.env, context.req.raw)) missingConfig.push("YAHOO_REDIRECT_URI (must match this Site)");
  if (missingConfig.length) return context.json({ configured: false, connected: false,
    writeEnabled: false, readOnlyDefault: true, missingConfig,
    redirectUri: context.env.YAHOO_REDIRECT_URI ?? null,
    message: "Set the Yahoo Site secrets and register the callback URL before connecting." });
  try {
    const connection = await yahooConnection(context.env, context.get("user").userId);
    return context.json({ configured: true, ...connection, writeEnabled: false,
      readOnlyDefault: true, redirectUri: context.env.YAHOO_REDIRECT_URI });
  } catch (error) {
    return context.json({ configured: true, connected: false, writeEnabled: false,
      readOnlyDefault: true, redirectUri: context.env.YAHOO_REDIRECT_URI,
      error: String((error as Error).message) });
  }
});

app.get("/api/yahoo/login", async (context) => {
  await ensureSchema(context.env.DB);
  if (yahooMissingConfig(context.env).length || !yahooRedirectUri(context.env, context.req.raw))
    return context.json({ error: "Yahoo Site secrets or callback are not configured." }, 503);
  const auth = await createYahooAuthorization(context.env, context.get("user").userId);
  context.header("Set-Cookie", yahooStateCookie(auth.state, context.req.url));
  return context.redirect(auth.location);
});

app.get("/api/yahoo/callback", async (context) => {
  await ensureSchema(context.env.DB);
  const supplied = context.req.query("state") ?? "";
  const expected = readCookie(context.req.raw, "dps_yahoo_state");
  context.header("Set-Cookie", yahooStateCookie("", context.req.url, true));
  if (!supplied || supplied !== expected || !await consumeYahooAuthorization(context.env, context.get("user").userId, supplied))
    return context.json({ error: "Yahoo authorization state expired or did not match." }, 400);
  const code = context.req.query("code");
  if (!code) return context.json({ error: "Yahoo authorization was cancelled or did not return a code." }, 400);
  await exchangeYahooCode(context.env, context.get("user").userId, code);
  return context.redirect("/?yahoo=connected");
});

app.post("/api/yahoo/disconnect", async (context) => {
  await ensureSchema(context.env.DB);
  await removeYahooToken(context.env, context.get("user").userId);
  return context.json({ ok: true });
});

app.get("/api/yahoo/teams", async (context) => {
  await ensureSchema(context.env.DB);
  return fetchYahooXml(context.env, context.get("user").userId,
    "/users;use_login=1/games/teams");
});

app.get("/api/yahoo/roster", async (context) => {
  const teamKey = context.req.query("teamKey") ?? "";
  const date = context.req.query("date") ?? "";
  if (!validTeamKey(teamKey) || !/^20\d{2}-\d{2}-\d{2}$/.test(date))
    return context.json({ error: "Valid teamKey and date are required." }, 400);
  await ensureSchema(context.env.DB);
  return fetchYahooXml(context.env, context.get("user").userId,
    `/team/${teamKey}/roster;date=${date}/players;out=stats,percent_owned`);
});

app.get("/api/yahoo/league-teams", async (context) => {
  const leagueKey = context.req.query("leagueKey") ?? "";
  if (!validLeagueKey(leagueKey)) return context.json({ error: "Valid leagueKey is required." }, 400);
  await ensureSchema(context.env.DB);
  return fetchYahooXml(context.env, context.get("user").userId,
    `/league/${leagueKey}/teams`);
});

app.get("/api/yahoo/available", async (context) => {
  const leagueKey = context.req.query("leagueKey") ?? "";
  if (!validLeagueKey(leagueKey)) return context.json({ error: "Valid leagueKey is required." }, 400);
  const rawStatus = context.req.query("status") ?? "A";
  const status = ["A", "FA", "W"].includes(rawStatus) ? rawStatus : "A";
  const rawPosition = (context.req.query("position") ?? "").toUpperCase();
  const position = ["C", "LW", "RW", "D", "G"].includes(rawPosition) ? `;position=${rawPosition}` : "";
  const rawSearch = (context.req.query("search") ?? "").trim().slice(0, 60);
  const search = rawSearch ? `;search=${encodeURIComponent(rawSearch)}` : "";
  const start = boundedInt(context.req.query("start"), 0, 0, 5000);
  const count = boundedInt(context.req.query("count"), 50, 1, 100);
  await ensureSchema(context.env.DB);
  return fetchYahooXml(context.env, context.get("user").userId,
    `/league/${leagueKey}/players;status=${status}${position}${search};sort=PTS;sort_type=season;start=${start};count=${count};out=stats,ownership,percent_owned`);
});

app.get("/api/yahoo/transactions", async (context) => {
  const leagueKey = context.req.query("leagueKey") ?? "";
  const teamKey = context.req.query("teamKey") ?? "";
  if (!validLeagueKey(leagueKey) || !validTeamKey(teamKey)) return context.json({ error: "Valid leagueKey and teamKey are required." }, 400);
  const count = boundedInt(context.req.query("count"), 25, 1, 100);
  await ensureSchema(context.env.DB);
  return fetchYahooXml(context.env, context.get("user").userId,
    `/league/${leagueKey}/transactions;team_key=${teamKey};count=${count}`);
});

app.get("/api/yahoo/league", async (context) => {
  const leagueKey = context.req.query("leagueKey") ?? "";
  if (!validLeagueKey(leagueKey)) return context.json({ error: "Valid leagueKey is required." }, 400);
  await ensureSchema(context.env.DB);
  return fetchYahooXml(context.env, context.get("user").userId, `/league/${leagueKey};out=settings,standings`);
});

app.post("/api/yahoo/sync-failure", async (context) => {
  await ensureSchema(context.env.DB);
  const input = await context.req.json().catch(() => ({})) as { error?: unknown };
  const errorText = String(input.error ?? "Yahoo sync failed.").slice(0, 500);
  const now = new Date().toISOString();
  await context.env.DB.prepare(
    `INSERT INTO situation_room_sync_runs
      (id, owner_id, provider, status, started_at, completed_at, summary_json, error_text)
     VALUES (?, ?, 'yahoo', 'failed', ?, ?, NULL, ?)`,
  ).bind(crypto.randomUUID(), context.get("user").userId, now, now, errorText).run();
  return context.json({ ok: true });
});

app.all("/api/yahoo/*", (context) => {
  return context.json(
    {
      error: "Yahoo integration is not configured yet.",
      code: "YAHOO_NOT_CONFIGURED",
    },
    501,
  );
});

app.get("/api/nhl/schedule", async (context) => {
  const date = String(context.req.query("date") ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return context.json({ error: "A YYYY-MM-DD date is required." }, 400);
  }

  const response = await fetch(`https://api-web.nhle.com/v1/schedule/${encodeURIComponent(date)}`);
  if (!response.ok) {
    return context.json({ error: `NHL schedule request failed (${response.status}).` }, 502);
  }
  return new Response(await response.text(), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
});

app.notFound(async (context) => {
  const requestUrl = new URL(context.req.url);
  if (requestUrl.pathname !== "/api" && !requestUrl.pathname.startsWith("/api/")) {
    const asset = await context.env.ASSETS.fetch(context.req.raw);
    const headers = new Headers(asset.headers);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "same-origin");
    headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (headers.get("Content-Type")?.includes("text/html")) {
      headers.set(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'",
      );
    }
    return new Response(asset.body, {
      status: asset.status,
      statusText: asset.statusText,
      headers,
    });
  }
  return context.json({ error: "API route was not found." }, 404);
});

app.onError((error, context) => {
  console.error("Situation Room API error", error);
  return context.json({ error: "Situation Room could not complete the request." }, 500);
});

async function readStateRow(database: D1Database, ownerId: string) {
  return database.prepare(
    `SELECT owner_id, state_json, revision, created_at, updated_at
     FROM situation_room_state
     WHERE owner_id = ?`,
  )
    .bind(ownerId)
    .first<StateRow>();
}

function conflictResponse(
  context: any,
  current: StateRow | null,
  message: string,
  extra: Record<string, unknown> = {},
) {
  return context.json(
    {
      error: message,
      conflict: true,
      revision: current?.revision ?? 0,
      state: current ? safeParseJson(current.state_json) : null,
      updatedAt: current?.updated_at ?? null,
      ...extra,
    },
    409,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanLabel(value: unknown, fallback: string, max: number): string {
  const text = String(value ?? "").trim().slice(0, max);
  return text || fallback;
}

function cleanNullable(value: unknown, max: number): string | null {
  const text = String(value ?? "").trim().slice(0, max);
  return text || null;
}

function encodeOptional(value: unknown): string | null {
  if (value === undefined) return null;
  return JSON.stringify(value);
}

function isUniqueConstraint(error: unknown): boolean {
  return /unique|constraint/i.test(String((error as Error)?.message ?? error));
}

function validLeagueKey(value: string): boolean { return /^[A-Za-z0-9]+\.l\.\d+$/.test(value); }
function validTeamKey(value: string): boolean { return /^[A-Za-z0-9]+\.l\.\d+\.t\.\d+$/.test(value); }
function boundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}
function readCookie(request: Request, name: string): string {
  const cookie = request.headers.get("cookie") ?? "";
  return cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(name + "="))?.slice(name.length + 1) ?? "";
}
function yahooStateCookie(value: string, requestUrl: string, clear = false): string {
  const secure = new URL(requestUrl).protocol === "https:" ? "; Secure" : "";
  return `dps_yahoo_state=${value}; Path=/api/yahoo; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : 600}${secure}`;
}

function isValidState(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return Array.isArray(state.roster) && Array.isArray(state.waivers)
    && !!state.schedule && typeof state.schedule === "object" && !Array.isArray(state.schedule)
    && typeof state.selectedDate === "string"
    && typeof state.movesThisWeek === "number" && Number.isFinite(state.movesThisWeek)
    && !!state.yahoo && typeof state.yahoo === "object" && !Array.isArray(state.yahoo);
}

function stateDiff(previous: unknown, next: unknown): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const oldState = previous && typeof previous === "object" ? previous as Record<string, unknown> : {};
  const newState = next as Record<string, unknown>;
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(oldState), ...Object.keys(newState)])) {
    if (JSON.stringify(oldState[key]) === JSON.stringify(newState[key])) continue;
    before[key] = oldState[key] ?? null;
    after[key] = newState[key] ?? null;
  }
  return { before, after };
}

export default app;
