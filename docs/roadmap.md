# Roadmap

Updated 2026-09-14 UTC. What is planned, what was decided and why, and nothing else. What is built
is in the code, its tests, [README.md](../README.md) and [docs/discord.md](discord.md); this file
stopped keeping a second copy of that on 2026-09-14, and so did the competitor audit that seeded the
source list -- every one of its recommendations shipped, and what it still proposed is under Ideas.

## Current state

Signal Forge watches AI model catalogues, arenas, open-weight registries, packages, repositories,
documentation, official news and platform health; it keeps immutable before/after evidence, assigns
source-derived confidence, correlates events across sources and delivers only what passes the
notification policy. Production is healthy, the gate passes on `main`, and there are no known
actionable defects.

A hundred and eleven sources are registered, twenty-three of them added on 2026-09-14 after reading
what four competing feeds carry. Two fail persistently, both blocked upstream rather than broken
here: `gemini` (location) and `vercel-gateway` (incomplete response); each is an owner decision
below. `status:anthropic` recovered on its own after the bot protection let go, checked 2026-09-14.

## Next work

Ordered by reader value. Every measurement here is dated, because a priority derived from a number
that has since moved is not a priority.

| Priority | Task | Definition of done |
|---|---|---|
| Next | Read the wire back in a week. | `channel_mix 7`, taken no earlier than 2026-09-21, says what the two channels carried after the routing changed: volume per class, the lead-time share, and whether the invited room ever promoted anything. Done when the numbers are written here with their date, and `change` is either returned to `🚀signals` or left in `🕵scouts` on that evidence. The window must start after 2026-09-14: until that day 8,948 of the 9,720 events in the `change` class were the Mistral and Moonshot timestamp defect below, so a reading taken over it answers about a bug rather than about the channel. |
| Owner decision | Kimi: a key for the coding tier. | The Moonshot key answers with `kimi-k2.6` and `kimi-k2.7-code` and nothing newer, checked against production 2026-09-14, which is why the K2.8 Preview rollout of 11 September 2026 was invisible here. The coding tier is a separate host with a separate credential: `api.kimi.com/coding/v1/models` answers 401 to a key it does not accept while every neighbouring path answers 404, so the source is registered and correct ahead of the key. Set `KIMI_API_KEY` and it collects; the Kimi Code changelog already ships as its own source. |
| Owner decision | Google catalogue. | `gemini` has never succeeded, and the reason is geography, established 2026-09-13 from the production container: `generativelanguage.googleapis.com` answers `FAILED_PRECONDITION`, `User location is not supported`. An invalid key returns `API key not valid` instead, so only a real key reveals the refusal. Google reports `RU` through all four house exits, including two that geolocate to Germany. Choose: Vertex AI with a billed service account, an exit Google reads as outside Russia, or accept OpenRouter as the Google source. |
| Owner decision | Vercel AI Gateway. | Has never succeeded. Decide whether the incomplete upstream response is worth another parser or the source should be removed. |
| Later | A human verdict from the invited room. | A stealth model on an arena cannot be called by API, so no benchmark of ours reaches it -- the scouts can, by hand. A codename card carrying a prompt kit chosen from the arena's own modality flags, and a reaction rubric the promotion worker tallies, makes the room the evaluation. The verdict travels with the reveal, which already links back to the sighting. Gives two measurements nobody else has: which source produces signals people confirm, and which scout is right most often. |
| Later | Shutdown dates that reach the reminder engine. | The reminder engine, `lifecycle_deadlines` and idempotent 30/7/1-day reminders exist; the extraction does not. `parseOpenAIDeprecations()` keeps the prose and extracts no shutdown or replacement field, and the `lifecycle.ts` fallback reads ISO dates, not `October 1, 2026`. Event 9163 announced the GPT-5.4-Cyber shutdown in `summary` alone. Done when announcement, deprecation and shutdown dates are told apart from the source's own structure, an ambiguous notice stays unprojected rather than guessed, stored records are migrated in the same move, and event 9163 yields the right date and successor. Capped in value because deprecations are scouts' material. |
| Later | The six leaderboards that will not answer in data. | MathArena, ARC-AGI 2 and 3, Epoch FrontierMath, DeepSWE and the Artificial Analysis image and video arenas all render their tables from JavaScript, checked 2026-09-14; no static JSON, CSV or feed was found behind any of them. VoxelBench, WeirdML and SimpleBench shipped because they publish the data their pages draw from. Done when each remaining board is either read from a data endpoint or written off in one line here; parsing rendered markup is not an option, because it reports a style change as a ranking move. |
| Later | Four vendor blogs with no feed. | Meta Research, Tencent, IBM Research and MiniMax announce releases on pages with no RSS or Atom -- eight candidate addresses checked 2026-09-14, none served a feed -- so each needs its own HTML parser against corporate marketing markup, the most fragile shape of source here. Meta and Tencent weights already arrive through `huggingface:meta-models` and `huggingface:tencent`, which covers the release itself; these would add the vendor's own words. |
| Later | Changelogs behind rendered pages. | `docs.mistral.ai/resources/changelogs` (1.4 MB of HTML, distinct from the release notes already collected), the ZCode changelog where GLM-5.3 and GLM-5.3-Flash are documented but absent from the Z.ai `/models` catalogue, Alibaba Model Studio release notes beside the `dashscope` catalogue, and the DeepMind model cards. The ZCode case is the one worth having: documentation exposing a model the API does not list yet, which must never be reported as API availability without the catalogue confirming it. |
| Later | The Google product blog in full. | `blog.google` is covered through the AI topic feed. Its English sitemap lists 11,617 pages grouped by section rather than by date, measured 2026-09-14, so the 4,000-page cap in `pages.ts` would silently drop whichever section sorts last; the other topic feeds are the way in, one per topic, not a raised cap. |
| Later | Surfaces that need a way in, not a parser. | `status.x.ai` refuses its own API with 403 and renders in the browser. Meta's model catalogue has no public endpoint. Google Labs publishes its unreleased product strings in a web bundle the way `claude.ai` does, and the same technique reads it. Android release diffing -- unpacking an APK and comparing `strings.xml` between versions -- is how a competitor saw Perplexity's wake word and Qwen's Projects weeks early; it is a subsystem, not a source. |
| Later | More reset sources, and an evidence type for them. | Z.ai, xAI and Meta reset surfaces, each as its own source with its own authority, never merged into the Codex tracker's family. `events.evidence_type` carries a CHECK constraint, so `reset` needs a rebuild of a table a dozen others reference; until that is worth one move, resets store `unknown` and say what they are in the card's own words. |
| Later | A last-reset board. | One status message, edited in place, naming when each tracked vendor last reset usage limits. Worth building when a second vendor's resets are collected; with one row it is a card that already exists. |
| Later | ModelScope verdict. | Keep or remove on measured lead time, once `lead-time 7` has a full week of it behind it. It has produced no first sighting worth a card so far. |

