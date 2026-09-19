---
name: draft-from-evidence
description: Draft a publication from signal-forge stories and events. Use when work here feeds a post, card or article — reading stories, checking evidence, preparing a draft handoff.
---

The evidence leads and the prose follows. Read `stories` with a window, a vendor and a confidence
floor, then fetch each event by id and inspect its before/after evidence and source URL.

- `observed`, `supported`, `confirmed` and `shipped` are source-derived metadata, never an invitation
  to infer certainty from prose.
- `codename`, `alias`, `unconfirmed` and `unknown` are unresolved identity, never an official name.
- A story whose evidence does not support a reader-facing claim is returned with the reason for
  stopping, not upgraded.

A draft handoff carries a proposed title and summary, the story and event ids, source names,
confidence labels and evidence URLs, the before/after facts behind each claim, and the ambiguity a
person still has to decide.

Draft only: publication, scheduling and any external send stay behind a separate explicit approval.
Never invent a Solo Publisher URL, call its database, or retry an ambiguous delivery.
