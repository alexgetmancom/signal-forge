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
| Deferred | Vendor role pings. | Waiting on role IDs from the owner; `vendorOf()` already resolves the vendor of an event. |


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
