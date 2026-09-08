import type { Database } from "bun:sqlite";
import type { Destination } from "./config.js";

export type RecordData = { id: string; name: string; [key: string]: unknown };
export type Collection = {
  source: string;
  stream: string;
  url: string;
  records: RecordData[];
  raw: unknown;
  appendOnly?: boolean;
  silentIds?: string[];
  trackChanges?: boolean;
  confirmChanges?: boolean;
};
export type Event = {
  id: number;
  source: string;
  stream: string;
  entity_id: string;
  kind: "new" | "changed" | "removed";
  before_json: string | null;
  after_json: string | null;
  detected_at: string;
};
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
export function splitMessage(text: string, limit = 1900): string[] {
  const parts: string[] = [];
  while (text.length > limit) {
    let end = text.lastIndexOf("\n", limit);
    if (end < limit / 2) end = limit;
    if (/[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) end--;
    parts.push(text.slice(0, end));
    text = text.slice(end);
    if (text.startsWith("\n")) text = text.slice(1);
  }
  if (text) parts.push(text);
  return parts;
}
const fieldLabels: Record<string, string> = {
  name: "Name",
  context: "Context",
  input: "Input",
  output: "Output",
  parameters: "Parameters",
  provider: "Provider",
  maker: "Maker",
  selectable: "Selectable",
  model: "Model",
  created: "Created",
  published: "Published",
  stage: "Stage",
  author: "Author",
  association: "Repository association",
  owner: "Owner",
  category: "Category",
  methods: "Methods",
  inputTokenLimit: "Input token limit",
  outputTokenLimit: "Output token limit",
};
const sourceLabels: Record<string, string> = {
  openrouter: "OpenRouter",
  openai: "OpenAI API",
  anthropic: "Anthropic API",
  gemini: "Gemini API",
  arena: "Arena",
  "arena-leaderboards": "Arena · leaderboards",
  "openai-news": "OpenAI · news",
  "anthropic-news": "Anthropic · news",
  "claude-web": "Claude · interface",
  "codex-docs": "Codex · docs",
  "vercel-gateway": "Vercel AI Gateway",
  "cursor-changelog": "Cursor · changelog",
};
function describe(value: unknown): string {
  if (value === null || value === undefined || value === "") return "not set";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value)) return value.map(describe).join(", ");
  if (typeof value === "object")
    return Object.entries(value)
      .map(([k, v]) => (v === true ? k : `${k}: ${describe(v)}`))
      .join(", ");
  return String(value);
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Built by hand rather than through Intl: the runtime's ICU data decides whether `short` means
 * "Sep" or "Sept" and whether the separator is a comma or " at ", so the same event rendered on a
 * laptop and in the container came out differently. A feed's timestamps must not depend on that.
 */
