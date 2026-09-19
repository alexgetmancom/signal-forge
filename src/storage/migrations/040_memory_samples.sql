-- What the process and its container held, sampled every five minutes.
--
-- Memory was logged once an hour to stdout, which the container discards on every deploy, so the
-- question "how close to the limit does a collection cycle run" had no answer older than the last
-- release. The limit was raised twice on single observations (512m, then 1g, now 2g). oom_kills is
-- the container's cumulative kill counter: a process cannot record its own OOM kill, but the next
-- one reads the counter and the rise between two samples says one happened.

CREATE TABLE memory_samples (
  sampled_at TEXT PRIMARY KEY CHECK(sampled_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  boot_id TEXT,
  rss_mb REAL NOT NULL,
  heap_used_mb REAL NOT NULL,
  cgroup_current_mb REAL,
  cgroup_peak_mb REAL,
  cgroup_limit_mb REAL,
  oom_kills INTEGER
);
