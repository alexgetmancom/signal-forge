# Discord delivery

Reader-facing signals go to Discord. This is the Discord-specific configuration and behaviour kept
out of the project overview.

## Destination configuration

Set `DISCORD_BOT_TOKEN` in `.env` and the destinations in `signal-forge.json`:

```json
{
  "pollSeconds": 300,
  "destinations": [
    { "id": "discord-signals", "platform": "discord", "channelId": "000000000000000000", "signals": ["launch"] }
  ],
  "statusChannelId": "000000000000000000",
  "platformBoardChannelId": "000000000000000000",
  "alertChannelId": "000000000000000000",
  "vendorRoles": { "OpenAI": "000000000000000000" },
  "allSignalsRole": "000000000000000000",
  "promotion": { "ownerUserId": "0", "ownerEmoji": "✅", "readerEmoji": "👍", "readerVotes": 3 }
}
```

Deploy after a configuration change. A destination receives future events only: the first
observation of a source establishes a quiet baseline.

## Signal classes

A destination subscribes to what its readers came for, never to the sources that produced it. Every
event carries one class, derived from the evidence its card is rendered from:

| Class | What it means | Examples |
| --- | --- | --- |
| `launch` | A reader can now use a model, or can no longer use it | Catalogue entry appearing or withdrawn, weights published, usage limits coming back, an outage the vendor calls severe |
| `codename` | Something on its way, identity often unknown | Arena sighting, entry listed but not selectable, new page on a vendor site, new leaderboard key, retirement notice naming its successor |
| `release` | Software shipped around the models | App versions, CLI and SDK releases, changelog entries |
| `article` | What a vendor chose to say | Research, policy, hiring, customer stories, engineering write-ups |
| `evidence` | The raw trail for a reader who digs | Documentation and interface diffs, repository activity, package versions, a retirement notice with no successor |
| `rank` | A place on a scoreboard moved | Leaderboard positions and scores |
| `change` | A number moved | Pricing, context, availability flags, edited announcements |
| `incident` | An outage the vendor did not grade severe | Everything the Platform health board already shows |
| `reminder` | Derived operator work, not an observation | Lifecycle deadline reminders |

A newsroom is not a release feed, so a vendor's post is an `article` whatever it announces: every
vendor mixes releases with research and customer stories, and Anthropic grades nine posts in ten as
"Announcements". Nothing is lost by not reading the prose — a model a reader can use appears in the
vendor's own catalogue, and that is where the launch is observed. Changelogs are the exception and
are `release`.

Only `launch` and `codename` mention a role. `change` reaches a reader through the hourly digest.
`reminder` and `incident` go only to a destination that asks for them by name: a deadline reminder
is operator hygiene, and a routine outage is already on the Platform health board. An outage the
vendor itself calls major or critical is a `launch`, because it is the one incident a reader must
act on the moment it happens.

## Reader channels and status

`🚀signals` is public and carries `launch` and `change`: availability, limits coming back and severe
outages arrive within a poll and mention the vendor role, while prices travel in the hourly digest
without waking anyone. `🕵scouts` is invited-only and carries what is early or small — `codename`,
`release`, `article`, `evidence`, `rank`. `📡status` is opt-in through a role, and `Signal Problem`
is private. The split is what a reader is owed, not what a collector produced: a public channel that
also carried arena rumours and iOS point releases would be muted within a week, and the mention that
matters would go with it.

Four status messages are edited in place rather than reposted, so the channel holds current state
instead of a growing log. Deleting a board by hand makes the next cycle post a fresh one, which is
also how their order is fixed.

- **Activity** (`Status`): observed changes in the last 24 hours.
- **Platform health** (`platformBoardChannelId`): what the OpenAI, Anthropic, DeepSeek and Moonshot
  status pages report, with open incidents. Vendors without Statuspage are absent on purpose —
  `status.x.ai` refuses its own API and Google publishes one document for the whole cloud.
