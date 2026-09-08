# Remaining work

Ordered by what would help a reader most, not by effort.

| Priority | Task | Dependency / scope |
|---|---|---|
| Next | A channel for incidents. | The platform board shows the current state, but an outage that starts and clears between two glances at the board is invisible. Incident events are already collected and stored; they have no destination until the owner names a channel. |
| Next | Deprecation notices. | `platform.openai.com/docs/deprecations` and the equivalents. The one event a reader must act on by a date; the natural companion to a removals role. |
| Next | More repositories. | Only `openai/codex` is watched. `anthropics/claude-code`, `google-gemini/gemini-cli` and the SDKs are one config entry each. |
| Next | Tune notification importance against real events. | 72 events so far, 55% of them from OpenRouter. Enough traffic to see which changes readers ignore. |
| Owner decision | Vercel AI Gateway routing and the Google catalogue. | Whether to add the router rule for `ai-gateway.vercel.sh`, and whether Google comes from Vertex AI or from OpenRouter. Measurements below. |
| Later | Readable summaries of large diffs. | A message now shows the first eight changed fields and counts the rest. A sentence instead of a count needs a model and a spending limit. |
| Later | Confidence labels. | A string in a bundle is not a release. Marking observations as seen / confirmed / shipped protects trust in the feed; one false certainty costs more than ten missed scoops. |
| Later | An onboarding channel. | A reader arriving now lands in a stream with no map of which channel holds what, or how to take a role. |
| Later | Slash commands over our own history. | `/latest openai`, `/search gpt-6`. The database already answers these; only Discord does not. |
| Later | Correlate related events. | PR → merge → documentation → release currently arrive as separate messages. Nobody else does this, which is the argument for doing it. |
| Later | Cloud catalogues: Bedrock, Vertex, Azure AI Foundry. | "Available on Bedrock" is its own news for corporate readers. Bedrock needs AWS credentials; its endpoints are SigV4-signed and answer nothing anonymously. |
| Later | Mobile app releases. | App Store versions of the ChatGPT and Claude apps; release notes often name a feature days before the blog. |
| Later | Separate Codex documentation changes from shared ChatGPT edits. | Preserve relevant shared changes. |
| Later | Codex interface strings. | Needs a usable public source. |
| Later | Individual Codex PR authors. | Owner's shortlist. |
| Later | xAI status. | `status.x.ai` returns 403 on its own API and renders in the browser; Google publishes a different shape for the whole cloud. Both need their own parser. |
| Deferred | A role for removals. | Declined for now. It would follow models that disappear from a catalogue — the one event a reader running that model in production has to act on today. Worth revisiting if such readers turn up. |
| Deferred | Telegram delivery. | Implemented and tested, no destination configured. The audience is on Discord; re-enabling costs one config entry, which is why the code stays. |
| Last | Publish reports on the public site. | Explicitly deferred by the owner: everything else comes first. The shape discussed was a `signal.alexgetman.com` subdomain carrying full diffs, which would also give the embeds a "full report" link they do not have today. |

## Not open any more

- Alerting on collector outages and recovery — built, and it caught a real failure (`cursor-changelog`
  emitting duplicate IDs) six minutes after being switched on.
- Vendor role pings, the HTTP cache, the GitHub credential, embeds, rank moves, codename
  resolution, and the registry sources.
- Backups run: `signal-forge-backup.timer` is scheduled and `backups/` holds verified copies.

# Platform health

Two vendors run Statuspage and expose `api/v2/summary.json`: OpenAI, and Anthropic — whose status
host redirects to `status.claude.com`, a different origin, which the fetcher refuses on purpose, so
the final address is used directly. Mistral answers that path with an HTML 404 page and 200, which
is why a schema failure there is a wrong URL rather than an outage.

The document carries both halves at once. The headline feeds the board and produces no events, so a
flapping description cannot manufacture news. The open incidents are records, tracked for changes,
so `investigating → identified → monitoring → resolved` reads as one story rather than four
unrelated messages. They are append-only: an incident leaving the summary has been resolved, not
deleted.

Polled every two minutes — far more often than anything else here — because health is the one thing
a reader may need within minutes. The documents are ~2 KB.

# Request footprint

Everything is collected from the owner's home connection, which is not a choice: the datacentre
exits are refused. Measured 2026-09-08 with the same request from both:

| Address | `chatgpt.com` | `auth.openai.com` | `learn.chatgpt.com` | `claude.ai` |
|---|---|---|---|---|
| Home | 200 | 200 | 200 | 302 (normal) |
| Timeweb NL | 403 | 403 | 403 | 403 |

So the home address is the working one and worth protecting. Before caching, an observation cost
608 requests and 21 MB to `claude.ai` alone, hourly — around 20,000 requests and 0.8 GB a day.

Bytes below are wire bytes. The client sends `Accept-Encoding: gzip, deflate, br, zstd` (verified,
not assumed), so a 13 MB registry document costs 1.2 MB in transit; an earlier note quoting
decompressed sizes overstated the traffic by roughly ten times.

