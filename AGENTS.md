# Who this file is for

The maintainer's working agreement for developing this repository, not a description of the product.
The repository is public; the hosts, paths and credentials it operates are not in it. Somebody
reading to understand what the service does wants [README.md](README.md).

# How to work here

One developer, who is also the reviewer and the operator. There is no team and no other caller.
Assume the direct version of the work and do not ask permission for it. When the direct version has
a real cost — evidence lost, a wrong card in a public channel, a message sent twice — name it in a
sentence or two and proceed.

- Work on `main`. No pull requests, no RFCs, no deprecation notices, no changelog.
- No transitional scaffolding. Leaving the old path looks like the considerate choice and is how two
  of everything arrives: rename, delete the old path, update every call site and migrate the data in
  one commit.
- Build for the case that exists. No extension points or configuration knobs with one implementation.
- A shared abstraction that branches on which caller it serves is the wrong abstraction. Push the
  difference into an explicit capability or keep the implementations apart; never add the branch.
- One concept, one name. Two names for one thing is a defect.
- Finish in one move: no TODO breadcrumbs, no stubs, no half-migrated state. If you stop mid-change,
  roll back before reporting — the reader cannot see which half landed.
- Verify, don't reason. Run it, measure it, then say it, especially about production, CI and Docker.
  A number in a commit message or a document carries the date it was measured.
- Tests where they earn their keep: silent breakage, wiring that drifts, bugs actually found.
- `bun run check` is the gate and says what it enforces. Add a rule there instead of writing it here.

English everywhere, no exception: code, comments, commits, logs, errors, and every word a subscriber
reads. Timestamps are UTC.

# Documentation

Four files, and the gate enforces it. `README.md` is what the service is; this file is how work is
done; `docs/roadmap.md` is the plan and the decisions measurement already settled; `docs/runbook.md`
is which script to run when. Everything else is a comment next to the code it explains.

Delivery has no document. A signal class is defined where it is derived, a suppression rule beside
the code that applies it, and the routing in `signal-forge.json` -- which is the file the service
actually reads, so it cannot drift from what subscribers get.

Write a document only when it changes what happens next. A record of what was built is the code, its
tests and the git log — a second copy in prose is wrong within a month and nobody notices. A new
file, or a file past its budget, fails `check-docs` with the list of where the content belongs.

# Invariants

Getting these wrong loses evidence or delivers twice, and nothing else checks them.

- Snapshots, events and delivery jobs commit in one transaction.
- A delivery with an uncertain external outcome is ambiguous, never automatically retried.
- A failed or malformed collection is never an empty catalog.
- Background work is registered with the runtime supervisor.
- External responses are validated with Zod. Credentials and URLs carrying them are never logged.
- Some subscriber-facing strings live in `records.body` and are compared byte for byte to decide
  whether something changed. Rewording one without migrating the stored rows emits a "changed" event
  for every record carrying it. Migrate with the collector stopped.

# Boundaries

LAN-only. Publishing is outbound over HTTPS: nothing listens for the outside, no port is forwarded,
nothing persists across a reboot that the owner did not ask for, no other host is touched.

Stop and ask before anything the public can reach, anything that costs money, and anything awkward
to undo.

# Production

`docs/runbook.md` is the route, and `bun src/cli.ts guide` is where to start when the command is not
obvious. Get CLI output before reading source, and never run a mutation without an explicit request.
`docs/roadmap.md` is the current plan, and the decisions measurement already settled are in it: do
not re-open one without a number that has actually moved.

Every operation is one entry in the operations registry. The CLI dispatch and its usage lines, the
HTTP routes, the MCP tool list and the `guide` catalog are projections of it, so adding an entry is
the whole change and a usage string is never written by hand. `mutates` marks an operation that
changes stored state; `agent: false` keeps it off the MCP surface, which is where credential and
host operations belong.

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
