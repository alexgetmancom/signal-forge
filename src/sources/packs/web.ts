import type { Database } from "bun:sqlite";
import { readLatestSnapshot } from "../../storage/snapshots.js";
import { APP_STORE_APPS, collectAppStore } from "../apps.js";
import { collectClaude } from "../claude.js";
import { collectCodexDocs } from "../codex.js";
import type { SourceContext, SourceEntry } from "../definition.js";
import { APT_REPOSITORIES, collectAptRepository, collectClaudeDownloads } from "../desktop.js";
import { type SourceKind, sourcesOfKind } from "../kinds.js";
import { collectCohereChangelog } from "../modelDocs.js";
import { collectSitePages, WATCHED_SITES } from "../pages.js";

/** The child sitemaps the last stored read of a site followed, or null when it recorded none. */
function childSitemapsRead(db: Database, source: string): string[] | null {
  const payload = readLatestSnapshot(db, source);
  const children = payload ? (JSON.parse(payload) as { children?: unknown }).children : undefined;
  return Array.isArray(children) ? children.filter((child): child is string => typeof child === "string") : null;
}

/**
 * A Debian package repository a vendor publishes its desktop client through.
 *
 * A few kilobytes of Debian index. A build reaching it is the release, and `package_release` because
 * a build in a store or a repository is installable, which is the release itself rather than a word
 * about it.
 */
const APT_REPOSITORY: SourceKind = {
  kind: "apt-repository",
  authority: "vendor_owned",
  evidence: "package_release",
  confidence: "confirmed",
  group: "Apps",
  stream: "apps",
  intervalSeconds: 300,
};

/**
 * One App Store listing of a vendor's own application.
 *
 * App Store metadata changes a few times a week per app, and one listing is one request, so the
 * members share the host's budget and each says its own place in the staggering. A build in a store
 * is installable, which is the release itself rather than a word about it.
 */
const IOS_APP: SourceKind = {
  kind: "ios-app",
  authority: "vendor_owned",
  evidence: "package_release",
  confidence: "confirmed",
  group: "Apps",
  stream: "apps",
  intervalSeconds: 1800,
  pace: { group: "itunes.apple.com", seconds: 10 },
};

/**
 * A page or a changelog a maker serves on its own site, read as it renders.
 *
 * It says a name exists on the maker's own site, never that the model is out. Each member used to
 * carry that sentence for itself, three times, which is the repetition a kind is for.
 */
const MAKER_WEB_PAGE: SourceKind = {
  kind: "maker-web-page",
  authority: "first_party",
  evidence: "web_diff",
  confidence: "observed",
  group: "Web",
  stream: "web",
  intervalSeconds: 3600,
};

/**
 * A maker's whole site, read through its sitemap: every page it publishes, collected as it renders.
 *
 * An interface string or an unlinked page on the maker's own site: the name exists, and nothing here
 * says the model can be called. One collection reads a site's index and its sections in sequence, so
 * the requests are already paced by the collector itself, and each member says where it stands in
 * the stagger.
 */
const WATCHED_SITE: SourceKind = {
  kind: "watched-site",
  authority: "first_party",
  evidence: "web_diff",
  confidence: "observed",
  group: "Site pages",
  stream: "pages",
  intervalSeconds: 3600,
};

/**
 * What a reader can install: Debian indexes, the download endpoint and the App Store listings.
 *
 * All vendor-owned and all `package_release`, because a build reaching a store or a repository is
 * the release itself rather than a word about it -- which is the one thing this half shares and the
 * reason it is a declaration of its own rather than the tail of `webSources`.
 */
function installableSources({ cache }: Pick<SourceContext, "cache">): SourceEntry[] {
  return [
    ...sourcesOfKind(
      APT_REPOSITORY,
      APT_REPOSITORIES.map((repository) => ({
        id: repository.source,
        vendor: repository.vendor,
        collector: () => collectAptRepository(repository, fetch),
      })),
    ),
    {
      id: "discovery:claude-downloads",
      appendOnly: true,
      authority: "vendor_owned",
      // The download endpoint answering for a build nobody has announced: the same evidence as any
      // other release register, which is why a name found here is worth what it says.
      evidence: "package_release",
      confidence: "confirmed",
      vendor: "Anthropic",
      group: "Discovery",
      stream: "apps",
      intervalSeconds: 900,
      pace: { group: "downloads.claude.ai", seconds: 5 },
      collector: () => collectClaudeDownloads(fetch),
    },
    ...sourcesOfKind(
      IOS_APP,
      APP_STORE_APPS.map((app, index) => ({
        id: `app:ios:${app.id}`,
        vendor: app.vendor,
        intervalSeconds: 1800 + index * 60,
        collector: () => collectAppStore(app, fetch, cache),
      })),
    ),
  ];
}

/** Watched site pages and other pages read as they render, with the installable builds beside them. */
export function webSources({ db, cache }: SourceContext): SourceEntry[] {
  return [
    ...sourcesOfKind(MAKER_WEB_PAGE, [
      { id: "codex-docs", vendor: "OpenAI", collector: () => collectCodexDocs(fetch, cache) },
      {
        id: "claude-web",
        // Every JavaScript bundle claude.ai loads, about 22 MB a read.
        heavy: true,
        vendor: "Anthropic",
        // Four hours, because an hour is being refused. Measured on production 2026-09-25: 29 of the
        // last 46 reads failed, every one of them a 403 or a challenge page, which is the worst rate
        // of any source here -- and the answer to being challenged is to ask less often, never to
        // look like something else. The bundles carry interface strings that change when a deploy
        // changes them, so nothing here is hourly news; six reads a day of 22 MB is also the largest
        // single share of what this service downloads and stores.
        intervalSeconds: 14400,
        collector: () => collectClaude(fetch, cache),
      },
      {
        id: "cohere-changelog",
        appendOnly: true,
        vendor: "Cohere",
        collector: () => collectCohereChangelog(fetch, cache),
      },
    ]),
    ...sourcesOfKind(
      WATCHED_SITE,
      WATCHED_SITES.map((site, index) => ({
        id: `pages:${site.id}`,
        vendor: site.vendor,
        ...(site.heavy ? { heavy: true } : {}),
        intervalSeconds: 3600 + index * 300,
        collector: () => collectSitePages(site, fetch, cache, childSitemapsRead(db, `pages:${site.id}`)),
      })),
    ),
    ...installableSources({ cache }),
  ];
}
