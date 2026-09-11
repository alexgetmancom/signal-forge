-- Delivery routing follows what a reader subscribed to, not which source produced the event. The
-- class is derived from the event and recorded on the derived batch row, so immutable event
-- evidence is untouched.
ALTER TABLE batch_events ADD COLUMN signal TEXT NOT NULL DEFAULT '';

CREATE INDEX batch_events_signal ON batch_events(batch_id, signal);

-- Work prepared under stream subscriptions cannot be routed under class subscriptions: its stored
-- destination no longer parses. Anything already sent stays as history; anything still waiting is
-- removed here rather than failing later at the transport boundary. Run with the collector stopped
-- so this window holds at most the current hour's digest.
DELETE FROM deliveries
WHERE status IN ('pending', 'sending')
  AND attempts = 0
  AND json_extract(destination_json, '$.signals') IS NULL;

DELETE FROM batch_targets
WHERE json_extract(destination_json, '$.signals') IS NULL;

UPDATE batches SET sealed = 1 WHERE sealed = 0;
