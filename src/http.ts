import type { Database } from "bun:sqlite";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { bearerTokenAccepted } from "./auth.js";
import type { AppConfig } from "./config.js";
import { evidenceLabel } from "./events/confidence.js";
import type { EvidenceType } from "./events/types.js";
import { recordOperatorAction } from "./journal.js";
import { redact, redactExternalSecrets } from "./logger.js";
import { operations } from "./operations.js";
import { measure } from "./runtime/metrics.js";

function metricRoute(path: string): string {
  if (path.startsWith("/api/models/") && path !== "/api/models/") return "/api/models/:canonicalId";
  return path.replace(/\/\d+(?=\/|$)/g, "/:id");
}

export function createHttpApp(config: AppConfig, db: Database): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => measure(db, `http.route:${c.req.method}:${metricRoute(c.req.path)}`, () => next()));
  app.get("/", (c) => c.json({ name: "signal-forge", status: "ok" }));
  app.get("/healthz", (c) => c.text("ok\n"));
  app.get("/readyz", (c) => {
    db.query("SELECT 1").get();
    return c.text("ready\n");
  });
  app.use("/reports/*", async (c, next) => {
    if (!config.MCP_TOKEN || !bearerTokenAccepted(c.req.raw, config.MCP_TOKEN)) return c.text("unauthorized\n", 401);
    return next();
  });
  app.get("/reports/:id", (c) => {
    const id = z.coerce.number().int().positive().safeParse(c.req.param("id"));
    if (!id.success) return c.text("Invalid report ID\n", 400);
    const event = db
      .query<
        {
          id: number;
          source: string;
          entity_id: string;
          kind: string;
          before_json: string | null;
          after_json: string | null;
          detected_at: string;
          evidence_type: EvidenceType;
          authority: string;
        },
        [number]
      >(
        "SELECT id,source,entity_id,kind,before_json,after_json,detected_at,evidence_type,authority FROM events WHERE id=?",
      )
      .get(id.data);
    if (!event) return c.text("Report not found\n", 404);
    const escapeHtml = (value: unknown) =>
      String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
    const pretty = (value: string | null) => (value ? JSON.stringify(JSON.parse(value), null, 2) : "—");
    return c.html(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Signal Forge · #${event.id}</title><style>body{font:16px system-ui;max-width:1100px;margin:40px auto;padding:0 20px;color:#17202a}h1{margin-bottom:4px}small{color:#667085}section{margin-top:28px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f6f8;padding:18px;border-radius:10px}</style></head><body><h1>${escapeHtml(event.entity_id)}</h1><small>Signal Forge · ${escapeHtml(event.source)} · ${escapeHtml(event.kind)} · ${escapeHtml(event.detected_at)} · ${escapeHtml(evidenceLabel(event.evidence_type))} · ${escapeHtml(event.authority)} · #${event.id}</small><section><h2>Before</h2><pre>${escapeHtml(pretty(event.before_json))}</pre></section><section><h2>After</h2><pre>${escapeHtml(pretty(event.after_json))}</pre></section></body></html>`,
    );
  });
  app.use("/api/*", bodyLimit({ maxSize: 64 * 1024 }));
  app.use("/api/*", async (c, next) => {
    if (!config.MCP_TOKEN || !bearerTokenAccepted(c.req.raw, config.MCP_TOKEN)) return c.text("unauthorized\n", 401);
    return next();
  });
  const defs = operations(db, config);

  /**
   * One route per registry entry. Validation, the 400 shape, the 404 for a missing entity and the
   * journal entry for a mutation are the same on every route, so they are written once here rather
   * than twenty-five times with the differences that come from that.
   */
  for (const [name, definition] of Object.entries(defs)) {
    const route = definition.http;
    if (!route) continue;
    const respond = async (c: Context) => {
      const raw = route.input
        ? route.input({
            path: c.req.path,
            params: c.req.param() as Record<string, string | undefined>,
            query: c.req.query(),
            body: route.method === "post" ? await c.req.json().catch(() => null) : null,
          })
        : { ...c.req.query(), ...(c.req.param() as Record<string, string | undefined>) };
      const input = definition.schema.safeParse(raw);
      if (!input.success) {
        if (definition.mutates)
          recordOperatorAction(db, { surface: "http", operation: name, input: raw, outcome: "rejected" });
        return c.json({ error: `Invalid input for ${name}` }, 400);
      }
      try {
        const result = await (definition.handler as (value: unknown) => unknown)(input.data);
        if (definition.mutates)
          recordOperatorAction(db, { surface: "http", operation: name, input: input.data, outcome: "ok" });
        if (definition.notFoundWhenEmpty && (result === undefined || result === null))
          return c.json({ error: "Not found" }, 404);
        return c.json((result ?? null) as never);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Operation failed";
        if (definition.mutates)
          recordOperatorAction(db, { surface: "http", operation: name, input: input.data, outcome: "failed", detail });
        // An operator error — a delivery that is not awaiting verification, a credential circuit
        // that is not open — is an answer about the request, not a broken service.
        return c.json({ error: detail }, 400);
      }
    };
    if (route.method === "get") app.get(route.path, respond);
    else app.post(route.path, respond);
  }

  app.post("/api/mcp", async (c) => {
    const schema = z.object({
      jsonrpc: z.literal("2.0"),
      id: z.union([z.string(), z.number()]).optional(),
      method: z.string(),
      params: z.object({ name: z.string().optional(), arguments: z.unknown().optional() }).optional(),
    });
    const payload = await c.req.json().catch(() => null);
    const handle = (raw: unknown): Record<string, unknown> | null => {
      const parsed = schema.safeParse(raw);
      if (!parsed.success) return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } };
      const req = parsed.data;
      const reply = (value: Record<string, unknown>): Record<string, unknown> | null =>
        req.id === undefined ? null : { jsonrpc: "2.0", id: req.id, ...value };
      if (req.method === "initialize")
        return reply({
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "signal-forge", version: "0.1.0" },
          },
        });
      if (req.method === "ping") return reply({ result: {} });
      if (req.method === "tools/list")
        return reply({
          result: {
            tools: Object.entries(defs)
              .filter(([, def]) => def.agent)
              .map(([name, def]) => ({
                name,
                description: def.note ? `${def.summary} ${def.note}` : def.summary,
                inputSchema: z.toJSONSchema(def.schema, { io: "input" }),
              })),
          },
        });
      if (req.method === "tools/call") {
        const name = req.params?.name;
        const def = name && Object.hasOwn(defs, name) ? defs[name] : undefined;
        // An operation that is not on this surface is not a tool here, and saying so is the whole
        // enforcement: a mutation kept off MCP cannot be reached by naming it anyway.
        if (def?.agent) {
          const input = def.schema.safeParse(req.params?.arguments ?? {});
          if (!input.success)
            return reply({ result: { isError: true, content: [{ type: "text", text: "Invalid tool arguments" }] } });
          try {
            const result = measure(db, `mcp.tool:${name}`, () =>
              (def.handler as (value: unknown) => unknown)(input.data),
            );
            if (def.mutates)
              recordOperatorAction(db, { surface: "mcp", operation: name as string, input: input.data, outcome: "ok" });
            return reply({ result: { content: [{ type: "text", text: JSON.stringify(result) }] } });
          } catch (error) {
            if (def.mutates)
              recordOperatorAction(db, {
                surface: "mcp",
                operation: name as string,
                input: input.data,
                outcome: "failed",
                detail: error instanceof Error ? error.message : "Tool execution failed",
              });
            return reply({ error: { code: -32000, message: "Tool execution failed" } });
          }
        }
      }
      return reply({ error: { code: -32601, message: "Unknown method or tool" } });
    };
    if (Array.isArray(payload) && payload.length === 0)
      return c.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
    const responses = Array.isArray(payload)
      ? payload.map(handle).filter((value) => value !== null)
      : [handle(payload)];
    if (!responses.length || responses[0] === null) return c.body(null, 202);
    const body = redactExternalSecrets(JSON.stringify(redact(Array.isArray(payload) ? responses : responses[0])));
    return c.body(body, 200, { "content-type": "application/json" });
  });
  app.onError((_error, c) => c.json({ error: "Internal server error" }, 500));
  return app;
}
