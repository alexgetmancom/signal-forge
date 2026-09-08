# Remaining work

| Priority | Task | Dependency / scope |
|---|---|---|
| Next | Alert on prolonged source failures and recovery. | Avoid repeated alerts for the same outage. |
| Blocked | Reach the Gemini catalog from a supported location. | See *Gemini access* below. Running without it for now. |
| Next | Tune notification importance using actual events. | Reduce noise while preserving meaningful model, price and capability changes. |
| Later | Add readable summaries of code and large web diffs. | Choose a model and spending limit; retain raw evidence and distinguish proposals from releases. A message now shows the first eight changed fields and counts the rest; a summary would replace that count with a sentence. |
| Later | Separate Codex-specific documentation updates from shared ChatGPT edits. | Preserve relevant shared changes. |
| Later | Add Codex interface-string monitoring. | Identify a usable public source. |
| Later | Select individual Codex PR authors to follow. | Owner's author shortlist. |
| Later | Correlate related events across sources. | Link PR → merge → documentation → release without merging their statuses. |
| Later | Add Bedrock models and regional availability. | Needs AWS credentials: the Bedrock endpoints are SigV4-signed and answer nothing anonymously, so this is blocked on an account rather than on code. |
| Last | Publish reports on the public site. | Explicitly deferred by the owner: everything else comes first. When it resumes, the shape discussed was a `signal.alexgetman.com` subdomain carrying full diffs, which would also give the Discord embeds a "full report" link they do not have today. |
| Blocked | Reach the Vercel AI Gateway catalogue from VM106. | Measured 2026-09-08: `tw-nl` pulls the full 383 KB listing in 0.09 s, VM106 receives 13-16 KB and then stalls until timeout. The collector and the schema are fine; the home channel cuts the response. The fix is a routing rule sending `ai-gateway.vercel.sh` through a tunnel on `home-101`, which is an OpenWrt change and needs the owner. |
| Deferred | A role for removals. | The owner declined it for now. It would follow models that disappear from a catalogue — the one event a reader running that model in production has to act on today. Worth revisiting if such readers turn up. |
| Owner decision | Vercel AI Gateway routing and the Google catalogue. | The owner is deciding both, 2026-09-09: whether to add the router rule for `ai-gateway.vercel.sh`, and whether Google comes from Vertex AI or from OpenRouter. Nothing to build until then; the measurements are below. |
| Done | Vendor role pings. | Waiting on role IDs from the owner; `vendorOf()` already resolves the vendor of an event. |


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
