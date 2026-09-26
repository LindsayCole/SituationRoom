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

interface Bindings {
  DB: D1Database;
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
  before?: unknown;
  after?: unknown;
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
    version: "2.2.0-alpha.1",
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

app.put("/api/state", async (context) => {
  const input = (await context.req.json().catch(() => null)) as StateWriteInput | null;
  if (!input || !isRecord(input.state)) {
    return context.json({ error: "A Situation Room state object is required." }, 400);
  }

  const serializedState = JSON.stringify(input.state);
  if (serializedState.length > 900_000) {
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
  const beforeJson = encodeOptional(change.before);
  const afterJson = encodeOptional(change.after);
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
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

  try {
    const results = await context.env.DB.batch([writeState, writeChange]);
    const stateWrite = results[0];
    if (!stateWrite.success || (current && !stateWrite.meta.changes)) {
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

app.get("/api/yahoo/status", (context) => {
  return context.json({
    configured: false,
    connected: false,
    writeEnabled: false,
    readOnlyDefault: true,
    siteReady: true,
    message: "Persistent Site storage is ready. Yahoo application authorization is the next integration step.",
  });
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
    return context.env.ASSETS.fetch(context.req.raw);
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
  context: Parameters<typeof app.fetch>[1] extends never ? never : any,
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

export default app;
