-- The tier stored with a price row no longer carries the heading of the table it came from.
--
-- That heading is the name of a component in OpenAI's build: `Grouped Pricing Table data`. It tells
-- rows apart well, which is why it stays in the record id and the id is unchanged here, and it
-- reads as noise wherever an operator sees it. What is stored now is the mode, the modality and the
-- parenthesised ceiling, which is what the id was carrying the heading in order to separate.
--
-- Every one of the 216 price records changes a field without a vendor having changed anything, and
-- `persistCollection` emits neither `new` nor `changed` while a source has no `last_success`, which
-- is how every source's first collection is silent. 067 and 069 are the precedent.
--
-- No id moves, so nothing goes missing and the `removed` path -- which `last_success` does not
-- guard -- is not reached. Simulated over three polls against a copy of production: 0 events.

UPDATE sources SET last_success = NULL WHERE id = 'openai-pricing';
