import type { Collection, RecordData } from "../events/types.js";
import type { Fetch } from "../http-client.js";

/**
 * The desktop clients, read from the package repositories their vendors actually publish.
 *
 * Both download pages refuse a robot -- `claude.ai/api/desktop/...` and `chatgpt.com/download`
 * answer 403 -- and neither is touched. Neither has to be: each vendor ships the same application
 * to Linux through an ordinary Debian repository, open and unauthenticated, whose index is a few
 * kilobytes and names every version ever published.
 *
 * `downloads.claude.ai/claude-desktop/apt/stable` carried 46 versions of `claude-desktop` on
 * 2026-09-24, at 2.7032.0. `persistent.oaistatic.com/codex-app-prod/linux/deb` carried `chatgpt`
 * at 26.917.71314 -- the application the Codex desktop users run. The index is the release: a
 * version appearing in it is a build the vendor has shipped, seen within minutes of the repository
 * being rebuilt, for one small request.
 *
 * The packages themselves are not downloaded, and both were unpacked by hand on 2026-09-24 to find
 * out whether they should be. Claude Desktop 2.7032.0 stopped at `claude-opus-5` while
 * `claude-opus-5-5` had been out two days. The ChatGPT package does carry a catalogue -- 420 MB of
 * it, naming `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-6-astra` and `gpt-5.3-codex` --
 * and every one of those names was already in this database, the oldest of them since 2026-09-11.
 * So the clients are behind the API rather than ahead of it, and 600 MB per version bump buys a
 * worse answer than the catalogues give for nothing. What is worth having is the build, and the
 * build is in the index.
 */
type AptRepository = {
  source: string;
  vendor: string;
  /** The Debian package name, which is also the application. */
  package: string;
  name: string;
  base: string;
  page: string;
};

export const APT_REPOSITORIES: readonly AptRepository[] = [
  {
    source: "claude-desktop-apt",
    vendor: "Anthropic",
    package: "claude-desktop",
    name: "Claude Desktop",
    base: "https://downloads.claude.ai/claude-desktop/apt/stable",
    page: "https://claude.com/download",
  },
  {
    source: "chatgpt-desktop-apt",
    vendor: "OpenAI",
    package: "chatgpt",
    name: "ChatGPT Desktop",
    base: "https://persistent.oaistatic.com/codex-app-prod/linux/deb",
    page: "https://chatgpt.com/download",
  },
];

/** A Debian index is stanzas of `Field: value`, one stanza per package version. */
function stanzas(index: string): Record<string, string>[] {
  return index
    .split(/\n\s*\n/)
    .map((block) => {
      const fields: Record<string, string> = {};
      for (const [, key, value] of block.matchAll(/^([A-Za-z-]+):[ \t]*(.*)$/gm)) if (key) fields[key] = value ?? "";
      return fields;
    })
    .filter((fields) => fields.Package && fields.Version);
}

/**
 * Debian orders versions by its own rules, and these two publish plain dotted numbers
 * (`2.7032.0`, `26.917.71314`), so the newest is the one whose numbers are highest.
 */
function newest(versions: readonly string[]): string | undefined {
  return [...versions]
    .sort((left, right) => {
      const a = left.split(".").map(Number);
      const b = right.split(".").map(Number);
      for (let index = 0; index < Math.max(a.length, b.length); index++) {
        const difference = (a[index] ?? 0) - (b[index] ?? 0);
        if (difference) return difference;
      }
      return 0;
    })
    .at(-1);
}

export async function collectAptRepository(repository: AptRepository, request: Fetch = fetch): Promise<Collection> {
  const url = `${repository.base}/dists/stable/main/binary-amd64/Packages`;
  const response = await request(url);
  if (!response.ok) throw new Error(`${repository.source}: HTTP ${response.status}`);
  const index = await response.text();
  const published = stanzas(index).filter((fields) => fields.Package === repository.package);
  if (!published.length) throw new Error(`${repository.source}: the index names no ${repository.package}`);
  const version = newest(published.map((fields) => fields.Version ?? ""));
  const current = published.find((fields) => fields.Version === version);
  const record: RecordData = {
    id: repository.package,
    name: repository.name,
    maker: repository.vendor,
    version: version ?? "",
    versions: published.length,
    bytes: Number(current?.Size ?? "0") || null,
    url: repository.page,
  };
  return {
    source: repository.source,
    stream: "apps",
    url: repository.page,
    raw: { version, versions: published.length },
    records: [record],
  };
}

/**
 * The products Anthropic has a download for.
 *
 * Claude Science was found this way: `downloads.claude.ai/claude-science/latest/manifest.json`
 * answers with a version and a build date, and a product that does not exist answers 404 at the
 * same address. Science itself turned out to be worth nothing to a reader here -- a niche client
 * whose model list trails the API -- but the address is worth asking, because the next slug to
 * answer is a desktop application Anthropic has built and not announced.
 */
const CLAUDE_PRODUCTS = [
  "claude-science",
  "claude-desktop",
  "claude-code",
  "claude-cowork",
  "claude-research",
  "claude-agent",
  "claude-labs",
  "claude-studio",
  "claude-notebook",
] as const;

const manifestVersion = /"version"\s*:\s*"([^"]{1,64})"/;

export async function collectClaudeDownloads(request: Fetch = fetch): Promise<Collection> {
  const records: RecordData[] = [];
  const tried: Record<string, number> = {};
  for (const product of CLAUDE_PRODUCTS) {
    const url = `https://downloads.claude.ai/${product}/latest/manifest.json`;
    const response = await request(url).catch(() => null);
    if (!response) continue;
    tried[product] = response.status;
    if (!response.ok) {
      await response.body?.cancel();
      continue;
    }
    const version = manifestVersion.exec(await response.text())?.[1];
    if (!version) continue;
    records.push({ id: product, name: product, maker: "Anthropic", version, url: "https://claude.com/download" });
  }
  if (!records.length) throw new Error("no Anthropic download manifest answered, not even Claude Science");
  return {
    source: "discovery:claude-downloads",
    stream: "apps",
    url: "https://downloads.claude.ai",
    raw: tried,
    appendOnly: true,
    records,
  };
}
