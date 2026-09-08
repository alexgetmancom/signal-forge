# RAGtag / RAGtrack System Analysis

> Reviewed: September 7, 2026

## 1. What was reviewed

I reviewed the RAGtag Discord server and these channels:

- `api-models` — topic: “Model updates on APIs (beta)”
- `arena` — topic: “Arena and ArenaDesign updates”
- `news` — topic: “Blog posts”
- `web`
- `leaderboards` — topic: “beta”
- `openrouter`

The automated messages in all of these channels are mainly posted by `RAGtrack App`. Messages carry the footer `ModelTracker · RAGtag`. The channels are read-only for regular members: they are event feeds rather than discussion channels.

The observations below are separated from architectural inferences. Where the application’s internal code is not visible, the conclusion is reconstructed from the message format and event sequence.

## 2. Main observation

RAGtrack does not look like a system that asks one OpenAI model “what changed on the internet?” It looks much more like a set of ordinary collectors. Each collector periodically retrieves a catalog or feed from one source, stores the previous snapshot, compares it with the new snapshot, and publishes only the difference.

The general pipeline appears to be:

```text
external source
      |
      v
periodic collector
      |
      v
normalized object
      |
      v
comparison with the previous snapshot
      |
      +--> new / removed / changed
      |
      v
message formatting
      |
      v
Discord channel
```

For large web-string changes there is an additional analysis layer: raw changes are extracted, grouped, sometimes summarized with AI, and accompanied by a link to the full report.

## 3. `api-models`

Purpose: track changes in official APIs and cloud-provider catalogs.

The visible sources included:

- OpenRouter
- Gemini API
- Anthropic API
- Bedrock
- OpenAI API

Message types include:

- `New ... API model`
- `Removed ... API model`
- `OpenRouter catalog update`
- `Bedrock catalog update`

The messages are not news summaries. They contain catalog fields:

- display name;
- provider or vendor;
- exact model ID;
- input/output price per million tokens;
- context-window size;
- input and output modalities;
- model creation date;
- for Bedrock, the Bedrock ID and available regions.

Examples seen on screen:

- Gemini 3.5 Transcribe and Gemini 3.5 Transcribe Live appeared together as `2 new`.
- Gemini Robotics-ER 1.6 Preview was added at 00:23 and removed four minutes later at 00:27. That almost certainly reflects a live-catalog or availability change rather than a press release.
- Claude Fable 5.1 first appeared as an Anthropic API model and then, 39 minutes later, as a Bedrock model. These are two independent projections of the same model family.
- `gpt-6-astra` appeared as an OpenAI API model with a creation timestamp. Two minutes later, a Community Manager manually added an `@everyone` rollout announcement for ChatGPT/Codex.

Important conclusion: this channel is based on availability and metadata snapshots, not only official announcements. A model can appear and disappear several times. That history should be preserved rather than overwritten.

## 4. `arena`

Purpose: track the roster of models allowed in different arenas or comparison modes.

The channel reports:

- `new`;
- `removed`;
- `changed`;
- `Arena roster update`;
- a separate `DesignArena` stream.

For the regular Arena, messages contain:

- model name;
- maker;
- provider;
- whether it is selectable;
- input and output modalities;
- an internal record UUID.

Examples:

- `bbq` — unknown maker, Text -> Text;
- `openhard-2.5-search-cot-0904` — Text -> Search;
- `kestrel-alpha` and `kestrel-gamma` — Text -> Web;
- `gpt-6-astra-max`, `gpt-6-astra-max-code-codex-harness`, and `gpt-6-astra-search-max` — three OpenAI records with different modes and modalities;
- `gemini-omni-1.1-flash` — Image/Text/Video -> Video;
- `kestrel-beta` — Text -> Web.

The `changed` events are particularly informative. For example:

- `eren-v2` gained maker `Microsoft AI` and provider `microsoftFalcon`;
- `polaris` and `vega` received maker/provider `Wan`;
- `muse-spark-1.3-(max)` was renamed to `muse-spark-1.3-max`, received provider `metaModelApi`, and gained image input;
- `gpt-6-astra-max` first lost maker/provider and later reappeared as `OpenAI/openaiResponses`.

