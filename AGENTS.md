# signal-forge

Two commands are the index, and nothing either of them says is repeated here.

- `bun run guide` — every command this repository has and when to reach for it.
- `bun run prod guide` — every command the running service has, a symptom index that maps a question to one, and `guide <command>` for how to read what it answers. Generated from `src/operations/`, so it cannot drift from what exists.

What follows is only the things that are not a command.

- Real data lives on prod: `ssh vm106`, container `signal-forge-app-1`, db `/app/data/app.db`. Local `data/app.db` is a stale copy — never answer from it. `bun run prod <command>` and `bun run probe` both reach the real one.
- A new way to ask something is one entry in `src/operations/`, never a script on the host. That entry is the CLI command, the HTTP route, the MCP tool and its own documentation at once; `agent` and `mutates` are the only fields that are not documentation.
- A new development command is an entry in `scripts/workbench.ts` in the same move, and the gate fails if it is not. A command nobody can find and a command that does not exist look identical from the outside, and only one of them is fixed by writing code.
- Ask the reports before the tables. `sources` and `deliveries` keep a row for everything that ever ran or was ever sent to, including what has since been retired, so a raw `GROUP BY` counts eight channels where three are configured. `check-sql` enforces this for `sources`; for channels the registry is a config file rather than a table, so only `destinations` knows.
- No upstream value is ever stored. Not in a failure's evidence, not in the shape of an answer that worked — paths and types only. The rule this replaced was a regex on an error message, which would have published a response body that happened to start with the right word.
- A failure's sentence is trusted because of its type, never because of its wording: throw `SourceError(kind, message)` from a collector and the message is stored and printed, throw a bare `Error` and it is described instead. `src/failure.ts` has the kinds.
- A new index ships with the read it was for, in `src/storage/hotQueries.ts`, and with `ANALYZE;` in the same migration. 049 shipped five indexes the planner ignored until `sqlite_stat1` was populated, and from outside an unused index and a missing one look identical.
- Reach for `tests/fixtures/build.ts` before writing an INSERT in a test. `anEvent`, `aSnapshot`, `anAttempt` and `aCall` produce rows that satisfy the CHECK constraints; writing them by hand produced `CHECK constraint failed` instead of a test five times over two sessions.
- Work on main. Deploy is a push: `git push`, find the run by head SHA, `gh run watch --exit-status`, then `bun run prod verify <symbol>` — the symbol in `/app/dist` is the only one of its four checks that can tell a new image from an old one still running.
- English only in `src/`, `scripts/`, `tests/` and `docs/`; the gate checks it.
