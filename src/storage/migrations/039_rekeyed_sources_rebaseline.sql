-- Three collectors change how they name or describe what they read, and each would otherwise speak
-- about the change of name rather than a change in the world.
--
-- `anthropic-sdk-releases` keyed a dated section by the first eighty characters of its text, so an
-- edit to a sentence was announced as a second release. It is now keyed by the date alone.
--
-- `deepseek-pricing` kept the footnote marker in a model's id (`deepseek-flash (1)`), so renumbering
-- a footnote would have removed a model and announced it again. The marker is no longer part of the id.
--
-- `models-dev` took a model's fields from whichever provider came first in the file. It now takes
-- them from a fixed order, and the one-time difference is not news.
--
-- Forgetting the stored rows and the last success makes the next collection of each a silent
-- baseline: nothing is announced, nothing is removed, and evidence already recorded is untouched.

DELETE FROM records WHERE source IN ('anthropic-sdk-releases', 'deepseek-pricing');
UPDATE sources SET last_success = NULL WHERE id IN ('anthropic-sdk-releases', 'deepseek-pricing', 'models-dev');
