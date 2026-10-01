import {
  leadingSeparator,
  trailingSeparator,
  type Segment
} from "./segment.ts"

/**
 * What a slot does with a separator it starts with.
 *
 * - `never`                strip nothing. The slot's text goes on the wire as
 *                          written.
 * - `when_same_separator`  strip ONE leading separator, and only when the
 *                          separator immediately before it SPELLS THE SAME
 *                          SEPARATOR.
 * - `when_preceded`        pt v1's rule: strip one leading `/` whenever anything
 *                          at all precedes. Kept so a v1 config can be reproduced
 *                          byte for byte, and documented as the wrong rule.
 */
export const STRIP_RULES = ["never", "when_same_separator", "when_preceded"] as const

export type StripRule = typeof STRIP_RULES[number]

/** One slot's contribution to a single payload. */
export interface AssemblySlot {
  readonly segment: Segment
  /** How many times this slot's text repeats. 1 for a slot without `repeat`. */
  readonly repeat: number
  readonly strip: StripRule
}

/**
 * Strip ONE separator off the front of `text`, if `rule` allows.
 *
 * `preceding` is everything already assembled, joined. Empty means nothing
 * precedes the slot at all, and then no rule strips: a bare `/etc/passwd` is an
 * absolute path and the leading slash is the payload.
 *
 * ## Why exactly one, and not all of them
 *
 * The preceding slot supplies ONE separator, so the target gives up ONE. Anything
 * beyond that is the author's deliberate choice and must survive, because a
 * DOUBLED junction is a technique in its own right -- the filter counts
 * separators, or collapses them only after it has checked:
 *
 *     target '/etc/passwd'    + '../' x3  ->  ../../../etc/passwd
 *     target '//etc/passwd'   + '../' x3  ->  ../../..//etc/passwd
 *     target '///etc/passwd'  + '../' x3  ->  ../../..///etc/passwd
 *     target '/etc/passwd'    + nothing   ->  /etc/passwd
 *
 * A greedy strip collapses all three targets onto the first payload, which is why
 * 205 of the 398 entries the harvest then held had to be routed to the verbatim
 * passthrough (templates/<category>/raw.txt): the doubled junction was simply not
 * expressible, at any target spelling. Non-greedy, it is -- with no schema change, because the extra
 * separator rides in the target's own text where its author put it.
 *
 * ## Why `when_same_separator` and not "whenever preceded"
 *
 * The strip exists for exactly one reason: to avoid emitting a doubled
 * separator. Two separators are only doubled if they are the SAME separator, and
 * `/` and `\` are not. pt v1 stripped whenever anything preceded, which is
 * correct for
 *
 *     ../     + /etc/passwd  ->  ../../../etc/passwd
 *     ..%2f   + /etc/passwd  ->  ..%2f..%2fetc/passwd      (same sep, encoded)
 *
 * and destroys
 *
 *     ..\     + /etc/passwd  ->  ..\..\..\/etc/passwd
 *
 * where the trailing `\` and the leading `/` are both meaningful -- a Win32-style
 * traversal landing on a POSIX-style absolute path, which 217 lines of the
 * verbatim passthrough do. Equivalence is decided by
 * `SEPARATOR_SPELLINGS`, so the encoded spellings collapse onto their literal and
 * the two separator identities stay apart.
 */
export const stripLeading = (
  text: string,
  preceding: string,
  rule: StripRule
): string => {
  if (text.length === 0 || preceding.length === 0) return text
  if (rule === "never") return text
  // One separator, here too: leaving v1's rule greedy would make the two rules
  // quietly disagree about what a second separator means.
  if (rule === "when_preceded") return text.replace(/^\//, "")

  const before = trailingSeparator(preceding)
  if (before === undefined) return text

  const lead = leadingSeparator(text)
  if (lead === undefined || lead.kind !== before.kind) return text
  return text.slice(lead.token.length)
}

/**
 * Build one payload as an array of Segments, one slot at a time, in slot order.
 *
 * The array is deliberately NOT joined here: the strategy stages downstream need
 * to know which bytes came from which slot, and whether each one may be rewritten
 * at all.
 *
 * Empty segments are dropped, so an `optional` slot's empty member costs nothing
 * downstream and a positional stage never has to skip past it.
 */
export const assemble = (slots: ReadonlyArray<AssemblySlot>): Array<Segment> => {
  const out: Array<Segment> = []
  let preceding = ""

  for (const slot of slots) {
    const repeated = slot.segment.text.length === 0 || slot.repeat === 1
      ? slot.segment.text
      : slot.segment.text.repeat(slot.repeat)
    const text = stripLeading(repeated, preceding, slot.strip)
    if (text.length === 0) continue
    // Reuse the member's own object when nothing changed, which is the common
    // case (no repeat, nothing stripped). `assemble` runs once per candidate
    // payload, so a copy avoided here is tens of thousands of objects not made.
    out.push(text === slot.segment.text ? slot.segment : { ...slot.segment, text })
    preceding += text
  }

  return out
}
