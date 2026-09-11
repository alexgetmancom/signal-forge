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
      "id": "discord-new",
      "platform": "discord",
      "channelId": "000000000000000000",
      "signals": ["launch"]
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

## Signal classes

A destination subscribes to what its readers came for, not to the sources that happen to produce
it. Every event carries one class, derived from the same evidence its card is rendered from:

| Class | What it means | Examples |
| --- | --- | --- |
| `launch` | A reader can now use it, or can no longer use it | Official announcement, catalogue entry appearing or withdrawn, published release, mobile app release |
| `codename` | Something on its way, identity often unknown | Arena sighting, entry listed but not selectable, new page on a vendor site, new leaderboard key, retirement notice naming its successor |
| `evidence` | The raw trail for a reader who digs | Documentation and interface diffs, repository activity, package versions, a retirement notice with no successor |
| `change` | A number moved | Pricing, context, ranks, availability flags, edited announcements, incident updates, shifting deadlines |
| `reminder` | Derived operator work, not an observation | Lifecycle deadline reminders |

Only `launch` and `codename` carry a role mention. `change` reaches a reader through the hourly
digest. `reminder` is delivered only to a destination that asks for it by name, because a deadline
reminder is operator hygiene rather than news.

## Reader channels and status

The server keeps four reader-facing channels plus Status: New, Codenames, Evidence, and Changes.
The private `Signal Problem` channel is separate and is not a reader feed.

Three messages in Status are edited in place instead of being reposted, so the channel holds current
state rather than a growing log. They are rewritten only when their content actually changes.
Deleting a board by hand makes the next cycle post a fresh one, which is also how their order in the
channel is fixed.

**Activity** (`Status`) counts observed changes in the last 24 hours. Routine low-value changes may
be filtered from the reader feed or grouped into the hourly digest.

**Platform health** (`platformBoardChannelId`, defaulting to the status channel) shows what
OpenAI's and Anthropic's own status pages say, with their open incidents. Vendors that do not run
Statuspage are absent on purpose: `status.x.ai` refuses its own API, and Google publishes a
different document for the whole cloud.

**Tracker status** (`statusChannelId`) is about Signal Forge: every collector appears with a
colored dot and its last successful observation, edited in place every five minutes. Internal
delivery queue and credential details stay out of this public board; the operator can inspect them
through the operational interfaces.

A blocked source is not a broken one. `gemini` answers everywhere except the addresses this
project can reach, so it shows as restricted with its cause instead of counting against the
headline. A board that calls every silence an outage teaches people to ignore it.

## Operational alerts

`alertChannelId` points to the private `Signal Problem` channel. It receives one message when a
collector, worker, or delivery problem becomes actionable and one when it recovers, never a repeat
while the same problem continues. The alert includes the next diagnostic action and does not go to
a reader feed channel.
A known channel rejection leaves the transition failed, so the next cycle retries rather than losing
it. A transport failure or an unconfirmable response is recorded as an ambiguous alert outcome and
is never sent again automatically; verify the private channel before taking action.

## Reader message format

Discord cards put the change type in the title, keep the source and vendor in the author line, and
show confidence, evidence type, detection time, and reader impact in scan-friendly fields. The title
opens the source evidence. Stories keep one card for a related cross-source timeline, with a short
link for each independent source.

Routine changes arrive in an hourly digest. Vendor roles are mentioned only for immediate model
appearances or removals; digest messages never ping roles.

## Role mentions

`vendorRoles` maps a vendor, as `vendorOf()` resolves it, to the role that follows
that vendor. A role is pinged only when a model appears or disappears. A price edit travels in the
same message without waking anyone, and digests do not mention roles.

The permitted mention list names exactly the roles the message mentions, so a stray ID cannot ping.
Mentioning a role that is not "mentionable" requires the bot to hold *Mention @everyone, @here and
All Roles* in that channel; a channel that still inherits its category's permissions gets this
automatically.

## Permissions and channel checks

Discord destinations take a `channelId` and the signal classes the channel is for. A bot only reaches a private category when its role is granted `VIEW_CHANNEL`
there. Creating channels additionally needs `MANAGE_CHANNELS`, which the bot does not have
and does not need for delivery.

Verify a new channel with one manual `POST /channels/<id>/messages` before relying on it.
A destination that cannot be written to only shows up as a failed delivery later.

## Long evidence

A card shows the few changes a person can read at a glance. When a page rewrote hundreds of
strings, the rest used to end at a truncation notice and were reachable nowhere. Those changes now
travel with the message as a text file, so the card stays short and the evidence stays complete.
Telegram deliveries keep the truncation notice; attachments there are a different endpoint.

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
