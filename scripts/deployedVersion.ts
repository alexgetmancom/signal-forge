/**
 * The schema version production is running, as far as the repository can tell.
 *
 * Deploying is a push to main, so the version declared on `origin/main` is the one the host holds
 * once the release lands. A database is stamped with the version it reached and the runner refuses
 * anything newer than the code knows, which makes this the number a journal must never go below and
 * the one a squash may reach but not pass.
 */
export function deployedSchemaVersion(): number | null {
  const show = Bun.spawnSync(["git", "show", "origin/main:src/storage/migrations.ts"]);
  if (!show.success) return null;
  const match = /CURRENT_SCHEMA_VERSION = (\d+)/.exec(show.stdout.toString());
  return match?.[1] ? Number(match[1]) : null;
}
