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
request. `docs/roadmap.md` is the current plan; `docs/competitors/` records what was already
decided from the competitor audit and is not a second backlog.
