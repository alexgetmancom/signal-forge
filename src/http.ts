import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { bearerTokenAccepted } from "./auth.js";
import type { AppConfig } from "./config.js";
import { evidenceLabel } from "./events/confidence.js";
import type { EvidenceType } from "./events/types.js";
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
  app.get("/api/status", (c) => c.json(defs.status.handler()));
  app.get("/api/events", (c) => c.json(defs.events.handler({ limit: 20 })));
  app.get("/api/events/:id", (c) => {
    const id = z.coerce.number().int().positive().safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "Invalid event ID" }, 400);
    const event = defs.event.handler({ id: id.data });
    return event ? c.json(event) : c.json({ error: "Not found" }, 404);
  });
  app.get("/api/deliveries", (c) => {
    const limit = z.coerce.number().int().min(1).max(100).default(20).safeParse(c.req.query("limit"));
    if (!limit.success) return c.json({ error: "Invalid limit" }, 400);
    return c.json(defs.deliveries.handler({ limit: limit.data }));
  });
  app.get("/api/deliveries/verification", (c) => {
    const limit = z.coerce.number().int().min(1).max(100).default(20).safeParse(c.req.query("limit"));
    if (!limit.success) return c.json({ error: "Invalid limit" }, 400);
    return c.json(defs.deliveries_needing_verification.handler({ limit: limit.data }));
  });
  app.post("/api/deliveries/:id/verification", (c) => {
    const id = z.coerce.number().int().positive().safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "Invalid delivery ID" }, 400);
    try {
      return c.json(defs.require_delivery_verification.handler({ id: id.data }));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Unable to require delivery verification" }, 400);
    }
  });
  app.post("/api/deliveries/:id/verification/resolve", async (c) => {
    const id = z.coerce.number().int().positive().safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "Invalid delivery ID" }, 400);
    const payload = await c.req.json().catch(() => null);
    const parsed = defs.resolve_delivery_verification.schema.safeParse({
      ...(payload && typeof payload === "object" ? payload : {}),
      id: id.data,
    });
    if (!parsed.success) return c.json({ error: "Invalid delivery verification resolution" }, 400);
    try {
      return c.json(defs.resolve_delivery_verification.handler(parsed.data));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Unable to resolve delivery verification" }, 400);
    }
  });
  app.get("/api/issues", (c) => c.json(defs.issues.handler({})));
  app.get("/api/capabilities", (c) => c.json(defs.capabilities.handler({})));
  app.get("/api/signal-quality", (c) => {
    const days = z.coerce.number().int().min(1).max(90).default(7).safeParse(c.req.query("days"));
    if (!days.success) return c.json({ error: "Invalid days" }, 400);
    return c.json(defs.signal_quality.handler({ days: days.data }));
  });
  app.get("/api/code-analytics", (c) => {
    const days = z.coerce.number().int().min(1).max(90).default(7).safeParse(c.req.query("days"));
    if (!days.success) return c.json({ error: "Invalid days" }, 400);
    return c.json(defs.code_analytics.handler({ days: days.data }));
  });
  app.get("/api/deepseek-usage", (c) => {
    const days = z.coerce.number().int().min(1).max(365).default(7).safeParse(c.req.query("days"));
    if (!days.success) return c.json({ error: "Invalid days" }, 400);
    return c.json(defs.deepseek_usage.handler({ days: days.data }));
  });
  app.get("/api/stories", (c) => {
    const parsed = z
      .object({
        since: z.string().datetime({ offset: true }).optional(),
        minConfidence: z.enum(["observed", "supported", "confirmed", "shipped"]).default("observed"),
        vendor: z.string().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .safeParse({
        since: c.req.query("since"),
        minConfidence: c.req.query("minConfidence"),
        vendor: c.req.query("vendor"),
        limit: c.req.query("limit"),
      });
    if (!parsed.success) return c.json({ error: "Invalid story query" }, 400);
    return c.json(defs.stories.handler(parsed.data));
  });
  app.get("/api/models", (c) => {
    const limit = z.coerce.number().int().min(1).max(100).default(50).safeParse(c.req.query("limit"));
    if (!limit.success) return c.json({ error: "Invalid limit" }, 400);
    return c.json(defs.models.handler({ limit: limit.data }));
  });
  app.get("/api/models/*", (c) => {
    const prefix = "/api/models/";
    const raw = c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) : "";
    let canonicalId: string;
    try {
      canonicalId = decodeURIComponent(raw);
    } catch {
      return c.json({ error: "Invalid model ID" }, 400);
    }
    const parsed = defs.model.schema.safeParse({ canonicalId });
    if (!parsed.success) return c.json({ error: "Invalid model ID" }, 400);
    const model = defs.model.handler(parsed.data);
    return model ? c.json(model) : c.json({ error: "Not found" }, 404);
  });
  app.get("/api/hypotheses", (c) => {
    const status = c.req.query("status");
    const parsed = defs.hypotheses.schema.safeParse({
      ...(status === undefined ? {} : { status }),
      ...(c.req.query("limit") === undefined ? {} : { limit: Number(c.req.query("limit")) }),
    });
    if (!parsed.success) return c.json({ error: "Invalid hypothesis query" }, 400);
    return c.json(
      defs.hypotheses.handler(
        parsed.data.status === undefined
          ? { limit: parsed.data.limit }
          : { status: parsed.data.status, limit: parsed.data.limit },
      ),
    );
  });
  app.get("/api/hypotheses/:id", (c) => {
    const id = z.coerce.number().int().positive().safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "Invalid hypothesis ID" }, 400);
    const hypothesis = defs.hypothesis.handler({ id: id.data });
    return hypothesis ? c.json(hypothesis) : c.json({ error: "Not found" }, 404);
  });
  app.get("/api/deadlines", (c) => {
    const days = z.coerce.number().int().min(1).max(365).default(30).safeParse(c.req.query("days"));
    if (!days.success) return c.json({ error: "Invalid days" }, 400);
    return c.json(defs.lifecycle_deadlines.handler({ days: days.data }));
  });
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
            tools: Object.entries(defs).map(([name, def]) => ({
              name,
              description: def.description,
              inputSchema: z.toJSONSchema(def.schema, { io: "input" }),
            })),
          },
        });
      if (req.method === "tools/call") {
        const name = req.params?.name;
        if (name && Object.hasOwn(defs, name)) {
          const def = defs[name as keyof typeof defs] as { schema: z.ZodType; handler: (input: never) => unknown };
          const input = def.schema.safeParse(req.params?.arguments ?? {});
          if (!input.success)
            return reply({ result: { isError: true, content: [{ type: "text", text: "Invalid tool arguments" }] } });
          try {
            const result = measure(db, `mcp.tool:${name}`, () => def.handler(input.data as never));
            return reply({ result: { content: [{ type: "text", text: JSON.stringify(result) }] } });
          } catch {
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
