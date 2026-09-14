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
| `rank` | A place on a scoreboard moved | Leaderboard positions and scores |
| `change` | A number moved | Pricing, context, availability flags, edited announcements |
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

## Promotion from the invited room

Everything in `🕵scouts` is early, and whether an unnamed arena entry deserves a public reader's
attention is a judgement no rule here can make. The room makes it with reactions: `readerVotes`
readers pressing `readerEmoji` carry a message into `🚀signals`, and one press of `ownerEmoji` by
`ownerUserId` settles it alone.

```json
"promotion": {
  "ownerUserId": "000000000000000000",
  "ownerEmoji": "✅",
  "readerEmoji": "👍",
  "readerVotes": 3
}
```

What travels is the message, not the event: the card was rendered when the observation was made,
with the evidence and the standing sentence that were true then, and re-deriving it a day later
against records that have moved would publish something nobody approved. A promotion never mentions
a role -- the room has already decided, and the observation is still an early one.

Reactions are read, never listened for. One request every five minutes lists the room's recent
messages with their counts, and only a message that already carries the owner's emoji costs a second
request to ask who pressed it, so somebody else pressing it is not the owner. Nothing listens on a
port and no socket is held open. `promoted_deliveries` records what has travelled, so a vote counted
twice cannot post twice.

## Tiers, aliases and republished weights

A catalogue lists one model many times: a batch tier, a free tier, a `latest` alias that follows the
newest build, and a dated snapshot of the build it followed yesterday. Each arrives as its own
record with its own price, and counted as launches they turned a week with nine models in it into a
week with thirty-seven. `variants.ts` reads what the catalogue itself called the entry and sets
those aside, folds the same model seen by three collectors into one, and leaves a republished
quantisation -- `nvidia/Qwen3.8-27B-NVFP4` is Alibaba's model, not NVIDIA's launch -- out of the
count. A name that says nothing about its maker is left alone rather than guessed at, because a
wrong call there deletes a real launch from the week.

## Continuations

A card that continues something this channel already reported is sent as a reply to the message that
reported it, so a codename resolving into a real model carries a jump back to the sighting instead
of repeating it. Two things count as a continuation: the same story, and the same record seen again
-- `spicy-mayo` becoming `Gemini 4 Ultra` is a new subject and so a new story, while the arena entry
it was observed in never changed.

`delivery_events` records which message carried which event, written when a page is built rather
than inferred afterwards from batch membership, which is wrong as soon as a batch pages into two
messages. Only a message that was actually sent is referenced, and only the earliest one, so a
thread grows from the first word rather than from the last. There is no backfill: a link to the
wrong message is worse than no link.

## The weekly recap

One message a week in `🚀signals`, posted after the most recent Sunday 18:00 UTC: what arrived, the
three steepest price moves, and how many early sightings the scouts saw before any announcement.
Late enough that Sunday is over in the Americas, early enough to be there for Monday morning in
Asia.

It is a batch with its own kind rather than a second sender, so it is rendered, delivered, retried
and verified by the same machinery as every card. Its identity is the period it covers -- one row
per week, enforced by a unique index -- so a cycle that runs twice cannot post it twice, and a week
in which nothing arrived, nothing moved and nothing was sighted produces no message at all.

Arrivals are read back by maker rather than as a list of handles: one line per vendor, up to six
makers, the rest counted. What counts as an arrival is narrower than what counts as an event -- a
billing tier, a `latest` alias, a dated snapshot, a numbered row the collector had to disambiguate,
somebody else's quantisation and a training checkpoint published beside the model it trained are all
real records and none of them is a release. A registry carries more than releases, and it says so itself: an artefact that declares no
inference pipeline (a parametric 3D head model) or declares the model it was fine-tuned from is
published work and not a launch. A price line is what a reader is billed -- prompt and completion,
never a cached-read rate -- read against the price charged before, so a rise reads as the multiple
it is rather than a percentage of the bigger number. A subject whose rows or fields moved in both
directions in the same week carries no price line at all: a standard row falling to a discounted
rate while its preview row rises off one is catalogue bookkeeping, and nothing in the data says
which half was the week's news.

Names are printed the way a reader says them: a
catalogue handle such as `gpt-image-2.5-flare` is read back as GPT Image 2.5 Flare, while an Arena
codename and a repository id keep their exact characters, because those are what somebody searches
for.

The invited room does not get one. Scouts see every one of these events as it happens.

## Operational alerts

`alertChannelId` points to the private `Signal Problem` channel. It receives one message when a
collector, worker, or delivery problem becomes actionable and one when it recovers, never a repeat
while the same problem continues. A delivery that failed or came back ambiguous is one of those: it
is never retried automatically, so without an alert a message that will never reach the channel
looks exactly like a quiet week -- which is how a 403 on the public channel went unnoticed for a
day. The alert carries the platform's own words, so "403 Missing Permissions" points at the
channel's permissions rather than at the database. A failed row stops being actionable once that
destination has sent something after it: the channel answered the question. An ambiguous one never
does, because somebody has to go and look. The alert includes the next diagnostic action and does not go to
a reader feed channel.
A known channel rejection leaves the transition failed, so the next cycle retries rather than losing
it. A transport failure or an unconfirmable response is recorded as an ambiguous alert outcome and
is never sent again automatically; verify the private channel before taking action.

## A re-keyed catalogue

A source that renames its rows emits the same record twice: the row that left and an identical row
that arrived under another key. DeepSeek's pricing table did exactly that on 10 September, and one
of the two numbered rows it produced was a model from the spring. Both halves are quiet when the
bodies match byte for byte with the key fields removed, recorded as `renamed_by_the_source`, and
neither reaches a reader. When the bodies differ -- a new version, new prices -- it is a release
wearing a reused name and it speaks, which is how `deepseek-flash` stayed in the week it launched.

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

Routine changes arrive in an hourly digest, capped at five stories a message with the rest counted
in the header: ten cards is what Discord allows in one message, not what a person reads. A price
that moves by a quarter or more is delivered on sight instead -- unless the row is a tier rather
than a model, because a batch tier costing half the standard one is not a price cut. Vendor roles are mentioned only for immediate model
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
