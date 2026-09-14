# Working agreement

One developer and operator. Work on main. No pull requests, compatibility shims or speculative
layers. Build for the case that exists, finish it in one move, and verify by running it rather than
by reasoning about it. If you stop mid-change, roll back before reporting — the reader cannot see
which half landed.

English everywhere, no exception: code, comments, commits, logs, errors, and every word a subscriber
reads. Timestamps are UTC. Some subscriber-facing strings live in `records.body` and are compared
byte for byte to decide whether something changed, so rewording one without migrating the stored
rows emits a "changed" event for every record carrying it. Migrate with the collector stopped.

`bun run check` is the gate and says what it enforces; add a rule there instead of writing it here.

# Invariants

Getting these wrong loses evidence or delivers twice, and nothing else checks them.

- Snapshots, events and delivery jobs commit in one transaction.
- A delivery with an uncertain external outcome is ambiguous, never automatically retried.
- A failed or malformed collection is never an empty catalog.
- Background work is registered with the runtime supervisor.
- External responses are validated with Zod. Credentials and URLs carrying them are never logged.

# Boundaries

LAN-only. Publishing is outbound over HTTPS: nothing listens for the outside, no port is forwarded,
nothing persists across a reboot that the owner did not ask for, no other host is touched.

Stop and ask before anything the public can reach, anything that costs money, and anything awkward
to undo.

# Production

`docs/runbook.md` is the route, and `bun src/cli.ts guide` is where to start when the command is not
obvious. Get CLI output before reading source, and never run a mutation without an explicit
request. `docs/roadmap.md` is the current plan, and the decisions measurement already settled are in
it; do not re-open one without a number that has actually moved.

# Drafting from evidence

When work here feeds a publication, the evidence leads and the prose follows. Read `stories` with a
window, a vendor and a confidence floor, then fetch each event by id and inspect its before/after
evidence and source URL. `observed`, `supported`, `confirmed` and `shipped` are source-derived
metadata, never an invitation to infer certainty from prose; `codename`, `alias`, `unconfirmed` and
`unknown` are unresolved identity, never an official name. A story whose evidence does not support a
reader-facing claim is returned with the reason for stopping, not upgraded.

A draft handoff carries a proposed title and summary, the story and event ids, source names,
confidence labels and evidence URLs, the before/after facts behind each claim, and the ambiguity a
person still has to decide. Draft only: publication, scheduling and any external send stay behind a
separate explicit approval. Never invent a Solo Publisher URL, call its database, or retry an
ambiguous delivery.
