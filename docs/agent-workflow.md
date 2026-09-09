# Signal Forge to Solo Publisher workflow

Signal Forge and Solo Publisher remain independent. An agent is the boundary between them; neither
project imports the other, reads the other's database, or stores the other's credentials.

## Evidence-first flow

1. Query `stories` with a time window, vendor filter and a confidence floor.
2. Fetch each linked event by ID and inspect its before/after evidence and source URL.
3. Treat `observed`, `supported`, `confirmed` and `shipped` as source-derived metadata, not as a
   request to infer certainty from prose.
4. Discard or flag stories whose evidence does not support a reader-facing claim.
5. Prepare a draft in Solo Publisher using only the selected evidence and explicit editorial context.
6. Leave publication, scheduling and any external send behind a separate explicit approval.

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