The HTTP cache (`http_cache`, `src/storage/httpCache.ts`) fixes the large half:

- Claude's assets are served `immutable` with a content hash in the filename, so the same URL can
  never hold different bytes. They are read once and then not requested at all until a rebuild
  renames them: **608 requests and 21.4 MB became 2 requests and 0.1 MB**.
- Anything with an ETag is revalidated instead of re-downloaded.
- `learn.chatgpt.com` is the exception: it returns no validator on GET, and its ETag on HEAD comes
  and goes with the edge cache. A HEAD probe was implemented, measured (298 requests instead of 149,
  no 304s) and removed. Those 148 pages are re-read in full every hour, which is deliberate — the
  documentation is where a feature shows up first, and 1.2 MB is a fair price.

- npm was the quiet hog: the full registry document for `@openai/codex` is 13.6 MB uncompressed,
  1.2 MB on the wire, and it was pulled every 15 minutes. It carries an ETag, so a revalidation now
  costs **0 bytes** — measured. The same holds for pypi (0.64 MB) and Hugging Face.
- A body arriving without a validator is deliberately **not** stored: the next observation
  downloads it again regardless, so a copy would be weight with no saving. That covers
  `openrouter`, `arena`, the RSS feeds and `learn.chatgpt.com`.

- GitHub answers conditionally too, and there the saving is the quota rather than the bytes: a 304
  does **not** count against the hourly limit (measured — three conditional requests in a row left
  `x-ratelimit-remaining` at 4989). Only the listing calls are cached; a commit or a release never
  changes once read, so caching a detail would store bytes nobody asks for twice.

Where it stands after all of it, per day, on the wire:

| Source | Requests | Traffic |
|---|---|---|
| arena (+ leaderboards) | 336 | 26 MB |
| openrouter | 288 | 21 MB |
| modelscope, 5 organisations | 240 | 20 MB |
| news feeds, 2 | 192 | 19 MB |
| codex-docs, 148 pages hourly | 3576 | 7 MB |
| everything answering 304 (npm, pypi, HF, GitHub, Claude assets) | ~1400 | <1 MB |
| **Total** | **~6900** | **~95 MB** |

What is left has no cheap fix. Nothing above offers a validator, so the only remaining levers are
polling less often or watching less — both product decisions, not engineering ones. The one idea
worth revisiting is backing off a source that has been quiet for hours and resetting it on the
first event, which would cut the request count roughly in half at the cost of some minutes of
delay on a release that lands during a quiet stretch.

Only `immutable` is trusted for reuse without asking. A plain `max-age` on a page we watch for
changes would hide the change this project exists to report.

# Gemini access

The `gemini` source returns HTTP 400 `User location is not supported for the API use.` and is the
one failing source in `status`. Everything else collects normally.

## What was measured, 2026-09-08

Every egress this project can reach was tested with the real key against
`generativelanguage.googleapis.com/v1beta/models`:

| Exit | Where it lands | Result |
|---|---|---|
| Home WAN | RU residential | 400 |
| `awg1`, `awg3` | Timeweb, NL | 400 |
| `awg2` | VDSka hosting, DE | 400 |
| Cloudflare WARP on `tw-nl` | Cloudflare, AMS | 400 |
| `tw-nl` itself | Timeweb, NL | 400 |

Germany and the Netherlands are supported countries and were refused anyway, so the check is not
about the country. Google refuses the hosting and VPN ranges themselves. **No tunnel fixes this**,
and looking for a better exit is wasted work — that is the point of writing this down.

## The two real options

**Vertex AI.** The same models behind the Cloud entrance: `*-aiplatform.googleapis.com`, authorized
by a service account rather than a key in the URL. Because the caller is a billed identity, there is
no location check at all — that is the whole difference that matters here. It costs a GCP project
with billing, a service account, OAuth token refresh in the collector, and a region in the URL. A
lot of setup for what this project actually wants from Google, which is one `models.list` call.

**Take Google models from OpenRouter,** which is already collected and needs nothing. The cost is
latency: OpenRouter lists a new Google model some time after Google does, and for a newsroom that
delay may or may not matter. That is a product call, not a technical one.

## What Vertex would cost to set up

Owner-side, and none of it is code this project can do on its own:

1. A Google Cloud project with billing enabled.
2. The Vertex AI API enabled in that project.
3. A service account with `roles/aiplatform.user`, and its JSON key handed to the service.
4. A region in the URL, e.g. `us-central1-aiplatform.googleapis.com`.

Service-side, once those exist: OAuth token minting and refresh from the key, and a parser for
`publishers/google/models`, whose shape differs from the Gemini API's `models.list`.

## How this reads in public

The status board says only that the upstream is not serving the feed to us. That is accurate and
deliberately says nothing about where the service runs or what it routes through — subscriber-facing
copy never describes the operator's network. The measurements stay here.

## What to test if this is picked up again

Vertex `publishers/google/models` against a service account, to confirm it answers from a Russian
IP and that the model list is shaped closely enough to keep one collector for both. Do not retest
tunnels — the table above is the answer.
