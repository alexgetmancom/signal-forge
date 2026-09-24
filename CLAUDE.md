# signal-forge

- Real data lives on prod: `ssh vm106`, container `signal-forge-app-1`, db `/app/data/app.db`. Local `data/app.db` is a stale copy — never answer from it. Use the `prod` skill.
- No `sqlite3` there: query with `docker exec signal-forge-app-1 bun -e '...'` and `bun:sqlite`.
- Deploy is a push: `git push`, find the run by head SHA, `gh run watch --exit-status`, then grep the container's `/app/dist` for a symbol you just added.
- `bun run check` before every commit. Commit messages are prose, no bullet lists, no conventional prefixes.
- Readers pay $20 for Codex and Claude Code **Desktop**. Nothing about CLIs. Better silent than filler.
- Never bypass bot protection (openai.com, x.ai, x.com, chatgpt.com, claude.ai/api). A 403 is an answer.
- Never commit secrets; the Discord token is read inside the container and never printed.
- Don't disable a source without asking.
- Answer the user in Russian.
