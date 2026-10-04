/**
 * Catalogues that copy other catalogues.
 *
 * models.dev lists what Vercel and OpenRouter list within hours, so on 2026-09-19 it made
 * Mixedbread's Toast, Quiver's Arrow and Unbiased's Pareto look like breakouts; TrueFoundry's Azure
 * catalogue republishes a list Azure already published. Neither chose to host anything, so neither
 * is a second place a reader can call a model, and neither is a second organisation noticing it.
 *
 * The set lives here because two rules act on it and they had drifted apart: `breakouts` held
 * models.dev alone and `witness` held both, so one source was a mirror in one reading of the word
 * and a host in the other. The registry had already settled the question in a third place --
 * `shadowByDefault` calls them "two aggregators of other people's catalogues" in one breath -- and
 * the measurements agree: over the 30 days to 2026-10-04 truefoundry-azure duplicated harder than
 * models.dev did (0.92 against 0.719), with 4 unique stories out of 50 and no confirmed lead. Three
 * of those four were old models and the fourth was `provider-config`, a configuration key read as a
 * model.
 *
 * `corroboration` deliberately does not use this. Its threshold counts organisations that recorded
 * a subject, not places a reader can reach it, and the case it was built for -- Step 5 Preview on
 * 2026-09-19 -- was Artificial Analysis, the Vercel gateway and models.dev copying the listing.
 * Excluding mirrors there would raise a threshold of three to a threshold of four and silence the
 * one subject the feature exists for.
 */
const MIRRORS = new Set(["models-dev", "truefoundry-azure"]);

/** Whether this source only republishes a catalogue somebody else already published. */
export function isMirror(source: string): boolean {
  return MIRRORS.has(source);
}
