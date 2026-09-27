-- `shipped` was a product state wearing a confidence label, and it outranked confirmation.
--
-- The scale is how well the evidence holds: `observed` is one sighting, `supported` is the maker's
-- own words, `confirmed` is the provider answering for its own product. `shipped` sat above all
-- three, so an npm release ranked stronger than the vendor documentation that announced the same
-- thing -- and `modelFacts.stronger` picked fields by that rank, meaning a registry entry beat a
-- first-party catalogue on nothing more than being a registry. Both are the maker answering for
-- itself. They differ in where the subject is in its life, which is now `lifecycleState` in
-- src/events/lifecycleState.ts: a pure function of evidence type and stream, and no column, because
-- every input it reads is already on the row.
--
-- 306 events, 59 stories and their model fact fields carried the label. They become `confirmed`,
-- which is what the source always established; nothing they proved is lost, and what they said
-- about the product is now derived on read for every row in history rather than for these alone.
--
-- The CHECK constraints keep listing 'shipped'. SQLite cannot narrow one without rebuilding the
-- table, and `events` is the parent of three foreign keys; rebuilding it to forbid a value that no
-- code can now produce would trade a real risk for a redundant guard. `Confidence` in
-- src/events/types.ts is the narrower of the two and the one every writer goes through.

UPDATE events SET confidence = 'confirmed' WHERE confidence = 'shipped';
UPDATE stories SET confidence = 'confirmed' WHERE confidence = 'shipped';
UPDATE model_fact_fields SET confidence = 'confirmed' WHERE confidence = 'shipped';

-- The rewrite moves rows between two of the three values this column takes, and the planner's
-- stored distribution for it is now wrong everywhere it is filtered on.
ANALYZE;