This means the application compares individual object fields, not just record existence. It is a structured diff over a registry.

`DesignArena` is a separate registry for visual and product-oriented modes. It includes:

- name;
- provider;
- arena categories;
- supported operations;
- prices per million tokens or per image.

Examples include GPT-6 Astra with Website/Game dev/3D categories and `$10 in / $50 out per 1M`; MAI-Image-2.6 and Flash with per-image prices; Muse Spark 1.3 (xhigh) with six arenas; and Aleph 2.0 with Video -> Video and Multimodal -> Video.

## 5. `news`

Purpose: publish a feed of official posts. On screen, this was effectively the OpenAI Blog.

Each message contains:

- event type: `New OpenAI post`;
- title;
- a link to `openai.com`;
- a short description/snippet;
- the original publication time in GMT;
- the time when the post was detected in Discord.

Examples:

- “Path to Astra: critical capabilities and frontier safeguards”;
- “How law firm Gilbert + Tobin governs and scales AI with OpenAI”;
- “ATV Big Air Tour turned 3 days of work into 3 hours with ChatGPT”;
- “Legora reviewed 41 documents in minutes with GPT-6 Astra”;
- “Playco cut manual fixes 50% prototyping games with GPT-6 Astra”;
- “Safety overview: GPT-6 Astra”;
- “GPT-6 Astra: A new generation of intelligence”;
- “Research acceleration: The view inside OpenAI”;
- “An Alien Mind”;
- “Supporting independent journalism in Ukraine”.

This collector is simpler than the API catalog collectors: it reads an official feed or blog page, extracts new URLs, avoids reposting the same URL, and displays page metadata. There is no need to call the OpenAI API just to detect a new post. AI could optionally be used for normalization or summarization.

## 6. `web`

Purpose: track changes in web interfaces, primarily `claude.ai`.

This is the most unusual channel. It does not appear to monitor a public API in the ordinary sense. The collector likely retrieves localization strings or frontend resources from the web client, compares large string sets, and publishes the diff.

Observed batch sizes included:

- 61 new strings;
- 346 new strings;
- 21 new strings;
- 39 new strings;
- 763 strings;
- 45, 48, 14, 38, 42, and 67 new strings.

The strings revealed signs of internal or upcoming product surfaces:

- approval flows, worktrees, branches, and commit SHAs;
- Cowork and Claude Code;
- plugins, skills, and marketplace synchronization;
- inference hooks and verdict endpoints;
- IAM trust-policy checks;
- browser computer-use lifecycle;
- remote control and scheduled/webhook-triggered routines;
- background tasks, credits, and automated runs.

Some large batches receive a human-readable or AI-generated summary. A typical message contains a title such as “Computer use with visible status and permissioning is appearing”, a list of findings, a `Full report` link, and a Discord invite link. One message explicitly says `ModelTracker · AI summary`.

This is a useful pattern for a custom system: preserve the raw diff first, then generate a separate summary and attach the full source. The raw material should never be replaced by an AI summary.

There is also a practical limitation: this type of collector may violate a website’s terms of use or break whenever the frontend changes. It should only be built for resources that may legitimately be retrieved and analyzed.

## 7. `leaderboards`

Purpose: notify about new models appearing on an Arena leaderboard.

Each message is short:

- category: Code, Text, Image To Video, Text To Image, Image Edit, or Text To Video;
- `new model` and its name;
- a link to `arena.ai/leaderboard`;
- sometimes user reactions.

Examples:

- Code: `qwen3.8-max-0902`;
- Text: `gemini-3.8-flash-high`;
- Code: `claude-fable-5.1-max`;
- Image To Video: `wan3.0`;
- Text To Image and Image Edit: `mai-image-2.6`;
- Code: `muse-spark-1.3 (xHigh)`;
- Code: `gpt-6-astra-max`;
- Text To Video: `grok-imagine-video-1.5-agent`.