## Settled by measurement

Kept because the reasoning cost real observation and is easy to re-litigate from intuition.

- **One public channel, one invited one.** `🚀signals` is public (`launch`), `🕵scouts` is invited
  (`codename`, `release`, `article`, `evidence`, `change`, `rank`), `📡status` is behind an opt-in
  role. An audience arrives for models, so the public wire carries models; everything early or small
  goes to a room of readers who came for exactly that. The classes stay independent of the channels,
  because routing is a line in `signal-forge.json` and reversing a channel decision must never need
  a deployment.
- **`launch` and `codename` stay separate classes.** Merging them was proposed and rejected: the
  ping is the same but the trust is not, and a reader who came for released models does not want
  arena sightings arriving with the same weight. Lumina keeps them apart for the same reason.
  Competitors split by source instead (`api-models`, `arena`, `subpages`); with thirteen streams
  that is a dozen channels, and it defeats the cross-source story grouping they do not have.
- **A `created` that equals the time of the answer is not collected.** Mistral fills OpenAI's
  `created` with when it answered -- one identical value for all 46 models, equal to the collection
  time to the second -- and Moonshot returns one shared value that drifts a couple of seconds an
  hour. Measured on production 2026-09-14: those two produced 8,996 change events in six days,
  100% of them `created`-only, while every other provider catalogue produced none at all and
  spreads real per-model dates across years. It also wrote the time of the last poll into
  `releaseDate` in Model Facts, which is a wrong fact about a real model. The field is declared per
  provider, not sniffed: a timestamp near collection time is exactly what a model released minutes
  ago looks like, so a threshold would throw away the launch it exists to catch.
- **Rank confidence bounds are positions, not metrics.** `dynamicMetrics()` sweeps every numeric
  field a board did not name, which is how price and context length arrive without a parser change;
  it also carried `rankLower`, `rankUpper` and `rankStyleControl` back in behind the decision below.
  188 of 877 change events on `arena-leaderboards` in the week to 2026-09-14 were nothing but those
  bounds shifting, and neither `RANKED_PLACES` nor the interval-overlap test saw them, because both
  read `rank` and `score`.
- **A leaderboard position is not stored, only the score.** A board reorders whenever anyone below
  moves, so a stored rank emits a change for every model each time one of them is measured. The
  score is the reading and the rank follows from it.
- **A newsroom post is never a launch.** Measured 2026-09-13 across 1192 OpenAI items: `category` is
  present on 1031, and `Product` (163) and `Release` (7) are cleanly releases, so parsing it would
  have worked. It was not needed -- a model a reader can use appears in the vendor catalogue, so the
  post is commentary -- and Anthropic could not have been fixed that way at all: nine of its ten
  visible posts carry the subject "Announcements", including a board appointment.
- **The scouts grade what a machine cannot.** Source-derived confidence answers "can this be
  trusted" and cannot answer "is this worth a stranger's attention", which is the whole question an
  early sighting raises. Reactions are polled over REST rather than listened for on a gateway
  socket, which keeps the outbound-only boundary intact for one request a cycle.
- **Shadow discovery stays in the shadow.** `discovery:huggingface-recent` produced 7,723 stories in
  seven days; 73 were touched by another source and all 73 were false matches on a base model's name
  carried by a third-party derivative. Its apparent lead time was an artefact of being the only
  source present.
