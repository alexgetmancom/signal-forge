# Roadmap

Updated 2026-09-20 UTC. What is planned, what was decided and why, and nothing else. What is built is
in the code, its tests and [README.md](../README.md); this file stopped keeping a second copy of that
on 2026-09-14, and so did the competitor audit that seeded the source list -- all of its
recommendations shipped, and what it still proposed is under Ideas.

## Current state

Signal Forge watches AI model catalogues, arenas, open-weight registries, packages, repositories,
documentation, official news and platform health; it keeps immutable before/after evidence, assigns
source-derived confidence, correlates events across sources and delivers only what passes the
notification policy. Production is healthy and the gate passes on `main`; what is left is reading
back what the channels carried.

A hundred and twenty-one sources are registered on 2026-09-20: the four Artificial Analysis media
arenas and Hacker News arrived on 2026-09-17, ModelScope left, StepFun joined on 2026-09-20, and the
one that does not collect is the Kimi coding tier, which waits for a key.

## Next work

Ordered by reader value. Every measurement here is dated, because a priority derived from a number
that has since moved is not a priority.

| Priority | Task | Definition of done |
|---|---|---|
| Next | Read `news` back in a week. | `channel-mix 7`, taken no earlier than 2026-09-24, says what the two channels carried after the widening of 2026-09-17 (`news`: `launch`, `change`, `release`, `retirement`, `feature`, `debut`, `safety`, `research`; `radar`: `codename`). Done when the real numbers per class are written here with their date, and every class or source that produced cards the owner calls noise is taken off `news` with its count. |
| Next | Judge the sources a month in. | `source-verdicts 30`, first taken no earlier than 2026-10-17 so the trending list, the media arenas and Hacker News have a whole period behind them. It names every enabled source that over thirty days led no other source, reached no reader and drew no reader vote. Done when each one named is removed or kept with a one-line reason here, and the date of the next reading is written in its place. |
| Next | Read the corroboration threshold back. | Three unrelated sources on a silent subject became a card on 2026-09-20, a number chosen against one week. `passed-over 7`, taken no earlier than 2026-09-27, says how often it fired and what it still left silent; `passed-over 30` after 2026-10-20 ranks the rules that kept subjects quiet, `already_told_by_another_source` among them -- the one rule that reads a second independent witness as a duplicate, right most days and worth narrowing only against its own count. Done when both readings are written here with their dates, and the threshold and that rule are moved or kept with a reason. More than about three cards in a week is bookkeeping filling a channel, and the fix is a tighter rule rather than a higher number. |
| After the reactions | Read Jev back against the readers, and decide what `confidence` is for. | Jev answers every judgement with a confidence we store and never read: a `worth` of 2.1 held at 0.3 is today indistinguishable from the same 2.1 held at 0.95. The fix is not obvious in either direction -- weighting the score by it and refusing a judgement under a floor cut different things -- and there is nothing to choose between them while the only opinion on a card is Jev's own. Since 2026-09-20 `scout_reactions` separates silence from 👍 and from 👎, and the bot seeds both under each card. Done when at least fifty cards carry a reader's answer, `worth` and `confidence` are correlated against those answers here with their date, and `confidence` is either given a use or written off. |
| Owner decision | AWS: an account for Bedrock and its quotas. | The Vertex pair is the model: Vertex quotas named `grok-4.7` on 2026-09-17 while Model Garden's newest xAI entry was `grok-4.6`. Bedrock's counterparts are `ListFoundationModels` and `ListInferenceProfiles` in `us-east-1` and `us-west-2`, and Service Quotas for service code `bedrock`, whose per-model token limits may likewise run ahead of the listing. Reading them is free; the account needs a card. Done when an IAM user holding only those three read actions has its keys in production and both collect. |
| Owner decision | Azure: a subscription for AI Foundry. | `Microsoft.CognitiveServices/locations/{region}/models` is the deployable catalogue per region and `usages` the per-model quota; today Azure is seen only second-hand, through the TrueFoundry mirror and the lifecycle page. A pay-as-you-go subscription costs nothing unused. Done when a service principal with Reader has its tenant, client id and secret in production and both collect. |
| Owner decision | Kimi: a key for the coding tier. | The Moonshot key answers with `kimi-k2.6` and `kimi-k2.7-code` and nothing newer, checked against production 2026-09-14, which is why the K2.8 Preview rollout of 11 September 2026 was invisible here. The coding tier is a separate host with a separate credential: `api.kimi.com/coding/v1/models` answers 401 to a key it does not accept while every neighbouring path answers 404, so the source is registered and correct ahead of the key. Set `KIMI_API_KEY` and it collects; the Kimi Code changelog already ships as its own source. |

## Settled by measurement

Kept because the reasoning cost real observation and is easy to re-litigate from intuition.

