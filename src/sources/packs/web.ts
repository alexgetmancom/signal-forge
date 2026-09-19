import type { Database } from "bun:sqlite";
import { readLatestSnapshot } from "../../storage/snapshots.js";
import { APP_STORE_APPS, collectAppStore } from "../apps.js";
import { collectClaude } from "../claude.js";
import { collectCodexDocs } from "../codex.js";
import type { SourceContext, SourceEntry } from "../definition.js";
import { collectCohereChangelog } from "../modelDocs.js";
import { collectSitePages, WATCHED_SITES } from "../pages.js";

/** The child sitemaps the last stored read of a site followed, or null when it recorded none. */
function childSitemapsRead(db: Database, source: string): string[] | null {
  const payload = readLatestSnapshot(db, source);
  const children = payload ? (JSON.parse(payload) as { children?: unknown }).children : undefined;
  return Array.isArray(children) ? children.filter((child): child is string => typeof child === "string") : null;
}

/** Watched site pages, app store listings and other pages read as they render. */
export function webSources({ db, cache }: SourceContext): SourceEntry[] {
  return [
    {
      id: "codex-docs",
      authority: "first_party",
      vendor: "OpenAI",
      group: "Web",
      stream: "web",
      intervalSeconds: 3600,
      collector: () => collectCodexDocs(fetch, cache),
    },
    {
      id: "claude-web",
      // Every JavaScript bundle claude.ai loads, about 22 MB a read.
      heavy: true,
      authority: "first_party",
      vendor: "Anthropic",
      group: "Web",
      stream: "web",
      intervalSeconds: 3600,
      collector: () => collectClaude(fetch, cache),
    },
    {
      id: "cohere-changelog",
      authority: "first_party",
      vendor: "Cohere",
      group: "Web",
      stream: "web",
      intervalSeconds: 3600,
      collector: () => collectCohereChangelog(fetch, cache),
    },
    ...WATCHED_SITES.map(
      (site, index): SourceEntry => ({
        id: `pages:${site.id}`,
        authority: "first_party",
        vendor: site.vendor,
        group: "Site pages",
        stream: "pages",
        // One collection reads a site's index and its sections in sequence, so the requests are
        // already paced by the collector itself.
        intervalSeconds: 3600 + index * 300,
        collector: () => collectSitePages(site, fetch, cache, childSitemapsRead(db, `pages:${site.id}`)),
      }),
    ),
    ...APP_STORE_APPS.map(
      (app, index): SourceEntry => ({
        id: `app:ios:${app.id}`,
        authority: "vendor_owned",
        vendor: app.vendor,
        group: "Apps",
        stream: "apps",
        // App Store metadata changes a few times a week per app, and one listing is one request.
        intervalSeconds: 1800 + index * 60,
        pace: { group: "itunes.apple.com", seconds: 10 },
        collector: () => collectAppStore(app, fetch, cache),
      }),
    ),
  ];
}
