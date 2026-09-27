import { z } from "zod";

export const recapContextSchema = z.object({
  // Absent in the recaps stored before a day could be summarised.
  period: z.enum(["week", "day", "news"]).default("week"),
  from: z.string(),
  to: z.string(),
  arrivals: z.array(z.object({ vendor: z.string(), names: z.array(z.string()) })),
  arrivalCount: z.number(),
  priceMoves: z.array(
    z.object({
      name: z.string(),
      percent: z.number(),
      cheaper: z.boolean(),
      // Dollars per million tokens, before and after. Absent in the recaps stored before a line
      // said what a reader would actually be charged.
      from: z.number().nullable().default(null),
      to: z.number().nullable().default(null),
      // Which of the quoted prices moved. Absent before the line said so.
      field: z.string().default(""),
      // Absent in the recaps already stored before this was told apart from a decision to charge more.
      discountEnded: z.boolean().default(false),
    }),
  ),
  codenameCount: z.number(),
  leaders: z.array(z.object({ board: z.string(), name: z.string() })).default([]),
  // Absent in the recaps stored before a week named what is going away.
  retirements: z.array(z.object({ name: z.string(), date: z.string().nullable() })).default([]),
  // A maker's own sentence about something going away, when it said so in a changelog rather than
  // in a lifecycle table. Absent in the recaps stored before the two were told apart.
  retirementNotes: z.array(z.string()).default([]),
  // Absent in the recaps stored before a day's official news was listed.
  headlines: z
    .array(
      z.object({
        vendor: z.string(),
        title: z.string(),
        url: z.string().nullable(),
        // Absent in the news stored before the day was read in sections.
        topic: z.enum(["safety", "research", "other"]).default("other"),
        // Lines past the maker's share, counted rather than listed.
        more: z.number().default(0),
        // Whether a lab said this itself. A front-page story is somebody else talking about a lab,
        // and under "Also from the labs" it read as the lab's own post. Absent before the two were
        // told apart; the recaps stored then were all desks.
        desk: z.boolean().default(true),
        // What a safety or research post found, in a sentence. Absent before the day was read for it.
        summary: z.string().nullable().default(null),
      }),
    )
    .default([]),
  // Absent in the recaps stored before the scouts were told about climbs and new boards.
  climbers: z.array(z.object({ board: z.string(), name: z.string(), from: z.number(), to: z.number() })).default([]),
  newBoards: z.array(z.object({ board: z.string(), leader: z.string().nullable() })).default([]),
  resellerArrivals: z
    .array(
      z.object({
        name: z.string(),
        reseller: z.string(),
        // Who made it, when the catalogue says. Absent before the line named anyone but the shop.
        maker: z.string().default(""),
        // The other shops that listed the same model the same day. Absent before one line covered
        // them all, when a second shop read as a second launch.
        alsoOn: z.array(z.string()).default([]),
        // Rows this line stands for beyond one per shop: the dated snapshots and billing tiers the
        // catalogue wrote about a model it had already written about.
        variants: z.number().int().nonnegative().default(0),
      }),
    )
    .default([]),
  // Commits worth a line, as a sentence each. Absent before the repositories were read for them.
  codeNotes: z.array(z.object({ repo: z.string(), text: z.string() })).default([]),
  // Absent in the recaps stored before the Intelligence Index was read for new entries.
  indexed: z.array(z.object({ name: z.string(), index: z.number(), place: z.number().nullable() })).default([]),
});
export type RecapContext = z.infer<typeof recapContextSchema>;