- **Filtered out** (`platformBoardChannelId`): what the notification policy stopped in 24 hours,
  grouped by the rule, beside what actually reached a channel. A filter tuned too tight otherwise
  shows up as nothing at all; `suppressions` lists the individual decisions.
- **Tracker status** (`statusChannelId`): every collector with a coloured dot and its last
  successful observation, edited every five minutes. A blocked source is not a broken one —
  `gemini` shows as restricted with its cause, because a board that calls every silence an outage
  teaches people to ignore it.

## Promotion from the invited room

Whether an unnamed arena entry deserves a public reader's attention is a judgement no rule here can
make. The room makes it: `readerVotes` readers pressing `readerEmoji` carry a message into
`🚀signals`, and one press of `ownerEmoji` by `ownerUserId` settles it alone.

What travels is the message, not the event — the card was rendered when the observation was made,
and re-deriving it a day later against records that have moved would publish something nobody
approved. A promotion never mentions a role. Reactions are read, never listened for: one request per
cycle lists recent messages with their counts, and only a message already carrying the owner's emoji
costs a second request to ask who pressed it. Nothing listens on a port. `promoted_deliveries`
records what travelled, so a vote counted twice cannot post twice.

## What never becomes a card

Every suppression is written down with the rule that stopped it and the same decision in a reader's
words; `suppressions` lists them and the Filtered out board counts them.

- **A tier, an alias, a dated snapshot or a republished quantisation.** A catalogue lists one model
  many times; counted as launches they turned a week with nine models in it into a week with
  thirty-seven. `variants.ts` reads what the catalogue called the entry. A name that says nothing
  about its maker is left alone rather than guessed at, because a wrong call deletes a real launch.
- **A board move outside the leading three.** Entering a benchmark at rank 2 speaks; entering at
  rank 5, or sliding from 6 to 7, does not. Taking first place always speaks, and so does losing it.
- **Another serving of a model already identified here.** `kimi-k3-gateway-max-v3` is Kimi K3 through
  a gateway at maximum thinking effort with the third harness. A known model followed only by
  serving words — gateway, official, proxy, max, a harness number — is that model.
- **A change of label and nothing else**, such as OpenRouter prefixing its own titles with the
  vendor. An arena is the exception: a codename acquiring a real name is the point of watching one.
- **An alias row.** `~deepseek/deepseek-v4-flash-latest` is a promise to route to whichever build is
  newest, and its every move repeats a card the model behind it already produced.
- **A re-keyed record.** A source that renames its rows emits the same record twice, once leaving
  and once arriving; DeepSeek's pricing table did that on 10 September and one of the numbered rows
  it produced was a model from the spring. Both halves are quiet when the bodies match byte for byte
  with the key fields removed. When the bodies differ — a new version, new prices — it is a release
  wearing a reused name and it speaks.

The Hugging Face engineering blog is in shadow for the same reason: it keeps collecting, because a
release post could appear there, and it no longer interrupts anyone.

## Continuations

A card that continues something this channel already reported is sent as a reply to the message that
reported it, so a codename resolving into a real model carries a jump back to the sighting. Two
things count: the same story, and the same record seen again. `delivery_events` records which
message carried which event, written when a page is built rather than inferred from batch membership
— which is wrong as soon as a batch pages into two messages. Only a sent message is referenced, and
only the earliest one. There is no backfill: a link to the wrong message is worse than no link.

## The weekly recap

One message a week in `🚀signals` after the most recent Sunday 18:00 UTC — late enough that Sunday is
over in the Americas, early enough for Monday morning in Asia. It is a batch with its own kind, so
it is rendered, delivered and retried by the same machinery as every card, and its identity is the
period it covers: one row per week, enforced by an index. A week with nothing in it produces no
message.