The leaderboard is not recalculated in this Discord channel. The channel appears to be a notification feed for a diff of an external leaderboard. The link sends the user to the primary source, while Discord remains the detection log.

## 8. `openrouter`

Purpose: provide a dedicated, detailed feed for changes in the OpenRouter catalog.

Unlike the aggregated `api-models` channel, OpenRouter has its own stream. It reports:

- `new`;
- `removed`;
- `changed`, especially renames;
- input/output pricing;
- context-window size;
- modalities;
- exact OpenRouter model ID;
- model date.

Examples:

- GPT-6 Astra: `openai/gpt-6-astra`, `$10/$50 per Mtok`, 1050K context, text+image+file -> text;
- GPT-6 Astra temporarily appeared and disappeared, followed by a new publication of GPT-6 Astra and GPT-6 Astra Pro;
- GPT-6 Astra batch and GPT-6 Astra Pro batch at `$5/$25`;
- Qwen3.8 Max (0803) was renamed, then Qwen3.8 Max (0902) appeared, after which the old version was removed;
- removal of Z.ai GLM 5.2 (free);
- removal of MiniMax M2.7 (free) and MiniMax M3 (free).

This makes it clear why checking the model list once a day is insufficient. The catalog changes quickly, prices and aliases are part of the event, and temporary availability can look like a real release.

## 9. How the channels are connected

The same object can pass through several independent sources:

```text
OpenAI API
  -> api-models: API model appeared
  -> arena: model appeared in a specific arena mode
  -> leaderboards: model appeared in a ranking
  -> news: official article or announcement
  -> OpenRouter: model became available through an aggregator, with its own price and alias
```

These events do not necessarily happen at the same time. In the reviewed messages, `gpt-6-astra` and Claude Fable 5.1 appeared in different channels with different delays. Therefore, the data model should store the source and detection time separately instead of trying to invent one “true release date”.

## 10. Likely internal architecture

Directly observable facts:

- one Discord App posts the automated messages;
- event formats are consistent and typed;
- channels are separated by source and purpose;
- the system uses `new`, `removed`, and `changed` operations;
- primary IDs and metadata are preserved in messages;
- some messages contain links to primary sources or full reports;
- important events can receive a manual Community Manager confirmation and `@everyone` announcement.

The most likely architecture is:

1. **Source collectors.** OpenRouter, Gemini, OpenAI, Anthropic, Bedrock, Arena, DesignArena, Arena leaderboard, OpenAI Blog, and web resources are fetched independently.
2. **Normalization.** Each record is mapped to fields such as `source`, `external_id`, `name`, `provider`, `maker`, `modalities`, `pricing`, `context`, `created_at`, and `raw_payload`.
3. **State.** The latest successful snapshot is stored separately from the event history.
4. **Diff.** Two snapshots are compared by external ID and meaningful fields. Renames, provider changes, prices, and modality changes become `changed` events.
5. **Deduplication.** Every event needs a stable key so that polling does not spam Discord.
6. **Rendering.** The same event type is rendered differently by channel: short for leaderboards, detailed for OpenRouter, URL-based for News, and AI-summarized for large web diffs.
7. **Delivery.** A Discord bot/app posts the messages through the Discord API. A human Community Manager handles exceptional announcements.
8. **Archive.** Discord is the presentation layer and event log. The source of truth should be a database or snapshot files.

## 11. What not to copy literally

- Do not connect OpenAI to everything just to monitor changes. It is not needed for discovery.
- Do not use an LLM to compare structured catalogs. A JSON diff is cheaper, more accurate, and reproducible.
- Do not start by reverse-engineering every website. The Web layer is the most fragile and expensive to maintain.
- Do not treat a temporary disappearance as a final removal without a confirmation poll.
- Do not store only polished Discord messages. Keep raw snapshots and event history.
- Do not confuse the provider’s model creation date with the time your collector detected it.