export function utcStamp(iso: string): string {
  const at = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(at.getUTCDate())} ${MONTHS[at.getUTCMonth()]} ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())} UTC`;
}

export function meaningfulWebString(value: string): boolean {
  if (value.length < 18 || value.length > 500 || /^[-+\d\s.,:;/()]+$/.test(value)) return false;
  return /\b(Claude|model|agent|Cowork|Code|browser|connector|plugin|skill|MCP|API|usage|context|remote|project|worktree|GitHub|Slack|memory|plan|tool|SSH|Bedrock|security|permission|approval)\b/i.test(
    value,
  );
}
/**
 * A rank is only interesting as a movement. Reporting "rank: 7 → 5" makes the reader do the
 * subtraction; reporting the arrow and the distance is the sentence they would have written.
 */
export function rankMove(before: unknown, after: unknown): string {
  const from = Number(before);
  const to = Number(after);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return `Rank: ${describe(before)} → ${describe(after)}`;
  const distance = Math.abs(to - from);
  const arrow = to < from ? "🔼" : "🔽";
  return `Rank ${to} ${arrow} ${distance} (was ${from})`;
}

function prices(before: unknown, after: unknown): string[] {
  const old = before && typeof before === "object" ? (before as Record<string, unknown>) : {};
  const next = after && typeof after === "object" ? (after as Record<string, unknown>) : {};
  const labels: Record<string, string> = {
    prompt: "Input",
    completion: "Output",
    input_cache_read: "Cache read",
    input_cache_write: "Cache write",
  };
  const money = (v: unknown) =>
    typeof v === "string" && v.trim() && Number.isFinite(Number(v)) && Number(v) >= 0
      ? `$${Number((Number(v) * 1_000_000).toFixed(6))}`
      : describe(v);
  const result: string[] = [];
  for (const key of new Set([...Object.keys(old), ...Object.keys(next)])) {
    if (canonical(old[key]) === canonical(next[key])) continue;
    if (labels[key])
      result.push(`${labels[key]}: ${before ? `${money(old[key])} → ` : ""}${money(next[key])} / 1M tokens`);
    else result.push(`Pricing ${key}: ${before ? `${describe(old[key])} → ` : ""}${describe(next[key])}`);
  }
  return result;
}
/**
 * A rewritten page or a reshaped record can change forty fields at once. Printing all of them
 * turns the message into a wall nobody reads, so the message carries the first few and says how
 * many it is holding back; the full before/after stays in the database either way.
 */
export const MAX_DETAIL_LINES = 8;
const MAX_DETAIL_CHARS = 300;
export function collapseDetails(details: string[], max = MAX_DETAIL_LINES): string[] {
  const trimmed = details.map((line) =>
    line.length > MAX_DETAIL_CHARS ? `${line.slice(0, MAX_DETAIL_CHARS - 1)}\u2026` : line,
  );
  if (trimmed.length <= max) return trimmed;
  const hidden = trimmed.length - max;
  return [...trimmed.slice(0, max), `\u2026and ${hidden} more change${hidden === 1 ? "" : "s"} not shown`];
}

export function renderEvent(
  event: Event,
  url: string,
  reportBaseUrl?: string,
  platform: Destination["platform"] = "telegram",
): string {
  const before = event.before_json ? (JSON.parse(event.before_json) as RecordData) : null;
  const after = event.after_json ? (JSON.parse(event.after_json) as RecordData) : null;
  const record = after ?? before;
  const labels = { new: "🆕 New", changed: "✏️ Changed", removed: "🗑️ Removed" };
  const source =
    sourceLabels[event.source] ??
    event.source
      .replace("github:", "GitHub · ")
      .replace(":commits", " · commits")
      .replace(":releases", " · releases")
      .replace(":pulls", " · PR");
  const lines = [`${labels[event.kind]} · ${source}`, String(record?.name ?? event.entity_id), ""];
  if (event.stream === "web" && before && after && Array.isArray(before.strings) && Array.isArray(after.strings)) {
    const previous = new Set(before.strings as string[]),
      current = new Set(after.strings as string[]);
    const added = [...current].filter((s) => !previous.has(s)),
      removed = [...previous].filter((s) => !current.has(s));
    const usefulAdded = added.filter(meaningfulWebString);
    const usefulRemoved = removed.filter(meaningfulWebString);
    lines.push(
      `Meaningful strings: +${usefulAdded.length}/−${usefulRemoved.length}; total changed: +${added.length}/−${removed.length}`,
    );
    lines.push(
      ...usefulAdded.slice(0, 12).map((s) => `+ ${s.slice(0, 180)}`),
      ...usefulRemoved.slice(0, 3).map((s) => `− ${s.slice(0, 180)}`),
    );
    if (!usefulAdded.length && !usefulRemoved.length)
      lines.push("Only boilerplate or short strings; the report has the details.");
    lines.push("A public text change is not yet confirmation that a feature shipped.");
  } else if (event.stream === "arena" && before && after && before.name !== after.name) {
    // Arenas list unreleased models under a codename and rename them once the model is announced.
    // That rename is the story: it is the moment a codename becomes a product.
    lines.push(`${describe(before.name)} → ${describe(after.name)}`);
    if (after.maker && after.maker !== before.maker) lines.push(`Identified as ${describe(after.maker)}`);
    for (const key of ["input", "output", "selectable"]) {
      if (canonical(before[key]) !== canonical(after[key]))
        lines.push(`${fieldLabels[key] ?? key}: ${describe(before[key])} → ${describe(after[key])}`);
    }
  } else if (event.stream === "github") {
    if (record?.stage) lines.push(describe(record.stage));
    else if (event.source.endsWith(":commits")) lines.push("Repository change; not a release yet");
    else if (event.source.endsWith(":releases")) lines.push("Published release");
    if (record?.author) lines.push(`Author: ${describe(record.author)} (${describe(record.association)})`);
    lines.push(describe(record?.summary));
  } else if (before && after) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (["head", "updated"].includes(key) || canonical(before[key]) === canonical(after[key])) continue;
      if (key === "pricing") {
        lines.push(...prices(before[key], after[key]));
        continue;
      }
      if (key === "rank") {
        lines.push(rankMove(before[key], after[key]));
        continue;
      }
      if (Array.isArray(before[key]) && Array.isArray(after[key])) {
        const old = before[key] as unknown[],
          next = after[key] as unknown[];
        const added = next.filter((v) => !old.some((o) => canonical(o) === canonical(v))),
          removed = old.filter((v) => !next.some((o) => canonical(o) === canonical(v)));
        if (added.length) lines.push(`${fieldLabels[key] ?? key}: + ${describe(added)}`);
        if (removed.length) lines.push(`${fieldLabels[key] ?? key}: − ${describe(removed)}`);
      } else lines.push(`${fieldLabels[key] ?? key}: ${describe(before[key])} → ${describe(after[key])}`);
    }
  } else {
    for (const [key, value] of Object.entries(record ?? {})) {
      if (["id", "name", "url", "prerelease", "head", "updated"].includes(key)) continue;
      if (key === "pricing") lines.push(...prices(null, value));
      else if (key === "description" || key === "summary" || key === "message") lines.push(describe(value));
      else lines.push(`${fieldLabels[key] ?? key}: ${describe(value)}`);
    }
  }
  // The header is three lines (kind/source, name, blank); everything after it is detail.
  lines.push(...collapseDetails(lines.splice(3)));
  const link =
    typeof record?.url === "string"
      ? record.url
      : event.source === "openrouter"
        ? `https://openrouter.ai/${event.entity_id}`
        : url;
  // Discord renders <t:unix:f> in each viewer's own timezone, so a reader in California sees
  // California time and one in Berlin sees Berlin time. No fixed zone can do that, which is why
  // the platform decides here instead of the feed picking somebody's home clock.
  const stamp = Math.floor(Date.parse(event.detected_at) / 1000);
  const time = platform === "discord" ? `<t:${stamp}:f>` : utcStamp(event.detected_at);
  lines.push("", link);
  if (reportBaseUrl && event.stream === "web")
    lines.push(`Full report: ${reportBaseUrl.replace(/\/$/, "")}/reports/${event.id}`);
  lines.push(`Signal Forge · ${time} · #${event.id}`);
  return lines.join("\n");
}
const VENDORS: [RegExp, string][] = [
  [/openai|gpt|codex|chatgpt|sora/i, "OpenAI"],
  [/anthropic|claude/i, "Anthropic"],
  [/google|gemini|deepmind|lyria|imagen|veo/i, "Google"],
  [/x-ai|xai|grok/i, "xAI"],
  [/deepseek/i, "DeepSeek"],
  [/qwen|alibaba/i, "Qwen"],
  [/meta-llama|llama|^meta\//i, "Meta"],
  [/mistral/i, "Mistral"],
  [/moonshot|kimi/i, "Moonshot"],
  [/minimax/i, "MiniMax"],
  [/z-ai|zhipu|glm/i, "Z.ai"],
  [/cohere/i, "Cohere"],
  [/perplexity/i, "Perplexity"],
];

/** The vendor an event is about, for the eyebrow line and later for role pings. */
export function vendorOf(event: Event, record: RecordData | null): string {
  const haystack = [record?.maker, record?.provider, event.entity_id, event.source]
    .filter((value) => typeof value === "string")
    .join(" ");
  return VENDORS.find(([pattern]) => pattern.test(haystack))?.[1] ?? "Unknown";
}

const EYEBROWS: Record<string, string> = {
  "api-models": "MODEL CATALOGUE",
  openrouter: "AVAILABILITY",
  arena: "ARENA",
  leaderboards: "LEADERBOARD",
  news: "OFFICIAL NEWS",
  web: "INTERFACE",
  github: "REPOSITORY",
  weights: "OPEN WEIGHTS",
  packages: "PACKAGE",
};

/** One line saying where the observation came from, so a reader knows how much to trust it. */
const ORIGINS: Record<string, string> = {
  openrouter: "Listing changed on OpenRouter.",
  openai: "Seen in the OpenAI catalogue.",
  anthropic: "Seen in the Anthropic catalogue.",
  gemini: "Seen in the Gemini catalogue.",
  arena: "Spotted on Arena.",
  "arena-leaderboards": "Ranking published on Arena.",
  "openai-news": "Published by OpenAI.",
  "anthropic-news": "Published by Anthropic.",
  "claude-web": "Found in the public Claude bundle.",
  "codex-docs": "Changed in the Codex documentation.",
  "vercel-gateway": "Listed on Vercel AI Gateway.",
  "cursor-changelog": "Published in the Cursor changelog.",
};

const KIND_COLORS: Record<Event["kind"], number> = { new: 0x2ecc71, changed: 0xf1c40f, removed: 0xe74c3c };

/**
 * Discord renders one embed per event: the coloured bar carries the kind, the eyebrow carries what
 * and whose, and the embed's own timestamp is drawn in each reader's timezone. The text renderer
 * stays for Telegram, which has none of that.
 */
export function eventEmbed(event: Event, url: string, reportBaseUrl?: string): Record<string, unknown> {
  const before = event.before_json ? (JSON.parse(event.before_json) as RecordData) : null;
  const after = event.after_json ? (JSON.parse(event.after_json) as RecordData) : null;
  const record = after ?? before;
  const rendered = renderEvent(event, url, undefined, "telegram").split("\n");
  // renderEvent's first line is the kind and source, the last two are link and signature; the
  // middle is the body worth showing, and it is already the filtered, human version.
  const body = rendered.slice(2, -2).join("\n").trim();
  const origin = ORIGINS[event.source] ?? "";
  const description = [origin, body].filter(Boolean).join("\n\n").slice(0, 4000);
  const link =
    typeof record?.url === "string"
      ? record.url
      : event.source === "openrouter"
        ? `https://openrouter.ai/${event.entity_id}`
        : url;

  const embed: Record<string, unknown> = {
    author: { name: `${EYEBROWS[event.stream] ?? "UPDATE"} · ${vendorOf(event, record).toUpperCase()}` },
    title: String(record?.name ?? event.entity_id).slice(0, 250),
    color: KIND_COLORS[event.kind],
    description,
    footer: { text: `Signal Forge · #${event.id}` },
    timestamp: new Date(event.detected_at).toISOString(),
  };
  if (link) embed.url = link;
  if (reportBaseUrl && event.stream === "web")
    embed.fields = [
      { name: "Full report", value: `${reportBaseUrl.replace(/\/$/, "")}/reports/${event.id}`, inline: false },
    ];
  return embed;
}

export function saveCollection(
  db: Database,
  c: Collection,
  destinations: Destination[],
  now = new Date().toISOString(),
  reportBaseUrl?: string,
): number {
  if (!c.records.length && !c.appendOnly) throw new Error(`${c.source}: empty collection rejected`);
  if (new Set(c.records.map((r) => r.id)).size !== c.records.length)
    throw new Error(`${c.source}: duplicate record IDs`);
  return db.transaction(() => {
    const initialized = db.query("SELECT last_success FROM sources WHERE id=?").get(c.source) as {
      last_success: string | null;
    } | null;
    const raw = JSON.stringify(c.raw);
    const latest = db
      .query<{ id: number; raw_json: string }, [string]>(
        "SELECT id,raw_json FROM snapshots WHERE source=? ORDER BY id DESC LIMIT 1",
      )
      .get(c.source);
    const snapshotRow =
      latest?.raw_json === raw
        ? latest
        : db
            .query<{ id: number }, [string, string, string]>(
              "INSERT INTO snapshots(source,collected_at,raw_json) VALUES(?,?,?) RETURNING id",
            )
            .get(c.source, now, raw);
    if (!snapshotRow) throw new Error("Snapshot insert failed");
    const snapshot = snapshotRow.id;
    const old = db
      .query<{ id: string; body: string; missing_count: number }, [string]>(
        "SELECT id,body,missing_count FROM records WHERE source=?",
      )
      .all(c.source);
    const previous = new Map(old.map((r) => [r.id, r]));
    let count = 0;
    const emitted: Event[] = [];
    const emit = (id: string, kind: Event["kind"], before: string | null, after: string | null) => {
      const row = db
        .query<{ id: number }, [string, string, string, string, string | null, string | null, string, number]>(
          "INSERT INTO events(source,stream,entity_id,kind,before_json,after_json,detected_at,snapshot_id) VALUES(?,?,?,?,?,?,?,?) RETURNING id",
        )
        .get(c.source, c.stream, id, kind, before, after, now, snapshot);
      if (!row) throw new Error("Event insert failed");
      const event: Event = {
        id: row.id,
        source: c.source,
        stream: c.stream,
        entity_id: id,
        kind,
        before_json: before,
        after_json: after,
        detected_at: now,
      };
      emitted.push(event);
      count++;
    };
    for (const record of c.records) {
      const body = canonical(record),
        before = previous.get(record.id);
      previous.delete(record.id);
      if (initialized?.last_success && !before && !c.silentIds?.includes(record.id)) emit(record.id, "new", null, body);
      else if (
        initialized?.last_success &&
        before &&
        before.body !== body &&
        (!c.appendOnly || c.trackChanges) &&
        !c.silentIds?.includes(record.id)
      ) {
        if (c.confirmChanges) {
          const candidate = db
            .query<{ body: string; observations: number }, [string, string]>(
              "SELECT body,observations FROM change_candidates WHERE source=? AND id=?",
            )
            .get(c.source, record.id);
          if (candidate?.body === body && candidate.observations >= 1) {
            emit(record.id, "changed", before.body, body);
            db.query("DELETE FROM change_candidates WHERE source=? AND id=?").run(c.source, record.id);
          } else {
            db.query(
              "INSERT INTO change_candidates(source,id,body,observations) VALUES(?,?,?,1) ON CONFLICT(source,id) DO UPDATE SET body=excluded.body,observations=1",
            ).run(c.source, record.id, body);
            continue;
          }
        } else emit(record.id, "changed", before.body, body);
      } else db.query("DELETE FROM change_candidates WHERE source=? AND id=?").run(c.source, record.id);
      db.query(
        "INSERT INTO records(source,id,body) VALUES(?,?,?) ON CONFLICT(source,id) DO UPDATE SET body=excluded.body,missing_count=0",
      ).run(c.source, record.id, body);
    }
    if (!c.appendOnly)
      for (const row of previous.values()) {
        if (row.missing_count >= 1) {
          emit(row.id, "removed", row.body, null);
          db.query("DELETE FROM change_candidates WHERE source=? AND id=?").run(c.source, row.id);
          db.query("DELETE FROM records WHERE source=? AND id=?").run(c.source, row.id);
        } else
          db.query("UPDATE records SET missing_count=missing_count+1 WHERE source=? AND id=?").run(c.source, row.id);
      }
    for (const digest of [false, true]) {
      const events = emitted.filter((e) => isRoutine(e) === digest);
      const targets = destinations.filter((d) => d.streams.some((s) => s === c.stream));
      if (!events.length || !targets.length) continue;
      const readyAt = digest ? (Math.floor(Date.parse(now) / 3_600_000) + 1) * 3_600_000 : Date.parse(now);
      const existing = digest
        ? db
            .query<{ id: number }, [string, number]>(
              "SELECT id FROM batches WHERE source=? AND digest=1 AND ready_at=? AND sealed=0",
            )
            .get(c.source, readyAt)
        : null;
      const batch =
        existing ??
        db
          .query<{ id: number }, [string, number, number]>(
            "INSERT INTO batches(source,digest,ready_at) VALUES(?,?,?) RETURNING id",
          )
          .get(c.source, Number(digest), readyAt);
      if (!batch) throw new Error("Batch insert failed");
      for (const event of events)
        db.query("INSERT INTO batch_events(batch_id,event_id,url) VALUES(?,?,?)").run(batch.id, event.id, c.url);
      for (const d of targets)
        db.query("INSERT OR IGNORE INTO batch_targets(batch_id,destination_id,destination_json) VALUES(?,?,?)").run(
          batch.id,
          d.id,
          JSON.stringify(d),
        );
    }
    prepareDeliveries(db, Date.parse(now), reportBaseUrl);
    db.query(
      "INSERT INTO sources(id,last_success,checked_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET last_success=excluded.last_success,checked_at=excluded.checked_at,last_error=NULL",
    ).run(c.source, now, now);
    // Keep every event's evidence and the two most recent unreferenced observations.
    db.query(
      "DELETE FROM snapshots WHERE source=? AND id NOT IN (SELECT snapshot_id FROM events) AND id NOT IN (SELECT id FROM snapshots WHERE source=? ORDER BY id DESC LIMIT 2)",
    ).run(c.source, c.source);
    return count;
  })();
}

export function isRoutine(event: Event): boolean {
  if (event.source === "claude-web") return true;
  if (event.kind !== "changed") return false;
  // A rank move is real news but not urgent news: it belongs in the hourly digest, not in a ping.
  if (event.stream === "leaderboards") return true;
  if (!["openrouter", "api-models", "arena"].includes(event.stream)) return false;
  const before = JSON.parse(event.before_json ?? "{}") as Record<string, unknown>;
  const after = JSON.parse(event.after_json ?? "{}") as Record<string, unknown>;
  const important = [
    "name",
    "pricing",
    "context",
    "input",
    "output",
    "parameters",
    "capabilities",
    "selectable",
    "inputTokenLimit",
    "outputTokenLimit",
    "methods",
  ];
  return !important.some((key) => canonical(before[key]) !== canonical(after[key]));
}

export function prepareDeliveries(db: Database, now = Date.now(), reportBaseUrl?: string): void {
  db.transaction(() => {
    const batches = db
      .query<{ id: number; digest: number; source: string }, [number]>(
        "SELECT id,digest,source FROM batches WHERE sealed=0 AND ready_at<=? ORDER BY id",
      )
      .all(now);
    for (const batch of batches) {
      const events = db
        .query<Event & { url: string }, [number]>(
          "SELECT e.*,b.url FROM batch_events b JOIN events e ON e.id=b.event_id WHERE b.batch_id=? ORDER BY e.id",
        )
        .all(batch.id);
      const targets = db
        .query<{ destination_id: string; destination_json: string }, [number]>(
          "SELECT destination_id,destination_json FROM batch_targets WHERE batch_id=? ORDER BY rowid",
        )
        .all(batch.id);
      for (const target of targets) {
        const d = JSON.parse(target.destination_json) as Destination;
        const source =
          sourceLabels[batch.source] ??
          batch.source
            .replace("github:", "GitHub · ")
            .replace(":commits", " · commits")
            .replace(":pulls", " · PR")
            .replace(":releases", " · releases");
        const tags = new Set<string>();
        const topics: Record<string, string> = {
          "api-models": "#Models",
          openrouter: "#OpenRouter #Models",
          arena: "#Arena",
          leaderboards: "#Leaderboards",
          news: "#News",
          weights: "#Weights",
          packages: "#Packages",
          web: "#Web",
          github: "#GitHub",
        };
        for (const event of events) for (const tag of (topics[event.stream] ?? "#Updates").split(" ")) tags.add(tag);
        if (batch.source === "codex-docs" || batch.source.startsWith("github:openai/codex:")) tags.add("#Codex");
        if (batch.source === "codex-docs") tags.add("#Docs");
        if (["claude-web", "anthropic", "anthropic-news"].includes(batch.source)) tags.add("#Claude");
        if (batch.source === "openai" || batch.source === "openai-news") tags.add("#OpenAI");
        if (batch.source === "gemini") tags.add("#Gemini");
        if (batch.source.endsWith(":pulls")) tags.add("#PR");
        if (batch.source.endsWith(":releases")) tags.add("#Releases");
        if (batch.digest) tags.add("#Digest");
        const header = `${batch.digest ? "🗞 Hourly digest" : "📡 Updates"} · ${source} · ${events.length}\n${[...tags].join(" ")}\n\n`;
        // Keep each item compact; full before/after evidence remains available by event ID.
        const text = events
          .map((event) => {
            const rendered = renderEvent(event, event.url, reportBaseUrl, d.platform);
            const lines = rendered.split("\n");
            const footer = lines.slice(-2).join("\n");
            const content = lines.slice(1, -2).join("\n").trim();
            const kind = { new: "🆕", changed: "✏️", removed: "🗑️" }[event.kind];
            return `${kind} ${content.length > 800 ? `${content.slice(0, 800)}…` : content}\n${footer}`;
          })
          .join("\n\n────────\n\n");
        const store = (payload: string, part: number) =>
          db
            .query(
              "INSERT INTO deliveries(batch_id,destination_id,destination_json,body,part,updated_at) VALUES(?,?,?,?,?,?)",
            )
            .run(batch.id, target.destination_id, target.destination_json, payload, part, now);

        if (d.platform === "discord") {
          // One embed per event, ten per message — Discord's own limit, and a natural page size.
          const embeds = events.map((event) => eventEmbed(event, event.url, reportBaseUrl));
          for (let index = 0; index * 10 < embeds.length; index += 1) {
            const page = embeds.slice(index * 10, index * 10 + 10);
            store(JSON.stringify({ content: index === 0 ? header.trim() : "", embeds: page }), index);
          }
          continue;
        }
        splitMessage(text, 3900 - header.length).forEach((body, part) => {
          store(header + body, part);
        });
      }
      db.query("UPDATE batches SET sealed=1 WHERE id=?").run(batch.id);
    }
  })();
}
