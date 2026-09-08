# Working agreement

One developer and operator. Work on main, no pull requests, compatibility shims or speculative layers.
Code, comments and docs are English; product messages may be Russian.
Run `bun run check` before pushing. Tests target data loss, duplicate delivery and source parsing.
Only config.ts reads process.env. Validate external responses with Zod.
Register background work with the runtime supervisor. Never log credentials or request URLs containing them.
Snapshots, events and delivery jobs commit in one SQLite transaction.
A delivery with an uncertain external outcome is ambiguous, never automatically retried.
Never interpret a failed or malformed collection as an empty catalog.
