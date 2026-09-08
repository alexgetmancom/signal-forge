# Remaining work

| Priority | Task | Dependency / scope |
|---|---|---|
| Next | Alert on prolonged source failures and recovery. | Avoid repeated alerts for the same outage. |
| Blocked | Reach the Gemini catalog from a supported location. | See *Gemini access* below. Running without it for now. |
| When key arrives | Add a GitHub token and verify catch-up under repository activity. | GitHub token. |
| Next | Tune notification importance using actual events. | Reduce noise while preserving meaningful model, price and capability changes. |
| Later | Add readable summaries of code and large web diffs. | Choose a model and spending limit; retain raw evidence and distinguish proposals from releases. |
| Later | Separate Codex-specific documentation updates from shared ChatGPT edits. | Preserve relevant shared changes. |
| Later | Add Codex interface-string monitoring. | Identify a usable public source. |
| Later | Select individual Codex PR authors to follow. | Owner's author shortlist. |
| Later | Correlate related events across sources. | Link PR → merge → documentation → release without merging their statuses. |
| Later | Add DesignArena. | Separate registry collector. |
| Later | Add Bedrock models and regional availability. | Determine access requirements. |
| Deferred | Connect and verify Discord delivery. | Only after Telegram is refined and the owner resumes Discord work. |


| Blocked | Reach the Vercel AI Gateway catalogue from VM106. | Measured 2026-09-08: `tw-nl` pulls the full 383 KB listing in 0.09 s, VM106 receives 13-16 KB and then stalls until timeout. The collector and the schema are fine; the home channel cuts the response. The fix is a routing rule sending `ai-gateway.vercel.sh` through a tunnel on `home-101`, which is an OpenWrt change and needs the owner. |

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

## What to test if this is picked up again

Vertex `publishers/google/models` against a service account, to confirm it answers from a Russian
IP and that the model list is shaped closely enough to keep one collector for both. Do not retest
tunnels — the table above is the answer.
