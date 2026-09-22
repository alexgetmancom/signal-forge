-- Who reacted to what in Telegram, and where the bot stopped reading.
--
-- Discord answers "how many 👍 are under this message" whenever it is asked. Telegram does not: it
-- tells an admin bot each change as it happens -- this person now has 👍 on that post, those
-- anonymous readers now count five -- and forgets it once read. The rows are the running state
-- those changes add up to, and `scout_reactions` gets the totals, beside Discord's.
--
-- `actor` is the person, or 0 for Telegram's anonymous count, whose `count` is the whole number.

CREATE TABLE telegram_reactions (
  chat_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  actor INTEGER NOT NULL,
  emoji TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(chat_id, message_id, actor, emoji)
);

CREATE TABLE telegram_cursor (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  next_update INTEGER NOT NULL
);