**Arrivals** are grouped by maker, up to six makers with the rest counted. An arrival is narrower
than an event: billing tiers, aliases, dated snapshots, numbered duplicate rows, somebody else's
quantisation and a training checkpoint are not releases. A registry says what an artefact is — one
that declares no inference pipeline, or declares the model it was fine-tuned from, is published work
rather than a launch. A row that exists only in a reseller's catalogue under a maker this tracker
does not follow is left out; adding a maker to that table is one line.

**Price lines**, three at most, are what a reader is billed — prompt and completion, never a
cached-read rate — measured as the week's net move against the price charged before, so a rise reads
as the multiple it is. A subject whose rows or fields moved in both directions carries no line:
nothing in the data says which half was the news. Lines are ordered by how heavily a model is
actually used, from `openrouter-usage`, and spent only on models a benchmark, an arena or the
maker's own API knows. A rise within three months of a row appearing is reported as the launch
promotion ending.

**Names** are printed the way a reader says them: `gpt-image-2.5-flare` reads back as GPT Image 2.5
Flare, while an arena codename and a repository id keep their exact characters, because those are
what somebody searches for.

The invited room gets no recap: the scouts saw every one of these events as it happened.

## Operational alerts

`alertChannelId` is the private `Signal Problem` channel. One message when a collector, worker or
delivery problem becomes actionable, one when it recovers, never a repeat in between, and never in a
reader channel. A failed or ambiguous delivery is one of those: nothing retries them, so without an
alert a message that will never arrive looks exactly like a quiet week — which is how a 403 on the
public channel went unnoticed for a day. The alert carries the platform's own words, so "403 Missing
Permissions" points at the channel's permissions rather than at the database. A failed row stops
being actionable once that destination has sent something after it; an ambiguous one never does,
because somebody has to go and look.

A known channel rejection leaves the alert failed so the next cycle retries. A transport failure or
an unconfirmable response is ambiguous and is never sent again automatically.

## Reader message format

The change type is in the title, source and vendor in the author line, and the body opens with how
solid the observation is before what it means — "Seen in a reseller's catalogue, not announced by
the maker" rather than a footer reading "Confidence: observed". The sentence is keyed on evidence
type, which is a source contract rather than a judgement. When a different source family carried the
same story first, the card opens with how long ago and which one: "Traced 18 hours earlier · npm
@openai/codex". Only another family counts, and an hour is the floor, because two sources polled
minutes apart are simultaneous to a reader. The footer keeps the machine-readable labels; the title
opens the evidence. A story is one card with a short link per independent source.

Routine changes arrive in an hourly digest, capped at five stories with the rest counted in the
header: ten cards is what Discord allows in a message, not what a person reads. A price moving by a
quarter or more is delivered on sight, unless the row is a tier rather than a model.

Long evidence travels as a text file rather than a truncation notice, so the card stays short and
the evidence stays complete. Telegram keeps the notice; attachments there are a different endpoint.

Messages carry `<t:unix:f>`, which every reader sees in their own timezone. Everything stored is UTC.

## Roles, permissions and delivery

`vendorRoles` maps a vendor, as `vendorOf()` resolves it, to the role that follows it, with
`allSignalsRole` beside them for readers who follow everything. A role is pinged only when a model
appears or disappears; digests never ping. The permitted-mention list names exactly the roles the
message mentions, so a stray ID cannot ping. Mentioning a role that is not "mentionable" needs
*Mention @everyone, @here and All Roles* in that channel, which a channel inheriting its category's
permissions gets automatically.

A bot reaches a private category only when its role holds `VIEW_CHANNEL` there. Verify a new channel
with one manual `POST /channels/<id>/messages`; a destination that cannot be written to otherwise
shows up as a failed delivery later.

Successful sends are never retried, HTTP 429 honours retry timing, and an uncertain outcome is
`ambiguous`: inspect the channel, require manual verification, record the outcome without sending
again. Full evidence stays in SQLite even when a message excerpt is truncated.

## Telegram

Implemented and tested, with no configured destination — the audience is on Discord. Telegram has no
timestamp markup and receives a fixed UTC stamp.
