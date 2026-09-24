# signal-forge

- Real data lives on prod: `ssh vm106`, container `signal-forge-app-1`, db `/app/data/app.db`. Local `data/app.db` is a stale copy — never answer from it. Use the `prod` skill.
- No `sqlite3` there: query with `docker exec signal-forge-app-1 bun -e '...'` and `bun:sqlite`.
- Work on main, Deploy is a push: `git push`, find the run by head SHA, `gh run watch --exit-status`, then grep the container's `/app/dist` for a symbol you just added.
