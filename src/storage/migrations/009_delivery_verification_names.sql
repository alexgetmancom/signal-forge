ALTER TABLE deliveries RENAME COLUMN confirmation_source TO verification_source;
ALTER TABLE deliveries RENAME COLUMN reconcile_attempts TO verification_attempts;
ALTER TABLE deliveries RENAME COLUMN last_reconcile_error TO last_verification_error;
