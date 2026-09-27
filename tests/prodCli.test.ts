import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("prod logs returns Docker's failure and tails matching lines on success", () => {
  const directory = mkdtempSync(join(tmpdir(), "signal-forge-prod-cli-"));
  const ssh = join(directory, "ssh");
  const env = {
    ...process.env,
    PATH: `${directory}:${process.env.PATH ?? ""}`,
    SIGNAL_FORGE_SSH: "fake-host",
  };
  const root = resolve(import.meta.dir, "..");
  try {
    writeFileSync(ssh, "#!/bin/sh\nprintf 'Error response from daemon: No such container\\n'\nexit 7\n", {
      mode: 0o755,
    });
    const failure = Bun.spawnSync(["bun", "scripts/prod.ts", "logs", "--since", "1m", "--grep", "needle"], {
      cwd: root,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(failure.exitCode).toBe(7);
    expect(failure.stdout.toString()).toBe("");
    expect(failure.stderr.toString()).toContain("No such container");

    writeFileSync(ssh, "#!/bin/sh\nprintf 'one\\nneedle two\\nthree\\nneedle four\\nneedle five\\n'\n", {
      mode: 0o755,
    });
    const success = Bun.spawnSync(["bun", "scripts/prod.ts", "logs", "--grep", "needle", "--lines", "2"], {
      cwd: root,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(success.exitCode).toBe(0);
    expect(success.stdout.toString()).toBe("needle four\nneedle five\n");

    const invalid = Bun.spawnSync(["bun", "scripts/prod.ts", "logs", "--lines", "0"], {
      cwd: root,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stdout.toString()).toBe("");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