- **Two open channels, `news` and `radar`.** `news` carries what happened (eight classes, at
  `detail: brief`), `radar` what was spotted before anyone announced it (`codename`). Named `signals`
  and `scouts` until 2026-09-20, when `signals` was found to collide with `signalClass`, which
  describes both; `leaks` was rejected for `radar` because nothing there is leaked -- a Vercel Gateway
  listing, an OpenRouter entry and an anonymous arena contender are public, read early. Neither is
  hidden, which is why the owner's own like stopped promoting that day: written when `radar` was
  invited-only and promotion was the only route to a stranger, it had become a copy from one open
  channel to another, and only `readerVotes` moves a card now. On 2026-09-16 `news` was cut to
  `launch` and `radar` to `codename` after the owner read 2026-09-14..16 card by card: 193 arena
  withdrawals, weight drops nobody can call, one outage told three times and patch notes nobody
  subscribed to. `channel-mix 7`
  on 2026-09-17 then showed 7 `launch` events in a week, two of them models, and the owner widened it
  the same day: a newsroom post announcing a maker's model is `launch`; the changelogs of the tools
  readers work in are `release`; retirements go to `news` and as one line of the weekly recap; price
  moves go to `news` and their board leaders stay on `radar`, which also gets interface diffs whose
  new strings name a versioned model. Widened on the owner's word ahead of a replay, so the week
  after is the measurement: whatever `channel-mix 7` shows is noise comes back off. The classes stay
  independent of the channels, because reversing one must never need a deployment.
- **A subject can earn a card no single event earned.** Routing was all veto until 2026-09-20: right
  for one event, no shape for a subject. Step 5 Preview drew three independent sources in two days,
  each correctly too small, and nothing read the count `stories` kept. Three now send one `codename`
  card, and a measured Intelligence Index is a sighting at any place, since Artificial Analysis ranks
  only its leading twenty and the rest fell to `rank`, the class the recap empties: 3250 events in
  that week against 34 delivered. No floor was put under the index, the scale being one that moves.
  Still never a count printed on a card: rejected at 18% permanently wrong, confirmation landing a
  median 8.2 hours late.
- **`launch` and `codename` stay separate classes.** Merging them was proposed and rejected: the
  ping is the same but the trust is not. Competitors split by source instead (`api-models`, `arena`,
  `subpages`); with thirteen streams that is a dozen channels, and it defeats the cross-source story
  grouping they do not have.
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
- **Jev's thresholds are shares, and its questions are not to be reworded lightly.** Version 2 of the
  `worth` question added one sentence explaining the age field it shipped alongside, and moved the
  whole scale rather than the stale end of it: over the same 251 events the mean fell 1.31 to 0.93,
  and by 0.33 even on the 190 carrying no date at all. Commits clearing the fixed 1.6 fell 61 to 4
  and stories clearing 2 fell 15 to 1, so the recaps would have lost nearly every line with nothing
  about the commits having changed. Version 3 restored version 1's wording word for word and the
  counts came back (61 vs 62, 15 vs 14), which also settles the age field: Jev ignores
  `days_old_when_found` unless told to use it, and telling it skews everything else, so an age
  correction belongs downstream, where `review.ts` already drops anything over three days. The
  thresholds were never a quality bar -- they decide how many lines a morning gets -- and are now the
  worth the top 22% of commits and 4.5% of stories sit above, within the current prompt version only:
  live on 2026-09-20 that is 1.64 and 2.03, against the 1.6 and 2 they replace.
- **`radar`'s readers grade what a machine cannot.** Source-derived confidence answers "can this be
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
- **No welcome channel.** The channel map lives in each channel's Discord topic, where a reader already looks.

## Ideas

Not scheduled. Written down so they stop being re-derived from scratch.

- **Hosts of open models.** NVIDIA NIM (`integrate.api.nvidia.com/v1/models`), Together, Fireworks
  and DeepInfra list a model in `/v1/models` when they start serving it, often ahead of the
  announcement. Each needs a free key and would reach readers as a sighting only. NVIDIA first:
  it is the one that tends to be early. GitHub Models is not a candidate: its catalogue answered
  `410 github_models_retirement_brownout` on 2026-09-17.
- **The StepFun site.** The API catalogue shipped 2026-09-20 and covers the ids; the site is worth reading only for the words around a release. Deferred that day.
- **Regional lifecycle schedules.** A deprecation with different dates per region is stored as one record with one date.
- **A second Cohere reading with dates.** Its changelog is an index with no publication dates, so it
  is `web` evidence; the per-entry Markdown carries the date at one request each. Worth it only if a
  Cohere release ever needs dating to the day.

## Deferred

- Telegram delivery is implemented and tested; no destination is configured, because the audience is
  on Discord.
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
Cohere and xAI. Vertex quotas and Model Garden for thirteen publishers, and the Hugging Face
inference router's hosts. Vendor site pages watched for URLs that appear before the announcement, including
the Claude API reference and help centre. Eleven iOS listings, read for the vendor's own release
notes. Codex usage-limit resets. GitHub discovery, in shadow. Two aggregated
catalogues, in shadow: models.dev, which carries 217 providers as 2291 canonical models, and the
TrueFoundry mirror of the two Azure directories, which is the only sight of a cloud's deployment
version. Both are `third_party`, so a model they show and no vendor does stays `observed`.

A failed or malformed collection is never treated as an empty catalogue, and external responses are
validated before they can change stored state.
