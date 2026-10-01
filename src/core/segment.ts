/**
 * Segment model and the primitive rewrites the strategy stages are built from.
 *
 * This module is intentionally free of any Effect / IO / Node dependency so the
 * generator core stays pure, portable and trivially testable.
 */

/**
 * The slot a synthetic segment belongs to.
 *
 * Synthetic segments are the ones a strategy created rather than read from a
 * file: a `padding:N` run, or the single blob a `base64` stage collapses a run
 * into. `synthetic` is a RESERVED slot name -- `config.ts` refuses to let a user
 * declare a slot called that -- so `segment.slot === SYNTHETIC` is unambiguous.
 */
export const SYNTHETIC = "synthetic"

/** Where a segment's text came from. Absent for synthetic and empty members. */
export interface Origin {
  /** Absolute path of the file the line was read from. */
  readonly file: string
  /** 1-based line number inside that file, counting comments and blanks. */
  readonly line: number
}

/**
 * A single piece of an assembled payload.
 *
 * `slot` is the name of the config slot the segment came from. It replaces v1's
 * fixed `role` union: once slots are first-class there is no separate notion of
 * a role, just the name the user gave the slot.
 *
 * `transform` records whether a stage may rewrite these bytes. It is the slot's
 * `transform` property, possibly flipped by a leading `!` on the line itself.
 * The flag travels with the segment through assembly and through every stage, so
 * protection stays *per segment* rather than per payload.
 *
 * `origin` is provenance: the file and line this text was read from. It is what
 * lets `--dry-run` attribute marginal contribution to INPUTS and not only to
 * strategies, and what lets an error message name the line that caused it.
 */
export interface Segment {
  readonly text: string
  readonly transform: boolean
  readonly slot: string
  readonly origin?: Origin
}

/** Sentinel used for the empty member of an `optional` slot. */
export const emptySegment = (slot: string): Segment => ({
  text: "",
  transform: false,
  slot
})

/** A segment a stage invented. Always rewritable, never attributable to a line. */
export const syntheticSegment = (text: string): Segment => ({
  text,
  transform: true,
  slot: SYNTHETIC
})

/** Default characters that a `url_encode` stage percent-escapes. */
export const DEFAULT_URL_ENCODE_CHARSET = "./\\"

/** The characters the separator-respelling and `selective_*` stages act on. */
export const SEPARATORS = "/\\"

// ---------------------------------------------------------------------------
// Separator identity
// ---------------------------------------------------------------------------

/** The two separator identities pt distinguishes. */
export type SeparatorKind = "/" | "\\"

/**
 * Every spelling pt treats as the SAME separator as `/` or `\`.
 *
 * This table is what makes `strip_leading_separator: when_same_separator`
 * correct rather than merely plausible. The strip exists to avoid a DOUBLED
 * separator, so it must fire only when the two separators either side of a slot
 * boundary are the same separator -- and `..%2f` + `/etc/passwd` is the same
 * separator written two ways, while `..\` + `/etc/passwd` is two different ones
 * that both carry meaning on the wire.
 *
 * Without the decode-aware rows, `..%2f` + `/etc/passwd` would stop stripping
 * and regress to `..%2f..%2f/etc/passwd`. With the whole table collapsed to one
 * class, `..\..\..\` + `/etc/passwd` would lose its `/`.
 *
 * The minimum the rule needs is
 *
 *     "/"  == %2f  == %252f  == %c0%af
 *     "\"  == %5c  == %255c  == %c1%9c
 *
 * plus the triple-encoded and fullwidth spellings, which are the same technique
 * one layer further out and which pt's own `url_encode:3` and `fullwidth`
 * strategies emit. Exotic spellings (`%u2215`, `%%35%63`, `0x2f`) are
 * deliberately NOT here: treating them as equivalent would strip a leading
 * separator that the reference corpus actually puts on the wire. The
 * `utf16_escape` and `double_percent` stages do emit two of them, which costs
 * this table nothing -- a stage runs AFTER assembly, so the strip rule only ever
 * reads the spellings an input FILE contains.
 */
