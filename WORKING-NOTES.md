# Remaining work

| Priority | Task | Dependency / scope |
|---|---|---|
| Next | Alert on prolonged source failures and recovery. | Avoid repeated alerts for the same outage. |
| Blocked | Reach the Gemini API from a supported location. | Not a routing problem: every exit available here is refused. Tested 2026-09-08 — home WAN, awg1/awg3 (Timeweb NL), awg2 (VDSka DE), Cloudflare WARP (AMS) all return `User location is not supported`. Google rejects the hosting ASN, not the country, so no tunnel this project controls can fix it. The way out is Vertex AI with a service account, which carries no such check, or dropping the catalog and taking Google model data from OpenRouter. Needs an owner decision. |
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