- **A source-count badge on a card is not worth building.** Of cards that reached a reader, 0% and
  10% had a second independent source at send time, and 18% would have carried a permanently wrong
  count: confirmation arrived a median 8.2 hours after the message was sent, and cards are not
  edited.
- **Site pages are not early warning.** `pages:openai` leads by 0.1 hours -- the page appears when
  everyone else sees it. Packages lead by 17.9 hours and are worth their enrichment.
- **The story correlation fallback is ordered by position, not by recency.** Indexing the search by
  `lastTime` looks like the obvious optimisation and is a behaviour change: measured 2026-09-13 on a
  copy of production, the fallback matched 151 times over 11,485 events and 22 would have landed in
  a different story. Recency merged `claude sonnet 4 6` into `claude sonnet 5` and
  `gemini 3 pro image preview` into `gemini 3 7 flash`, because a busy story always has the newest
  last event. Position order keeps distinct models apart.
- **dependency-cruiser cannot be installed here.** Its graph builder needs the TypeScript compiler
  API at `>=2 <7`; this repository is on TypeScript 7, whose package ships a Go binary and no JS API
  -- pointed at `src/`, it cruised 0 modules and said so. `scripts/check-architecture.ts` reads the
  same rules file, and the day dependency-cruiser supports TypeScript 7 the rules move across
  untouched.
- **The Codex tracker's forecast stays out of the records.** The reset announcements are the words of
  the engineer who runs Codex and are what that source is for; the tracker's own AI-classified watch
  forecast and its scheduled reset are neither, and its documentation says neither implies a reset
  happened. Retained as evidence, never delivered, nothing to measure.
- **The documentation set is closed at five files, enforced by `check-docs`.** Prose multiplies on
  its own: every session that learns something wants a file to put it in, and this repository had
  2203 lines across eight files, of which a 1022-line competitor audit and a sixty-bullet list of
  completed work described the past. A new file now fails the gate with the question of which
  existing file the content belongs in.
- **No welcome channel.** The channel map lives in each channel's Discord topic, where a reader
  already looks, and costs no sixth entry in the sidebar.

## Ideas

Not scheduled. Written down so they stop being re-derived from scratch.

- **Incident cards edited in place across stages**, the way the status boards already edit one
  message rather than growing a log.
- **A daily summary of the changes too small to speak.** The parts exist -- digests, thresholds,
  oscillation filtering, comparison against the last reader-visible baseline -- and must not be
  reimplemented; what is missing is a `batches.kind` member with a period-and-destination identity.
  No second sender, no independent cron, no universal top-five ranking.
- **Regional lifecycle schedules.** A deprecation with different dates per region is stored as one
  record with one date, which understates the ones that matter most.
- **`selectable: false -> true` in an API catalogue as a codename** rather than a change. No
  production history for it: all six observed transitions to 2026-09-12 were Arena events.
- **Hugging Face model-card metadata** and **Hacker News** (digest-only, never sufficient for
  `confirmed`) -- the last two things the 2026-09-09 competitor audit proposed and this never built.
- **A second Cohere reading with dates.** Its changelog arrives as an index with no publication
  dates, so it is `web` evidence; the per-entry Markdown carries the date at the cost of one request
  each. Worth it only if a Cohere release ever needs to be dated to the day.

## Deferred

- Telegram delivery is implemented and tested; no destination is configured, because the audience is
  on Discord.
- Cloud catalogues (Bedrock, Vertex, Azure AI Foundry) need credentials and a clear reader need.
- Individual PR authors, more status providers, a public report site, a removals role.
- LLM relevance verification, until at least seven days of deterministic discovery density,
  confirmation rate, first-source wins and lead-time measurements exist.

## Source coverage

Catalogues (OpenRouter, OpenAI, Anthropic, xAI, Moonshot, Mistral, Groq, Z.ai, MiniMax, Alibaba
Model Studio, Cerebras, Artificial Analysis and Kimi, each inert without its own key; Gemini blocked
upstream). Open weights on Hugging Face, including the `meta-models`, `ibm-granite` and `tencent`
organisations, and on ModelScope. Arena, Arena leaderboards, DesignArena, and the three independent
boards that publish their own data: VoxelBench, WeirdML and SimpleBench. OpenRouter usage rankings,
in shadow, as the only measure of what people actually run. npm, PyPI and GitHub activity for
selected AI tools. Official news, release notes and changelogs for OpenAI, Codex, Anthropic, Claude
Code, Gemini, the Google AI blog, DeepMind, xAI, Mistral, Groq, DeepSeek, Kimi Code, Cohere and
Hugging Face. Lifecycle and deprecation pages for OpenAI, Anthropic, Google, AWS, Azure, Groq,
Cohere and xAI. Vendor site pages watched for URLs that appear before the announcement, including
the Claude API reference and help centre. Eleven iOS listings, read for the vendor's own release
notes. Codex usage-limit resets. GitHub and Hugging Face discovery, both in shadow.

A failed or malformed collection is never treated as an empty catalogue, and external responses are
validated before they can change stored state.
