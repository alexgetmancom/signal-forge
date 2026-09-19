---
name: prod
description: Answer any question about what signal-forge saw, sent, collected or broke — news of the day, events, stories, deliveries, sources, issues, logs — from production, never the local database. Use whenever the user says "prod", "на проде", "что вышло", "посмотри", or asks about real data.
---

Production is the only source of truth. The local `data/app.db` is a stale copy; never read it, never
answer from it, and never run `bun src/cli.ts` for a question about real data.

Two routes, same operations and same database:

- MCP tools from the `signal-forge-prod` server (`news`, `stories`, `issues`, `status`, ...), when
  they are listed. Preferred: typed arguments, structured answers.
- Otherwise `bun run prod <command> [arguments]` — ssh `vm106` into the running container. stdout is
  JSON, the banner is on stderr. `bun run prod help` lists everything.

Question to command:

| Asked | Command |
| --- | --- |
| what came out today / over N hours / by category | `news [hours] [signal]` — signal is launch, codename, release, article, evidence, rank, change, incident, reminder, retirement |
| what is broken, what needs attention | `issues`, then `status` |
| is the deployment healthy, backed up | `doctor` |
| a story, a model, what a claim rests on | `stories [limit]`, `model <canonical-id>`, `event <id>` |
| raw detected changes | `events [limit]` — mostly scoreboard noise; prefer `news` |
| collected but nobody got a message | `suppressions [limit]` |
| what was sent, what failed | `deliveries [limit]`, `deliveries-needing-verification` |
| which source is worth keeping, who was first | `source-verdicts [days]`, `lead-time [days]`, `channel-mix [days]` |
| what the process logged | `bun run prod logs --since 6h --grep TEXT --lines 200` |
| not sure | `guide` |

Commands marked `[mutates]` in `help` change production state (`poll`, `sync-publications`,
`resolve-delivery-verification`, `clear-credential-circuit`, ...). Run one only when the user asked
for that change in so many words; a question is never permission.

Answer in the user's language with the facts, not the JSON: what happened, grouped by category,
with ids a follow-up can use.
