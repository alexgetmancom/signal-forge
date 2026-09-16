# Roadmap

Updated 2026-09-16 UTC. What is planned, what was decided and why, and nothing else. What is built
is in the code, its tests and [README.md](../README.md); this file
stopped keeping a second copy of that on 2026-09-14, and so did the competitor audit that seeded the
source list -- every one of its recommendations shipped, and what it still proposed is under Ideas.

## Current state

Signal Forge watches AI model catalogues, arenas, open-weight registries, packages, repositories,
documentation, official news and platform health; it keeps immutable before/after evidence, assigns
source-derived confidence, correlates events across sources and delivers only what passes the
notification policy. Production is healthy and the gate passes on `main`; what is left is reading
back what the channels carried.

A hundred and nineteen sources are registered on 2026-09-16: ModelScope left, and the four Artificial
Analysis media arenas arrived. `gemini`, `vercel-gateway` and `artificial-analysis` had never
collected and did that day, once their hostnames were routed through a US exit (settled below). The
one that does not collect is the Kimi coding tier, which waits for a key.

## Next work

Ordered by reader value. Every measurement here is dated, because a priority derived from a number
that has since moved is not a priority.

| Priority | Task | Definition of done |
|---|---|---|
| Next | Read the wire back in a week. | `channel-mix 7`, taken no earlier than 2026-09-23, says what the two channels carried after the routing and filters of 2026-09-16 (`🚀signals`: `launch`; `🕵scouts`: `codename`). Replaying the week to 2026-09-16 19:00 through every delivery filter on a copy of production predicted 3 wire cards and 89 scout cards, of which 49 were site pages the section rules of the same day no longer collect and 2 were ModelScope: about 38. Hugging Face trending was not in that week and adds whatever enters its list. Done when the real numbers are written here with their date, `unrouted` and `shadow` are read per class, and anything that reached the scouts without being a sighting is named with its source. |
| Owner decision | Kimi: a key for the coding tier. | The Moonshot key answers with `kimi-k2.6` and `kimi-k2.7-code` and nothing newer, checked against production 2026-09-14, which is why the K2.8 Preview rollout of 11 September 2026 was invisible here. The coding tier is a separate host with a separate credential: `api.kimi.com/coding/v1/models` answers 401 to a key it does not accept while every neighbouring path answers 404, so the source is registered and correct ahead of the key. Set `KIMI_API_KEY` and it collects; the Kimi Code changelog already ships as its own source. |

## Settled by measurement

Kept because the reasoning cost real observation and is easy to re-litigate from intuition.

- **One public channel, one invited one.** `🚀signals` is public (`launch`),
  `🕵scouts` is invited (`codename`), `📡status` is behind an opt-in role. Read card by card by the
  owner over 2026-09-14 to 2026-09-16: the wire had carried three weight drops nobody can call, one
  outage told three times and a reseller listing worded as a vendor announcement, and the scouts had
  carried 193 arena withdrawals and patch notes for tools nobody subscribed to. So the wire carries a
  model somebody can call, listed in its own maker's catalogue, and the start of an outage the vendor
  graded major; the scouts carry sightings and nothing else; retirements, versions, articles,
  evidence, changes and ranks are collected and delivered nowhere. Retirements were on the wire for
  one afternoon and came off it on the owner's reading of five of them. The classes stay independent of the channels,
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
- **Hugging Face is read as its labs' accounts and its trending list, never as every upload.** The
  upload sweep left 21,562 events in the week to 2026-09-16 and delivered none; 73 of its stories that
  touched another source were all false matches on a base model's name carried by a derivative, and
  its apparent lead time was an artefact of being the only source present. The labs' own accounts
  see a release the hour its weights land. The trending list is the only way to hear about a lab
  nobody follows: on 2026-09-16, 58 of its top 100 declared a base model and more were quantisations
  by name, so copies and anything older than a fortnight are dropped before an event exists, and a
  model a followed lab already published stays quiet. It still correlates only with itself.
