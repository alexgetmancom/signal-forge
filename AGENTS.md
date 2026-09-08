# Working agreement

One developer and operator. Work on main, no pull requests, compatibility shims or speculative layers.
English everywhere, with no exception. Code, comments, docs, commit messages, logs, error text,
operational and verification messages, and every word a subscriber reads: headers, field labels,
hashtags, stage descriptions, report pages. This product is for an English-speaking audience, so a
Russian string anywhere in `src/` is a defect — grep for Cyrillic before you push.

Timestamps are UTC. The operator's timezone means nothing to a reader in another country.

Some of those strings are stored inside `records.body` and compared byte for byte to decide whether
something changed — PR stages are the live example. Rewording one without migrating the stored rows
emits a "changed" event for every record carrying it. Migrate with the collector stopped.
Run `bun run check` before pushing. Tests target data loss, duplicate delivery and source parsing.
Only config.ts reads process.env. Validate external responses with Zod.
Register background work with the runtime supervisor. Never log credentials or request URLs containing them.
Snapshots, events and delivery jobs commit in one SQLite transaction.
A delivery with an uncertain external outcome is ambiguous, never automatically retried.
Never interpret a failed or malformed collection as an empty catalog.

# Boundaries

This service runs on `vm106` in `/opt/signal-forge` and nowhere else. Its blast radius stops there.

Never expose any part of it to the public internet. Reports and the API are LAN-only, bound to
`192.168.10.106`, and that binding is not an oversight to be improved.

Never touch another host. Not `tw-nl`, not `home-101`, not the Proxmox host — no Caddy or nginx
config, no DNS, no firewall, no `authorized_keys`, no routing, no Momo, no AWG or WARP. A change
that needs another machine is a change that needs the owner first.

Never create a systemd unit, a reverse SSH tunnel, a cron entry or anything else that survives a
reboot and that the owner did not ask for.

Publishing is outbound only. Reports reach the public through Solo Publisher's `/api/mcp` over
HTTPS with a bearer token — an outgoing request from this machine. Nothing listens for the outside,
nothing is proxied inward, no port is forwarded.

Stop and ask before anything the public can reach, anything that costs money, and anything that
would be awkward to undo. Asking costs a message; a public URL with no authentication costs trust.

If you stop mid-change, roll back what you already did before reporting. A half-applied change is
worse than both the old state and the new one, and the person reading your report cannot see which
half landed.
