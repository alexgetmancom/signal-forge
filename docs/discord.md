# Discord delivery

Signal Forge currently delivers reader-facing signals to Discord. This document covers the
Discord-specific configuration and operational behavior that is intentionally kept out of the
project overview.

## Destination configuration

Set `DISCORD_BOT_TOKEN` in `.env` and configure destinations in
`signal-forge.json`:

```json
{
  "pollSeconds": 300,
  "destinations": [
    {
      "id": "discord-model-catalog",
      "platform": "discord",
      "channelId": "000000000000000000",
      "streams": ["api-models", "openrouter", "weights"]
    }
  ],
  "statusChannelId": "000000000000000000",
  "platformBoardChannelId": "000000000000000000",
  "alertChannelId": "000000000000000000",
  "vendorRoles": { "OpenAI": "000000000000000000" }
}
```

Replace the example IDs with the actual ones. Deploy after configuration changes. Destinations
receive future events only; the first source observation establishes a quiet baseline.

## Status boards

Two messages are edited in place instead of being reposted, so a channel holds a state rather than
a log. Both are rewritten only when their content actually changes. Deleting a board by hand makes
the next cycle post a fresh one, which is also how their order in the channel is fixed.

**Platform health** (`platformBoardChannelId`, defaulting to the status channel) shows what
OpenAI's and Anthropic's own status pages say, with their open incidents. Vendors that do not run
Statuspage are absent on purpose: `status.x.ai` refuses its own API, and Google publishes a
different document for the whole cloud.

**Tracker status** (`statusChannelId`) is about Signal Forge: every collector appears with a
colored dot and its last successful observation, edited in place every five minutes. The board also
shows delivery queue state and unavailable integrations. It is rewritten only when something
actually changed, so the channel holds a board rather than a log.

A blocked source is not a broken one. `gemini` answers everywhere except the addresses this
project can reach, so it shows as restricted with its cause instead of counting against the
headline. A board that calls every silence an outage teaches people to ignore it.

## Operational alerts

`alertChannelId` names a private channel that receives one message when a collector stops
reporting and one when it recovers, never a repeat while the same outage continues. This is
operational noise for the owner, not content for subscribers, so it does not go to a feed channel.
A rejected alert leaves the stored state untouched, so the next cycle retries rather than losing the
transition.

## Role mentions

`vendorRoles` maps a vendor, as `vendorOf()` resolves it, to the role that follows
that vendor. A role is pinged only when a model appears or disappears. A price edit travels in the
same message without waking anyone, and digests do not mention roles.

The permitted mention list names exactly the roles the message mentions, so a stray ID cannot ping.
Mentioning a role that is not "mentionable" requires the bot to hold *Mention @everyone, @here and
All Roles* in that channel; a channel that still inherits its category's permissions gets this
automatically.

## Permissions and channel checks

Discord destinations take a `channelId` and the same `streams` used by the event
pipeline. A bot only reaches a private category when its role is granted `VIEW_CHANNEL`
there. Creating channels additionally needs `MANAGE_CHANNELS`, which the bot does not have
and does not need for delivery.

Verify a new channel with one manual `POST /channels/<id>/messages` before relying on it.
A destination that cannot be written to only shows up as a failed delivery later.

## Timestamps

Discord messages carry `<t:unix:f>`, which every reader sees in their own timezone.
Timestamps stored by Signal Forge are UTC.

## Delivery behavior

Successful sends are never retried. HTTP 429 responses honor retry timing. An uncertain external
outcome is marked `ambiguous` and never automatically repeated; inspect the actual channel,
require manual delivery verification, and record the final outcome without sending again.

Full event evidence remains in SQLite even when a message excerpt is truncated. Small pricing
changes can remain recorded without generating a Discord alert when they do not cross the configured
notification thresholds.

## Telegram

Telegram delivery is implemented and tested but is not enabled in the production configuration.
Telegram has no Discord-style timestamp markup and receives a fixed UTC timestamp instead.
