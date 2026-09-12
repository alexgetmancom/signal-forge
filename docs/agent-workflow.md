# Signal Forge and Solo Publisher workflow

Signal Forge and Solo Publisher remain independent; neither imports the other or reads its database.

## Publication archive

Signal Forge reads Solo Publisher's existing `ops_recent` and `ops_post_text` MCP operations every
15 minutes. Configure `SOLO_PUBLISHER_MCP_URL` (HTTPS `/api/mcp`) and
`SOLO_PUBLISHER_MCP_TOKEN` together in the deployment environment. The token is a Studio credential;
the reader calls only these two read operations, but the credential itself is not read-only.
No endpoint or authoring change is required in Solo Publisher.

Run `bun src/cli.ts publications 20` or `GET /api/publications?limit=20` to read the stored copy,
target links, per-target outcomes, last successful check and coverage. `sync-publications` refreshes
it explicitly and changes only Signal Forge's local archive. Routine refresh runs under the runtime
supervisor; failures appear in `issues` and leave the last complete snapshot in place.

The upstream operation returns at most 50 text publications. Each refresh updates that window and
retains previously seen rows; absence is not deletion. Older history, video publications and changes
to posts that have left the window are not covered. Loss of overlap with a full next window marks a
persistent coverage gap: do not calculate complete conversion across that gap. `publishedAt` is the
Studio's publication date, not a verified per-platform send timestamp.

These are editorial outcomes, never corroborating signal evidence. This connection does not match
stories, calculate conversion, create drafts or send subscriber notifications. The draft workflow
below remains an explicit agent action.

## Evidence-first flow

1. Query `stories` with a time window, vendor filter and a confidence floor.
2. Fetch each linked event by ID and inspect its before/after evidence and source URL.
3. Treat `observed`, `supported`, `confirmed` and `shipped` as source-derived metadata, not as a
   request to infer certainty from prose.
4. Inspect `identityStatus`, `canonicalId` and aliases. Treat `codename`, `alias`, `unconfirmed` and
   `unknown` as unresolved identity, not as an official model name.
5. Discard or flag stories whose evidence does not support a reader-facing claim.
6. Prepare a draft in Solo Publisher using only the selected evidence and explicit editorial context.
7. Leave publication, scheduling and any external send behind a separate explicit approval.

## Draft handoff contract

A draft handoff should contain:

- a proposed title and short summary;
- the Signal Forge story ID and event IDs;
- source names, confidence labels and evidence URLs;
- the before/after facts that support each claim;
- unresolved ambiguity and the human decision still required.

The default action is draft-only. The workflow must not invent a Solo Publisher URL, call its
database, or retry an ambiguous Signal Forge delivery. If a story is not strong enough to publish,
return the evidence and the reason for stopping instead of upgrading its confidence.
