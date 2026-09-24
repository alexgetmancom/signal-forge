# signal-forge

- Real data lives on prod: `ssh vm106`, container `signal-forge-app-1`, db `/app/data/app.db`. Local `data/app.db` is a stale copy — never answer from it. Use the `prod` skill.
- Start with `bun run prod guide` — it lists every command there is. `sql "<query>"` (read-only), `schema`, `snapshot <source>` answer most questions. A new command is one entry in `src/operations/`, never a script on the host.
- Open a session with `bun run prod issues` and `bun run prod silent-sources` — a failed source and a source that quietly stopped are both invisible everywhere else, and both have sat unnoticed for days.
- Ask the reports before the tables. `sources` keeps a row for every source that ever ran, including retired ones: the four designarena boards frozen at 2026-09-09 were pruned by 7f59f35 the next day, and their row is the date they stopped being asked, not a fault. The reports filter by the registry; raw SQL does not, and a stale row read straight out of the table looks exactly like a broken collector.
- Work on main, Deploy is a push: `git push`, find the run by head SHA, `gh run watch --exit-status`, then grep the container's `/app/dist` for a symbol you just added.