- **Written off 2026-09-16, on the owner's call that they are not worth carrying.** ModelScope: two
  first sightings in a week and no lead over any source. MathArena, ARC-AGI, FrontierMath and DeepSWE:
  no data endpoint, and rendered markup is not read. Meta Research, Tencent, IBM Research and MiniMax
  blogs: a parser each against marketing markup, for words the weights already carry. The Google
  product blog beyond its AI feed, the Mistral and ZCode changelogs, Model Studio release notes and
  DeepMind model cards behind rendered pages, `status.x.ai`, Meta's catalogue, Google Labs bundles
  and APK diffing: each needs a way in before a parser, and articles and evidence are routed
  nowhere. More reset sources and a last-reset board: one vendor's resets exist. A human verdict in
  the invited room and shutdown dates for the reminder engine: retirements are off the wire, and
  nobody asked the room to grade.
- **A source-count badge on a card is not worth building.** Of cards that reached a reader, 0% and
  10% had a second independent source at send time, and 18% would have carried a permanently wrong
  count: confirmation arrived a median 8.2 hours after the message was sent, and cards are not
  edited.
- **Three hostnames leave through a US exit.** Measured 2026-09-16 from the production host.
  `generativelanguage.googleapis.com` answered `User location is not supported` through every house
  exit and 200 with 58 models through a US one, with the same key. `ai-gateway.vercel.sh` was never an
  incomplete upstream response: through the house exits the body was cut at 13,037, 16,384 and
  16,384 bytes, through the US exit it arrived whole at 385,136, so no parser was ever at fault.
  `artificialanalysis.ai` refused the connection outright, and through the US exit answers 401
  without a key and 200 with one. The route is configured on the router for the production host and
  those three hostnames only, never in this repository; everything else keeps its exit.
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
- Cloud catalogues read from the vendors themselves (Bedrock, Vertex, Azure AI Foundry) still need
  credentials. Measured 2026-09-15: Foundry has no open catalogue -- `ai.azure.com/api/catalog/models`
  answers with the single-page application, and the Learn page renders its model table from script.
  What changed is that two aggregators publish the same rows without a credential, so the coverage
  arrived without the keys; the first-party reading stays deferred.
- Individual PR authors, more status providers, a public report site, a removals role.
- LLM relevance verification, until at least seven days of deterministic discovery density,
  confirmation rate, first-source wins and lead-time measurements exist.

## Source coverage

Catalogues (OpenRouter, OpenAI, Anthropic, xAI, Moonshot, Mistral, Groq, Z.ai, MiniMax, Alibaba
Model Studio, Cerebras, Artificial Analysis and Kimi, each inert without its own key; Gemini,
Artificial Analysis and the Vercel AI Gateway reached through a US exit). Open weights on Hugging
Face: the labs' own accounts, including `meta-models`, `ibm-granite` and `tencent`, and the trending
list. Arena, Arena leaderboards, DesignArena, the Artificial Analysis image, image-editing, video and
speech arenas, and the three independent boards that publish their own data: VoxelBench, WeirdML
and SimpleBench. OpenRouter usage rankings,
in shadow, as the only measure of what people actually run. npm, PyPI and GitHub activity for
selected AI tools. Official news, release notes and changelogs for OpenAI, Codex, Anthropic, Claude
Code, Gemini, the Google AI blog, DeepMind, xAI, Mistral, Groq, DeepSeek, Kimi Code, Cohere and
Hugging Face. Lifecycle and deprecation pages for OpenAI, Anthropic, Google, AWS, Azure, Groq,
Cohere and xAI. Vendor site pages watched for URLs that appear before the announcement, including
the Claude API reference and help centre. Eleven iOS listings, read for the vendor's own release
notes. Codex usage-limit resets. GitHub discovery, in shadow. Two aggregated
catalogues, in shadow: models.dev, which carries 217 providers as 2291 canonical models, and the
TrueFoundry mirror of the two Azure directories, which is the only sight of a cloud's deployment
version. Both are `third_party`, so a model they show and no vendor does stays `observed`.

A failed or malformed collection is never treated as an empty catalogue, and external responses are
validated before they can change stored state.
