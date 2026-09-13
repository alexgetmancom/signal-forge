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
  "vendorRoles": { "OpenAI": "000000000000000000" },
  "allSignalsRole": "000000000000000000"
}
```

Replace the example IDs with the actual ones. Deploy after configuration changes. Destinations
receive future events only; the first source observation establishes a quiet baseline.

## Signal classes

A destination subscribes to what its readers came for, not to the sources that happen to produce
it. Every event carries one class, derived from the same evidence its card is rendered from:

| Class | What it means | Examples |
| --- | --- | --- |
| `launch` | A reader can now use a model, or can no longer use it | Catalogue entry appearing or withdrawn, weights published, usage limits coming back, an outage the vendor calls severe |
| `codename` | Something on its way, identity often unknown | Arena sighting, entry listed but not selectable, new page on a vendor site, new leaderboard key, retirement notice naming its successor |
| `release` | Software shipped around the models | Mobile and desktop app versions, CLI and SDK releases, entries in a tool's changelog |
| `article` | What a vendor chose to say | Research, policy, hiring, customer stories, engineering write-ups |
| `evidence` | The raw trail for a reader who digs | Documentation and interface diffs, repository activity, package versions, a retirement notice with no successor |
| `change` | A number moved | Pricing, context, ranks, availability flags, edited announcements |
| `incident` | An outage the vendor did not grade severe | Everything the Platform health board already shows |
| `reminder` | Derived operator work, not an observation | Lifecycle deadline reminders |

A newsroom is not a release feed, so a vendor's post is an `article` whatever it announces: every
vendor mixes releases with research, policy and customer stories under one heading, and Anthropic
grades nine posts out of ten as "Announcements". Nothing is lost by not reading the prose, because a
model a reader can use appears in the vendor's own catalogue, and that is where the launch is
observed. The remaining eleven sources in the `news` stream are changelogs, where a new entry does
mean something shipped, and they are `release`.

Only `launch` and `codename` carry a role mention. A message mentions the vendor roles its cards
are about, and `allSignalsRole` beside them for readers who follow everything rather than one
vendor. `change` reaches a reader through the hourly
digest. `reminder` and `incident` are delivered only to a destination that asks for them by name: a
deadline reminder is operator hygiene rather than news, and a routine outage is already on the
Platform health board. An outage the vendor itself calls major or critical is a `launch` instead,
because it is the one incident a reader has to act on the moment it happens, and it travels with
everything else that has to interrupt.

## Reader channels and status

One channel is public and one is not. `🚀signals` (`launch`, `change`) is the wire: a model
becoming available, usage limits coming back and a severe outage arrive within a poll and mention
the vendor's role, while prices and ranks travel in the hourly digest without waking anyone.
`🕵scouts` (`codename`, `release`, `article`, `evidence`) is open to invited readers only and
carries what is early or small: arena sightings, pages that appear before an announcement, app and
CLI versions, vendor posts, documentation diffs and package versions. `📡status` is opt-in through
a role, and `Signal Problem` stays private.

The split is what a reader is owed rather than what a collector produced. A public channel that
also carried arena rumours and iOS point releases would be muted within a week, and the mention
that matters would go with it.

Four messages in Status are edited in place instead of being reposted, so the channel holds current
state rather than a growing log. They are rewritten only when their content actually changes.
Deleting a board by hand makes the next cycle post a fresh one, which is also how their order in the
channel is fixed.

**Activity** (`Status`) counts observed changes in the last 24 hours. Routine low-value changes may
be filtered from the reader feed or grouped into the hourly digest.

**Platform health** (`platformBoardChannelId`, defaulting to the status channel) shows what
the OpenAI, Anthropic, DeepSeek and Moonshot status pages report, with their open incidents.
Vendors that do not run Statuspage are absent on purpose: `status.x.ai` refuses its own API, and
Google publishes a different document for the whole cloud.

**Filtered out** (`platformBoardChannelId`, defaulting to the status channel) counts what the
notification policy stopped in the last 24 hours, grouped by the rule that stopped it, beside the
number of events that actually reached a channel. A filter tuned too tight otherwise shows up as
nothing at all. `suppressions` in the CLI lists the individual decisions, each with the reason it
carries.

**Tracker status** (`statusChannelId`) is about Signal Forge: every collector appears with a
colored dot and its last successful observation, edited in place every five minutes. Internal
delivery queue and credential details stay out of this public board; the operator can inspect them
through the operational interfaces.

A blocked source is not a broken one. `gemini` answers everywhere except the addresses this
project can reach, so it shows as restricted with its cause instead of counting against the
headline. A board that calls every silence an outage teaches people to ignore it.

## The weekly recap

One message a week in `🚀signals`, posted after the most recent Sunday 18:00 UTC: what arrived, the
three steepest price moves, and how many early sightings the scouts saw before any announcement.
Late enough that Sunday is over in the Americas, early enough to be there for Monday morning in
Asia.

It is a batch with its own kind rather than a second sender, so it is rendered, delivered, retried
and verified by the same machinery as every card. Its identity is the period it covers -- one row
per week, enforced by a unique index -- so a cycle that runs twice cannot post it twice, and a week
in which nothing arrived, nothing moved and nothing was sighted produces no message at all.

The invited room does not get one. Scouts see every one of these events as it happens.

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
lead the body with how solid the observation is before what it means — "Seen in a reseller's
catalogue, not announced by the maker" rather than a footer reading "Confidence: observed". The
sentence is keyed on evidence type, which is a source contract rather than a judgement, and it never
claims more than the source proves. When a different kind of source carried the same story first,
the card opens with how long ago and which one -- "Traced 18 hours earlier · npm @openai/codex".
Only another source family counts, so a collector seeing its own record twice never reads as a
lead, and an hour is the floor because two sources polled minutes apart are simultaneous to a
reader. The footer keeps the machine-readable source, evidence type and
confidence for anyone digging. The title
opens the source evidence. Stories keep one card for a related cross-source timeline, with a short
link for each independent source.

Routine changes arrive in an hourly digest, except a price that moves by a quarter or more, which
is the news rather than budget planning and is delivered on sight. Vendor roles are mentioned only for immediate model
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
