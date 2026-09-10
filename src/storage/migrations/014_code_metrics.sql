CREATE TABLE code_metrics (
  name TEXT NOT NULL,
  bucket_start TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  total_duration_ms INTEGER NOT NULL DEFAULT 0,
  min_duration_ms INTEGER NOT NULL,
  max_duration_ms INTEGER NOT NULL,
  duration_buckets_json TEXT NOT NULL,
  last_called_at TEXT NOT NULL,
  last_error_at TEXT,
  last_error_type TEXT,
  PRIMARY KEY(name, bucket_start)
);

CREATE INDEX code_metrics_bucket_start ON code_metrics(bucket_start);
