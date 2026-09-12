# Recommendations for Signal Forge

**Status: all seven recommendations below are implemented.** This file is kept as the record of
where the shape of the product came from, not as a backlog. New work belongs in
[docs/roadmap.md](../roadmap.md).

Observation date: 2026-09-09 UTC. These recommendations are based on the inspected Dev Mode, RAGtag, and Lumina feeds. The screenshots are three-pages-up captures for each requested channel; Web Watcher also has an extra multi-page capture series because its history was especially useful for comparison.

## Highest-value changes

1. Make lifecycle state explicit. Every catalogue event should be one of `new`, `removed`, or `changed`. A changed event should retain the same logical identity and list field-level before/after values.

2. Store provenance with the event. Include source family, canonical source URL, provider, observed timestamp in UTC, and evidence type. Keep raw paths, strings, package versions, repository links, or first-party metadata references when available.

3. Use a normalized model envelope. At minimum, preserve display name, canonical ID, provider, creation or first-seen time, context length, input/output modalities, region or deployment scope, and input/output/cache pricing where applicable.

4. Add source-specific evidence without flattening it into one vague feed. The existing product areas map naturally to Web Watcher, App Updates, API Models, App Diffs, and Benchmarks. The competitor evidence suggests adding focused event types for Arena, Open Weights, Official News, Availability, and Codenames rather than hiding them inside generic updates.

5. Improve benchmark cards. Put benchmark name, category, exact score, model variant or effort setting, rank delta, sample date, and direct leaderboard URL in one card. Keep numeric values authoritative; reactions can be a triage signal only.

6. Add uncertainty and evidence levels. Preserve `unknown` or `unconfirmed` identity when the source only proves a codename, surface, or capability. Do not promote an inferred identity to a canonical model name without evidence.

7. Add a compact tracker-status report. Show collector health, last successful observation, delivery state, and disabled sources. A failed or malformed collection must remain visibly failed; it must never be interpreted as an empty catalogue.

## Presentation rules worth copying

- Use a stable header, provider tag, event title, short evidence block, and canonical link.
- Keep raw evidence and human-readable summary together, with the raw evidence taking precedence.
- Use consistent footers and source icons so a busy channel can be scanned quickly.
- Prefer one event per card, but include a count when a batch is large.
- Preserve edited timestamps and reconciliations so later changes do not look like duplicate discoveries.

## Guardrails for implementation

Keep the direct path: one normalized event, one SQLite transaction for snapshot/event/delivery state, and one delivery outcome. Do not add compatibility shims, duplicate writes, speculative abstraction layers, or silent fallback paths. Validate external responses with Zod, keep environment access in `config.ts`, use UTC timestamps, and treat an uncertain external delivery outcome as ambiguous rather than automatically retrying it.

The practical priority is provenance plus lifecycle diffs. Those two changes would capture most of the value visible in RAGtag and Lumina while fitting the existing Signal Forge shape. Source expansion should follow only after the event envelope and failure semantics are reliable.

## Implemented intelligence layer

The current implementation keeps those recommendations on the existing evidence path:

* GitHub and Hugging Face discovery use shadow sources, so they can be measured before their
  observations reach subscribers. Shadow sources still collect snapshots, events, stories and
  metrics; only delivery work is suppressed.
* Attention scores are deterministic triage values. Confidence remains source-derived and is never
  changed by attention or an LLM classifier.
* Model Facts is a projection, not another source of truth. Each field carries its source, event ID,
  evidence type, confidence and observed timestamp.
* Source-quality reporting measures first-source wins and independent confirmation by source family,
  including lead time and signal density.
* Hypotheses are deterministic story interpretations linked to real events. They never become
  evidence or subscriber deliveries.
* Lifecycle reminders are idempotent delivery work derived from the original deprecation event.
  Rebuilding projections cannot create a second reminder batch.

LLM relevance verification remains deferred until deterministic discovery has produced at least
seven days of quality measurements.