export const SEPARATOR_SPELLINGS: Readonly<Record<SeparatorKind, ReadonlyArray<string>>> = {
  "/": ["/", "%2f", "%252f", "%25252f", "%25%2f", "%c0%af", "%ef%bc%8f"],
  "\\": ["\\", "%5c", "%255c", "%25255c", "%25%5c", "%c1%9c", "%ef%bc%bc"]
}

/** Longest token first, so `%252f` never loses the match to `%2f`. */
const SEPARATOR_TABLE: ReadonlyArray<readonly [string, SeparatorKind]> = (
  [
    ...SEPARATOR_SPELLINGS["/"].map((token) => [token, "/"] as const),
    ...SEPARATOR_SPELLINGS["\\"].map((token) => [token, "\\"] as const)
  ]
).sort((a, b) => b[0].length - a[0].length)

/** The separator token `text` ENDS with, and which separator it spells. */
export const trailingSeparator = (
  text: string
): { readonly token: string; readonly kind: SeparatorKind } | undefined => {
  const lower = text.toLowerCase()
  for (const [token, kind] of SEPARATOR_TABLE) {
    if (lower.endsWith(token)) return { token, kind }
  }
  return undefined
}

/** The separator token `text` STARTS with, and which separator it spells. */
export const leadingSeparator = (
  text: string
): { readonly token: string; readonly kind: SeparatorKind } | undefined => {
  const lower = text.toLowerCase()
  for (const [token, kind] of SEPARATOR_TABLE) {
    if (lower.startsWith(token)) return { token, kind }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Primitive rewrites
// ---------------------------------------------------------------------------

const encoder = new TextEncoder()

/** Percent-encode a single character (all of its UTF-8 bytes), lowercase hex. */
export const percentEncodeChar = (char: string): string => {
  let out = ""
  for (const byte of encoder.encode(char)) {
    out += `%${byte.toString(16).padStart(2, "0")}`
  }
  return out
}

/**
 * Apply `passes` rounds of URL encoding to a string.
 *
 * Pass 1 percent-encodes every character present in `charset`. Every subsequent
 * pass re-encodes the percent signs produced so far (`%` -> `%25`), which is what
 * makes double / triple encoding work against a stack that decodes more than once.
 */
export const urlEncodeText = (
  text: string,
  charset: string,
  passes: number
): string => {
  if (passes <= 0) return text
  const targets = new Set(Array.from(charset))
  let out = ""
  for (const char of text) {
    out += targets.has(char) ? percentEncodeChar(char) : char
  }
  for (let pass = 1; pass < passes; pass++) {
    out = out.replaceAll("%", "%25")
  }
  return out
}

/** Base64 a string via its UTF-8 bytes (`btoa` alone is latin1-only). */
export const base64Text = (text: string): string => {
  let binary = ""
  for (const byte of encoder.encode(text)) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

/** Rewrite the case of every `%XY` escape's hex digits. */
export const hexCaseText = (text: string, to: "upper" | "lower"): string =>
  text.replace(/%([0-9a-fA-F]{2})/g, (_, hex: string) =>
    `%${to === "upper" ? hex.toUpperCase() : hex.toLowerCase()}`
  )

/** Replace every occurrence of the mapping's keys. */
export const replaceChars = (
  text: string,
  mapping: Readonly<Record<string, string>>
): string => {
  let out = ""
  for (const char of text) {
    out += mapping[char] ?? char
  }
  return out
}

/**
 * Collapse segments into the final payload string.
 *
 * A plain loop rather than `map(...).join("")`: this runs once per candidate
 * payload, and the intermediate array of strings is pure garbage.
 */
export const joinSegments = (segments: ReadonlyArray<Segment>): string => {
  let out = ""
  for (const segment of segments) out += segment.text
  return out
}
