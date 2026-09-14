-- The ledger records when weights were first published, not when this deployment noticed them.
--
-- Both readings answer "who was first" while the ledger only ever learns from its own sweeps, and
-- they disagree the moment it is seeded from the established catalogue: a model published in March
-- and read today would otherwise look younger than a copy of it recorded yesterday, and the copy
-- would keep the claim. The publication date is the property of the weights, so it is the one the
-- ledger keeps and the one an older claim wins by.

ALTER TABLE weight_totals RENAME COLUMN first_seen TO first_published;
