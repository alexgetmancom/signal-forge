/**
 * One card is one vote, whatever the card was about.
 *
 * A thumb is left under a delivery, and a delivery carries as many events as the batch put in it.
 * Every tally of the thumbs joined `scout_reactions` through `delivery_events` to `events` and then
 * summed `votes` and `against` over the rows that came back, so a single thumb under a digest was
 * counted once per event inside it. One 👎 under the twenty-two names `discovery:docs-anthropic`
 * found in a second read as twenty-two votes against: the newsroom-wide total said forty-two where
 * fourteen cards had been voted on, and `readersVote` -- which silences a source at two -- silenced
 * that one on the strength of a single tap.
 *
 * So the join still fans out, because the question "which source was this card about" can only be
 * answered through the events, but the counting happens one row per delivery. `DISTINCT` is enough
 * for that: `votes` and `against` are columns of `scout_reactions`, so they are the same on every
 * row a delivery produced, and a digest drawn from two sources is one vote for each of them -- the
 * reader did dislike both.
 */

/**
 * The deliveries that carry a thumb, one row each per distinct `key`, as a subquery.
 *
 * `key` is the cut being tallied -- `e.source`, `d.destination_id`, the signal class. The window
 * over `detected_at` is part of the fragment rather than the caller's `where`, because a tally of
 * the thumbs is always a tally over a period and a read of every event there has ever been is not
 * something a caller should be able to ask for by leaving an argument out; its placeholder binds
 * first, before anything `where` names. The caller's outer query reads `key`, `votes` and
 * `against`, and `COUNT(*)` over it is cards.
 */
export function votedDeliveries(key: string, where = "1"): string {
  return `SELECT DISTINCT ${key} key, r.delivery_id, r.votes votes, r.against against
            FROM scout_reactions r
            JOIN delivery_events de ON de.delivery_id = r.delivery_id
            JOIN deliveries d ON d.id = r.delivery_id
            JOIN events e ON e.id = de.event_id
           WHERE e.detected_at >= ? AND (${where})`;
}