## 12. Where to start building your own system

Start with two sources: OpenRouter and one official API, such as OpenAI or Gemini. This exercises the complete core mechanism on a simple, verifiable problem:

```text
fetch JSON catalog
  -> save snapshot
  -> compare with previous snapshot
  -> record event
  -> send Discord webhook
```

Minimal implementation:

- one Python or TypeScript process;
- SQLite for state and history;
- either a cron job or one long-running loop;
- direct OpenRouter fetch code;
- direct fetch code for the second provider;
- a Discord webhook for publishing;
- raw JSON for every successful poll;
- a snapshots table;
- an events table with `new`, `removed`, and `changed`;
- a delivery key or delivery table to prevent duplicate posts.

Do not create a generic plugin framework or adapter system in advance. Start with two honest collectors with direct names. Once a second real source demonstrates a repeated structure, extract only the genuinely shared snapshot/diff and delivery logic.

## 13. Suggested data model

### Model catalog record

- `source`: `openrouter`, `openai-api`, `gemini-api`;
- `external_id`;
- `display_name`;
- `provider`;
- `maker`;
- `input_modalities`;
- `output_modalities`;
- `context_window`;
- `input_price`;
- `output_price`;
- `created_at`;
- `first_seen_at`;
- `last_seen_at`;
- `raw_json`.

### Event

- `source`;
- `entity_type`;
- `entity_key`;
- `event_type`: `new`, `removed`, or `changed`;
- `changed_fields`;
- `before_json`;
- `after_json`;
- `detected_at`;
- `published_at`;
- `delivery_key`.

For News, it is enough to store `canonical_url`, `title`, `description`, `source_published_at`, `first_seen_at`, and the raw feed item.

## 14. Expansion order

1. **OpenRouter + one official API.** Verify that new, removed, and changed records are not duplicated.
2. **News through RSS or an official feed.** This is a simple win: URL deduplication, a link, and short text.
3. **Arena and leaderboards**, if there is a permitted and stable JSON/API or other official source. Focus on roster changes and capability fields.
4. **Bedrock and other catalogs.** These add regions, vendors, and provider-specific IDs.
5. **Web last.** Store raw assets and string diffs first; add AI summaries only for large diffs. If the source cannot be retrieved reliably or lawfully, do not build this layer.

## 15. Where OpenAI API is useful

OpenAI API can be useful for:

- summarizing a large web diff;
- classifying a news item and extracting affected products;
- combining several events from one release into a readable digest.

It is not needed for:

- fetching an OpenRouter catalog;
- comparing JSON;
- detecting a new RSS item;
- deduplication;
- sending a Discord message;
- calculating a leaderboard diff.

The LLM is an explanation layer, not the monitoring layer.

## 16. Main risks

- Catalogs may temporarily return an incomplete list. Without confirmation, this creates false removals.
- Price, alias, and provider can change independently of the model name.
- One provider may publish one model in several modes.
- Discord imposes rate and message-length limits.
- Web strings are noisy and do not always represent a user-facing feature.
- Sites and feeds can change format, so raw payloads and error logs are mandatory.
- External-site collection must respect the site’s terms of use and API/robots policy.

## 17. Tests that actually pay off

Focus on tests for silent failures:

- an identical snapshot creates no events;
- adding a record creates exactly one `new` event;
- removal is emitted only after confirmation;
- changing price/name/provider creates `changed` with before/after values;
- running the same cycle twice does not publish the event twice;
- a source error does not replace the last good snapshot with an empty list;
- an oversized event batch is split into valid Discord messages.

## Final opinion

The core is not “connect OpenAI to every API”. The core is a set of careful collectors, snapshots, structured diffs, normalization, and a good Discord renderer. AI sits on top to explain large changes to a human.

If I were building this, I would start with a small, reliable ModelTracker for OpenRouter plus OpenAI or Gemini, keep the complete history in SQLite, and only then add News and Arena. That produces real value without unnecessary layers. Changes can be made directly in the database and code, without transitional facades.
