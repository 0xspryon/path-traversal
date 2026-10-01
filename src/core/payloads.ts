/**
 * Shared vocabulary for reading *other people's* path-traversal wordlists.
 *
 * Two jobs, both needed by `harvest-wordlists.ts` and `coverage-check.ts`:
 *
 *  1. DECOMPOSE a reference entry into pt's four dimensions
 *     (`prefix + traversal x depth + target + suffix`), or decide it cannot be
 *     expressed generatively and belongs in `raw_file`.
 *
 *  2. CLASSIFY an entry by the LITERAL BYTES it puts on the wire.
 *
 * This module lives in `src/core/` because `pt add --decompose` needs it too: a
 * user who finds a new payload in the wild should be able to hand the whole
 * string to pt and have it routed into the right slots, which is exactly the job
 * the harvest does. Like the rest of `src/core/`, it is free of Effect, IO and
 * Node.
 *
 * ## Why classification must not decode
 *
 * A checker that fully decodes every payload maps every spelling of
 * `../../../etc/passwd` onto `/etc/passwd` and then "proves" total coverage.
 * That is the trap. Encoding completeness does NOT form a subset lattice --
 * partial and full encoding are SIBLINGS, because they trip different filter
 * signatures:
 *
 * ```
 * payload                                     literal..  %2e  %2e%2e  %2f
 * ../../../etc/passwd                         MATCH      -    -       -
 * ../../../etc%2fpasswd        (partial sep)  MATCH      -    -       MATCH
 * %2e%2e/%2e%2e/etc/passwd     (partial dots) -          YES  YES     -
 * %2e%2e%2f%2e%2e%2fetc%2fpasswd     (full)   -          YES  YES     MATCH
 * ```
 *
 * Full encoding trips every signature; each partial form trips a strict subset.
 * So emitting the fully-encoded form does not cover a reference list's
 * partially-encoded form, and the class is part of the canonical key.
 *
 * ## Why the canonical key is a PAIR
 *
 * `(resolved target, technique class)`.
 *
 * Depth collapses INTO the resolved target, because POSIX guarantees `..` in the
 * root directory is the root itself, and Windows clamps identically -- so
 * overshooting is free and any depth covers any shallower depth. Encoding does
 * not collapse, per above. Hence a pair.
 */

import { assemble } from "./assemble.ts"
import {
  joinSegments,
  leadingSeparator,
  trailingSeparator,
  type Segment
} from "./segment.ts"

// ---------------------------------------------------------------------------
// Token alphabets
// ---------------------------------------------------------------------------

/** Every spelling of a single `.` seen across the reference corpus. */
export const DOT_TOKENS = [
  "%25252e",
  "%252e",
  "%2e",
  "%c0%ae",
  "%ef%bc%8e",
  "%uff0e",
  "%u002e",
  "%%32%65",
  "0x2e",
  "."
] as const

/**
 * Every spelling of a single path separator seen across the reference corpus.
 *
 * `%25%5c` earns its place: it is `%` plus a SINGLE-encoded `\`, which is what
 * you get when a generator percent-encodes the `%` of `%5c` and nothing else. It
 * is NOT the same token as `%255c` (a properly double-encoded `\`), and telling
 * them apart is what sends `%25%5c..%25%5c..%255cboot.ini` to `raw_file`.
 */
export const SEP_TOKENS = [
  "%25255c",
  "%25252f",
  "%252f",
  "%255c",
  "%25%5c",
  "%25%2f",
  "%2f",
  "%5c",
  "%c0%af",
  "%c1%9c",
  "%ef%bc%8f",
  "%ef%bc%bc",
  "%u2215",
  "%u2216",
  "%u005c",
  "%u002f",
  "%%35%63",
  "%%32%66",
  "0x2f",
  "0x5c",
  "/",
  "\\"
] as const

/**
 * The same tokens, partitioned by WHICH separator they spell.
 *
 * Needed by the class-aware step matcher below: a traversal step's separator run
 * may repeat the same separator (`..//`, `..\\\\`) but a change of separator
 * identity in the middle of a run is a slot boundary, not more run.
 */
export const SEP_TOKENS_BY_KIND: Readonly<Record<"/" | "\\", ReadonlyArray<string>>> = {
  "/": ["%25252f", "%252f", "%25%2f", "%2f", "%c0%af", "%ef%bc%8f", "%u2215", "%u002f", "%%32%66", "0x2f", "/"],
  "\\": ["%25255c", "%255c", "%25%5c", "%5c", "%c1%9c", "%ef%bc%bc", "%u2216", "%u005c", "%%35%63", "0x5c", "\\"]
}

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Longest alternative first, so `%252f` never loses to `%2f`. */
const alternation = (tokens: ReadonlyArray<string>): string =>
  [...tokens].sort((a, b) => b.length - a.length).map(escapeRe).join("|")

const DOT = `(?:${alternation(DOT_TOKENS)})`
const SEP = `(?:${alternation(SEP_TOKENS)})`

/**
 * A separator run: one or more separators, each optionally preceded by the
 * single-dot or matrix-parameter noise that real lists interleave
 * (`/./`, `..;/`, `.\..\`).
 *
 * The `[;.]?` is deliberately BEFORE the separator rather than after. Putting it
 * after would let the run swallow the leading dots of the next traversal step
 * (`..//..` would parse as `..` + `//..`), which silently destroys the period
 * and sends good entries to `raw_file`.
 */
const SEP_RUN = `(?:[;.]?${SEP})+`

/** One traversal step: 2-4 dots in any spelling, then a separator run. */
const STEP_SOURCE = `(?:${DOT}{2,4}${SEP_RUN})`

const SEP_SLASH = `(?:${alternation(SEP_TOKENS_BY_KIND["/"])})`
const SEP_BACK = `(?:${alternation(SEP_TOKENS_BY_KIND["\\"])})`

/**
 * A separator run that does NOT cross a change of separator identity.
 *
 * `..\..\..\/etc/passwd` is the shape this exists for. With the permissive
 * `SEP_RUN` the third step's run swallows both the `\` and the `/`, so the chain
 * is `..\ | ..\ | ..\/` -- a clean repetition that breaks at the last step,
 * which is the signature that routes an entry to the verbatim passthrough. With
 * the run stopped at the identity change the chain is three identical `..\` steps
 * and the `/` belongs to the target, where it is a meaningful second separator
 * that `strip_leading_separator: when_same_separator` now preserves.
 */
const STEP_SOURCE_SAME_SEP =
  `(?:${DOT}{2,4}(?:(?:[;.]?${SEP_SLASH})+|(?:[;.]?${SEP_BACK})+))`

const STEP_AT_START = new RegExp(`^${STEP_SOURCE}`, "i")
const STEP_AT_START_SAME_SEP = new RegExp(`^${STEP_SOURCE_SAME_SEP}`, "i")
const SEP_AT_END = new RegExp(`(?:${SEP})$`, "i")
/** Any traversal step anywhere -- used by the classifier, not the decomposer. */
export const HAS_STEP = new RegExp(STEP_SOURCE, "i")

/** Prefixes that stand in front of a traversal and are not themselves steps. */
const LEADING_PREFIX = /^(?:%00|%2500|\\0|%0a|%0d)+/i

/**
 * `\\.\C:\…`, `//?/C:/…`, `\\localhost\C$\…` and friends: a Win32 device or UNC
 * prelude in front of a drive-anchored path. The anchor is the drive letter, so
 * splitting there gives a reusable prefix and an unmangled target.
 */
const DRIVE_ANCHOR = /[A-Za-z][:$][\\/]/

// ---------------------------------------------------------------------------
// Suffixes
// ---------------------------------------------------------------------------

/**
 * One suffix token, anchored at the end.
 *
 * Note `[ \t]+`: a trailing space IS a technique (Win32 strips it from the
 * resolved name), but pt trims every input line, so a lone space can never be
 * expressed through `suffix_file`. It has to come from the `trailing_space`
 * strategy -- which is why `pt-full.yml` enables it.
 */
const SUFFIX_AT_END = new RegExp(
  "(" +
    [
      "%00(?:\\.[A-Za-z0-9]{1,5})?",
      "%2500",
      "\\\\0",
      "\\?[^/\\\\]*",
      "#[^/\\\\]*",
      ";[A-Za-z0-9.=_-]*",
      "\\.+",
      "[ \\t]+"
    ].join("|") +
    ")$"
)

const peelSuffix = (text: string): { body: string; suffix: string } => {
  let body = text
  let suffix = ""
  // Up to three rounds: '/etc/passwd%00.png' and '…%00 ' both occur.
  for (let round = 0; round < 3; round++) {
    const match = SUFFIX_AT_END.exec(body)
    if (match === null || match[0].length === 0) break
    // A bare '?' or '#' with nothing after it is still a truncator; keep it.
    suffix = match[0] + suffix
    body = body.slice(0, body.length - match[0].length)
  }
  return { body, suffix }
}

// ---------------------------------------------------------------------------
// Corruption
// ---------------------------------------------------------------------------

export type Rejection =
  | "corrupt:stripped-percent"
  | "corrupt:space-in-token"
  | "corrupt:markup"
  | "corrupt:truncated-escape"
  | "unusable:placeholder"

/**
 * `..2f..2f..2fusr2flocal2f…` -- a generator dropped the `%` from every escape.
 * 75 lines of LFI-Jhaddix.txt are like this. The result is not a traversal in
 * any encoding; it is a filename containing the characters `2f`.
 */
const STRIPPED_PERCENT = /\.\.(?:2f|5c|2e|c0|ef)/i

/**
 * HTML and quoted-printable that bled into the list: `=3D`, `&apos;`, smart
 * quotes, U+2026 ELLIPSIS. These are artefacts of how the list was published,
 * not bytes anyone meant to put on the wire.
 */
const MARKUP = /=3D|&(?:apos|quot|amp|lt|gt|#\d+);|[\u201c\u201d\u2018\u2019\u2026]/

/** `{DOMAIN}`, `{IPDELHOST}`, and the bare `RANDOMDIR` convention. */
const OTHER_PLACEHOLDER = /\{(?!FILE\})[A-Z_]+\}|RANDOMDIR/

/**
 * Is a literal space inside this line corruption, or part of a real filename?
 *
 * The corpus has both, and the counts are nowhere near each other: 3,842 lines
 * of Windows-Paths.txt contain a space and almost all of them are `Program
 * Files` or `Documents and Settings`. Three narrow rules separate them, each one
 * anchored on a character that cannot legally neighbour a space in these lists:
 *
 *   a. a space next to `_`               -> `access_ log`, `error_l og`
 *   b. a space inside a percent escape   -> `…%  25%5c..`
 *   c. a space immediately after a dot   -> `access. log%00`
 *
 * Everything else with a space is a genuine Windows path component.
 */
const SPACE_CORRUPTION = [
  /_[A-Za-z0-9]* +| +[A-Za-z0-9]*_/,
  /%[0-9a-fA-F]? +[0-9a-fA-F]/,
  /\. +[A-Za-z]/
]

/** Why this line cannot be used at all, or `undefined` if it can. */
export const rejectReason = (line: string): Rejection | undefined => {
  if (STRIPPED_PERCENT.test(line)) return "corrupt:stripped-percent"
  if (MARKUP.test(line)) return "corrupt:markup"
  // A line cut off mid-escape: '…%25%5c..%' . There is no byte sequence this
  // was meant to be, so there is nothing to preserve.
  if (/%[0-9a-fA-F]?$/.test(line.replace(/[ \t]+$/, ""))) {
    return "corrupt:truncated-escape"
  }
  const inner = line.replace(/[ \t]+$/, "")
  if (/[ \t]/.test(inner) && SPACE_CORRUPTION.some((re) => re.test(inner))) {
    return "corrupt:space-in-token"
  }
  if (OTHER_PLACEHOLDER.test(line)) return "unusable:placeholder"
  return undefined
}

// ---------------------------------------------------------------------------
// Decomposition
// ---------------------------------------------------------------------------

export interface Decomposition {
  readonly prefix: string
  /** The traversal primitive, already in trailing-separator form. */
  readonly traversal: string
  readonly depth: number
  /** Empty for a traversal-only entry such as `/.../.../.../`. */
  readonly target: string
  readonly suffix: string
}

export type DecomposeResult =
  | { readonly kind: "ok"; readonly parts: Decomposition }
  /** Internally inconsistent: no single primitive repeats to produce it. */
  | { readonly kind: "raw"; readonly why: string }
  | { readonly kind: "reject"; readonly why: Rejection }

/** Split a step chain off the front of `text`, greedily. */
const matchStepsWith = (
  pattern: RegExp,
  text: string
): { steps: Array<string>; rest: string } => {
  const steps: Array<string> = []
  let rest = text
  for (;;) {
    const match = pattern.exec(rest)
    if (match === null || match[0].length === 0) break
    steps.push(match[0])
    rest = rest.slice(match[0].length)
  }
  return { steps, rest }
}

/** The shortest p dividing `steps.length` such that `steps` is `steps[0..p)` repeated. */
const properPeriod = (steps: ReadonlyArray<string>): number | undefined => {
  const n = steps.length
  for (let period = 1; period < n; period++) {
    if (n % period !== 0) continue
    let ok = true
    for (let i = period; i < n; i++) {
      if (steps[i] !== steps[i % period]) {
        ok = false
        break
      }
    }
    if (ok) return period
  }
  return undefined
}

/**
 * Is this step chain a clean repetition that BREAKS at the last step?
 *
 * That is the shape the brief calls internally inconsistent, and it is the one
 * shape a monolithic depth-1 primitive would misrepresent. In
 * `%25%5c..%25%5c..%25%5c…..%255cboot.ini` the first twelve steps end in
 * `%25%5c` (`%` plus a single-encoded `\`) and the thirteenth ends in `%255c` (a
 * properly double-encoded `\`). Writing the whole thing down as one primitive at
 * depth 1 would let pt reproduce that one string and nothing else -- the
 * opposite of generative -- so it goes to `raw_file` verbatim instead.
 *
 * At least two complete cycles are required before the tail counts as a break.
 * With only `[../, ..//]` there is no established pattern for the second step to
 * violate, and `../..//` is a perfectly good primitive in its own right.
 */
const breaksAtTail = (steps: ReadonlyArray<string>): boolean => {
  const n = steps.length
  if (n < 3) return false
  const head = steps.slice(0, n - 1)
  const period = properPeriod(head) ?? (head.every((s) => s === head[0]) ? 1 : undefined)
  if (period === undefined) return false
  if ((n - 1) / period < 2) return false
  return steps[n - 1] !== steps[(n - 1) % period]
}

/**
 * Split a step chain into `(primitive, depth)`.
 *
 * A chain with a proper period is that period repeated. A chain without one is
 * its own primitive at depth 1 -- which reproduces the payload exactly, and is
 * how `../..//{FILE}` gets a usable primitive out of two unequal steps.
 */
const asPrimitive = (
  steps: ReadonlyArray<string>
): { readonly traversal: string; readonly depth: number } => {
  const period = properPeriod(steps) ?? steps.length
  return { traversal: steps.slice(0, period).join(""), depth: steps.length / period }
}

/** Nothing but separator tokens, in any spelling. */
const ONLY_SEPARATORS = new RegExp(`^(?:${SEP})+$`, "i")

/**
 * Hand the TARGET back the separators the last traversal step swallowed.
 *
 * The step matcher is greedy, so in `../../..//etc/passwd` the third step eats
 * both slashes and the chain reads `../ | ../ | ..//` -- a clean repetition that
 * breaks at its last step, which is the signature that routes an entry to the
 * verbatim passthrough. But nothing here is inconsistent: the primitive is `../`
 * at depth 3 and the extra `/` is a DOUBLED JUNCTION the author chose. Since
 * `strip_leading_separator` gives up exactly one separator, a target of
 * `//etc/passwd` rebuilds the line byte for byte, so the entry is expressible
 * after all.
 *
 * Two conditions, both narrow:
 *
 * - the tail must be the established step plus nothing but separator tokens, so
 *   `..%25%5c` x12 followed by `..%255c` -- a genuinely different token -- still
 *   goes to `raw_file`;
 * - every step before the tail must be the SAME step, so the reflowed chain is a
 *   clean repetition at depth >= 3. A chain whose head has period 2 and odd
 *   length would reflow into a chain with no proper period at all, i.e. a
 *   monolithic depth-1 primitive that reproduces one string and nothing else --
 *   the opposite of generative, and `raw_file` is the honest place for it.
 */
const reflowTail = (
  steps: ReadonlyArray<string>,
  rest: string
): { readonly steps: Array<string>; readonly rest: string } | undefined => {
  const n = steps.length
  if (n < 3) return undefined
  const head = steps.slice(0, n - 1)
  if (!head.every((step) => step === head[0])) return undefined
  const expected = head[0]!
  const last = steps[n - 1]!
  if (!last.startsWith(expected) || last.length === expected.length) return undefined
  const extra = last.slice(expected.length)
  if (!ONLY_SEPARATORS.test(extra)) return undefined
  return { steps: [...head, expected], rest: extra + rest }
}

const anySepEndsIt = (text: string): boolean =>
  text.length > 0 && (SEP_AT_END.test(text) || /(?:%00|=|:)$/i.test(text))

/**
 * Normalise a decomposed target to the spelling that round-trips.
 *
 * With nothing in front, the text is kept verbatim -- `proc/self/environ` really
 * does appear without a leading slash in LFI-LFISuite-pathtotest.txt, and
 * inventing one would change the payload.
 *
 * With something in front, a leading `/` is added only when the thing in front
 * ends in a `/`-class separator, because that is exactly when the target slot's
 * `when_same_separator` strip will take it off again. Adding one after a
 * `\`-class separator used to be harmless (v1 stripped the `/` whichever
 * separator preceded it) and is now wrong: it would turn `..\..\..\boot.ini`
 * into `..\..\..\/boot.ini`, which is a different payload.
 *
 * A target that ALREADY starts with a separator of the preceding kind gets one
 * more, for the same reason read in the other direction: the strip gives up
 * exactly one separator, so a target that must arrive with two on the wire has to
 * be written with three. That is what makes the doubled junction
 * (`../../..//etc/passwd`, target `//etc/passwd`) decompose at all.
 */
const normaliseTarget = (
  text: string,
  precedingKind: "/" | "\\" | undefined
): string => {
  if (text.length === 0 || precedingKind === undefined) return text
  const lead = leadingSeparator(text)
  if (lead !== undefined) {
    return lead.kind === precedingKind ? `${precedingKind}${text}` : text
  }
  if (/^[A-Za-z][:$][\\/]/.test(text)) return text
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text
  if (text.startsWith("~")) return text
  if (text.startsWith("{FILE}")) return text
  return precedingKind === "/" ? `/${text}` : text
}

/**
 * Decompose one reference entry into pt's four dimensions.
 *
 * The traversal search deliberately starts at the EARLIEST position where a step
 * chain begins on a separator boundary, so a document-root prefix
 * (`/var/www/html/../../../etc/passwd`) splits where a human would split it.
 */
export const decompose = (rawLine: string): DecomposeResult => {
  const reject = rejectReason(rawLine)
  if (reject !== undefined) return { kind: "reject", why: reject }

  const line = rawLine.replace(/\r/g, "")
  if (line.length === 0) return { kind: "reject", why: "corrupt:markup" }

  // Two parses, in order of preference.
  //
  // The permissive one lets a step's separator run absorb whatever separators
  // follow, which is right for `..//..//` and wrong for `..\..\..\/etc/passwd`:
  // there the run swallows the target's `/` and the chain becomes a repetition
  // that breaks at its last step, the signature that sends an entry to the
  // verbatim passthrough. So when the permissive parse fails to produce a usable
  // decomposition, try again with runs that stop at a change of separator
  // identity. 217 lines of the reference corpus come back from `raw_file` this
  // way, and only because `when_same_separator` now keeps the `/` they need.
  const permissive = attemptDecompose(line, STEP_AT_START)
  if (permissive.kind === "ok") return permissive
  const sameSep = attemptDecompose(line, STEP_AT_START_SAME_SEP)
  if (sameSep.kind === "ok") return sameSep
  return permissive
}

/**
 * One decomposition attempt, with a given step matcher.
 *
 * The traversal search deliberately starts at the EARLIEST position where a step
 * chain begins on a separator boundary, so a document-root prefix
 * (`/var/www/html/../../../etc/passwd`) splits where a human would split it.
 */
const attemptDecompose = (line: string, stepPattern: RegExp): DecomposeResult => {
  let prefix = ""
  let body = line

  const leading = LEADING_PREFIX.exec(body)
  if (leading !== null) {
    prefix += leading[0]
    body = body.slice(leading[0].length)
  }

  // Find where the traversal starts.
  let steps: Array<string> = []
  let rest = body
  let found = false
  for (let at = 0; at < body.length; at++) {
    const head = body.slice(0, at)
    if (at > 0 && !anySepEndsIt(head)) continue
    const attempt = matchStepsWith(stepPattern, body.slice(at))
    if (attempt.steps.length === 0) continue
    prefix += head
    steps = attempt.steps
    rest = attempt.rest
    found = true
    break
  }
  if (!found) rest = body

  // A tail that is the established step plus extra separators is a doubled
  // junction, not an inconsistency: give those separators back to the target,
  // where the non-greedy strip keeps all but one of them.
  if (steps.length > 0 && breaksAtTail(steps)) {
    const reflowed = reflowTail(steps, rest)
    if (reflowed !== undefined) {
      steps = reflowed.steps
      rest = reflowed.rest
    }
  }

  let traversal = ""
  let depth = 1
  if (steps.length > 0) {
    if (breaksAtTail(steps)) {
      return {
        kind: "raw",
        why: `a clean repetition that breaks at the last step: ${steps.join(" | ")}`
      }
    }
    const primitive = asPrimitive(steps)
    traversal = primitive.traversal
    depth = primitive.depth
  }

  // No traversal: the line may still be a device/UNC prefix plus a drive path.
  if (steps.length === 0 && prefix.length === 0) {
    const anchor = DRIVE_ANCHOR.exec(rest)
    if (anchor !== undefined && anchor !== null && anchor.index > 0) {
      const head = rest.slice(0, anchor.index)
      if (/^[\\/.?$]+$/.test(head) || /^\\\\[A-Za-z0-9.-]+\\$/.test(head)) {
        prefix = head
        rest = rest.slice(anchor.index)
      }
    }
  }

  const { body: targetBody, suffix } = peelSuffix(rest)

  const preceding = prefix + (traversal.length === 0 ? "" : traversal.repeat(depth))
  const parts: Decomposition = {
    prefix,
    traversal,
    depth,
    target: normaliseTarget(
      targetBody,
      preceding.length === 0 ? undefined : trailingSeparator(preceding)?.kind
    ),
    suffix
  }

  // Hard self-check, through the REAL assemble rule. If pt cannot rebuild the
  // original line byte for byte from these parts, the decomposition is a guess
  // and the entry belongs in raw_file -- not in a slot file where it would
  // quietly generate 20,000 slightly-wrong payloads.
  const rebuilt = reassemble(parts)
  if (rebuilt !== line) {
    return {
      kind: "raw",
      why: `does not survive a round trip: rebuilt as ${JSON.stringify(rebuilt)}`
    }
  }

  return { kind: "ok", parts }
}

/**
 * Rebuild a payload from its parts by running pt's REAL assembler over them.
 *
 * Not a reimplementation: `assemble` is imported and called, so the round-trip
 * self-check in `attemptDecompose` can never drift from what the generator
 * actually emits. That matters most for the leading-separator rule, which is the
 * subtle part: the target's leading `/` survives when nothing precedes it
 * (`/etc/passwd` is absolute and meant to be), survives when the separator in
 * front of it spells a DIFFERENT separator (`..\..\..\/etc/passwd`), and is
 * dropped only when the separator in front spells the same one.
 */
export const reassemble = (parts: Decomposition): string =>
  joinSegments(
    assemble([
      { segment: member(parts.prefix, "prefix"), repeat: 1, strip: "when_same_separator" },
      {
        segment: member(parts.traversal, "traversal"),
        repeat: parts.depth,
        strip: "when_same_separator"
      },
      { segment: member(parts.target, "target"), repeat: 1, strip: "when_same_separator" },
      { segment: member(parts.suffix, "suffix"), repeat: 1, strip: "when_same_separator" }
    ])
  )

const member = (text: string, slot: string): Segment => ({
  text,
  transform: true,
  slot
})

// ---------------------------------------------------------------------------
// Decoding, for the TARGET half of the canonical key only
// ---------------------------------------------------------------------------

const LITERALISE: ReadonlyArray<readonly [RegExp, string]> = [
  // '%' + single-encoded separator. Authorial intent is a separator that needs
  // two decodes, so fold it straight to one; leaving it to the generic percent
  // decoder yields the nonsense component `..%`.
  [/%25%5c/gi, "\\"],
  [/%25%2f/gi, "/"],
  [/%c0%ae/gi, "."],
  [/%c0%af/gi, "/"],
  [/%c1%9c/gi, "\\"],
  [/%ef%bc%8e/gi, "."],
  [/%ef%bc%8f/gi, "/"],
  [/%ef%bc%bc/gi, "\\"],
  [/%uff0e/gi, "."],
  [/%uff0f/gi, "/"],
  [/%uff3c/gi, "\\"],
  [/%u2215/gi, "/"],
  [/%u2216/gi, "\\"],
  [/%u002e/gi, "."],
  [/%u002f/gi, "/"],
  [/%u005c/gi, "\\"],
  [/0x2e/gi, "."],
  [/0x2f/gi, "/"],
  [/0x5c/gi, "\\"],
  // Longer overlong forms, and the 'first byte, then a plain escaped dot/slash'
  // variants. Longest first so %f0%80%80%ae never loses to %80%ae.
  [/%fc%80%80%80%80%a[ef]/gi, "/"],
  [/%f0%80%80%a[ef]/gi, "/"],
  [/%e0%80%ae/gi, "."],
  [/%e0%80%af/gi, "/"],
  [/%c0%2e/gi, "."],
  [/%c0%2f/gi, "/"],
  [/%c0%5c/gi, "\\"],
  [/%c1%1c/gi, "\\"],
  [/%c1%af/gi, "/"],
  // Any REMAINING %uXXXX is one of DotDotPwn's invalid-Unicode separator
  // candidates (%uEFC8, %uF025 are private-use codepoints). They exist to be a
  // separator, so resolve them as one -- otherwise every depth of
  // '..%uEFC8..%uEFC8…/etc/passwd' becomes its own bogus 'target'.
  [/%u[0-9a-f]{4}/gi, "/"]
]

const percentDecodeOnce = (text: string): string =>
  text.replace(/%([0-9a-fA-F]{2})/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16))
  )

const BASE64_BLOB = /^[A-Za-z0-9+/]{12,}={0,2}$/

const decodeBlob = (text: string): string | undefined => {
  if (!BASE64_BLOB.test(text)) return undefined
  try {
    const decoded = atob(text)
    // Only believe it if it looks like a path and is printable ASCII.
    if (!/^[\x20-\x7e]+$/.test(decoded)) return undefined
    if (!/[/\\]/.test(decoded)) return undefined
    return decoded
  } catch {
    return undefined
  }
}

/**
 * Decode a base64 payload, tolerating a `url_encode` stage on top of it.
 *
 * `base64 > url_encode:1` with `charset: "+/="` leaves `%2b`, `%2f` and `%3d`
 * inside the blob, so the percent layer has to come off before the blob is
 * recognisable at all.
 */
export const tryBase64 = (text: string): string | undefined =>
  decodeBlob(text) ?? decodeBlob(percentDecodeOnce(text))

/**
 * Decode every spelling down to literal bytes. Used ONLY to compute the target
 * half of the canonical key -- never to decide a technique class.
 */
export const toLiteral = (text: string): string => {
  let current = text
  const unB64 = tryBase64(current)
  if (unB64 !== undefined) current = unB64
  for (let round = 0; round < 6; round++) {
    let next = current
    for (const [pattern, replacement] of LITERALISE) next = next.replace(pattern, replacement)
    next = percentDecodeOnce(next)
    if (next === current) break
    current = next
  }
  return current
}

const WINDOWSISH = /(?:^|[\\/])[A-Za-z][:$][\\/]|\\|(?:^|[\\/])(?:windows|winnt|progra|boot\.ini|inetpub|xampp)/i

const URL_SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i

/**
 * Resolve a literal path to its canonical absolute form, CLAMPING `..` at the
 * root.
 *
 * This is where depth collapses. `cd ..` from `/` stays at `/` on POSIX and
 * Windows clamps identically, so `../../../../../../etc/passwd` and
 * `../../../etc/passwd` are the same request and must share one key. A component
 * of three or more dots is treated as `..`, which is what the `....//` and
 * `/.../` tricks mean once a normaliser has had its way with them.
 *
 * Three normalisations happen per component, each of them a technique the
 * payload used to hide a `..` that the resolver must still see:
 * a matrix parameter is dropped (`..;a=b` is `..`), and a trailing dot or space
 * is dropped because Win32 strips them from the resolved name.
 */
export const resolveClamped = (literal: string): string => {
  // A PHP/stream wrapper is not a filesystem path; resolving it destroys it.
  const scheme = URL_SCHEME.exec(literal)
  if (scheme !== null) {
    return `${scheme[1]!.toLowerCase()}://${literal.slice(scheme[0].length)}`
  }
  // '/C:/inetpub' and 'C:/inetpub' are the same file. The lists write both, and
  // pt's conditional leading-slash strip means it emits whichever one the
  // dimensions produce, so the leading separator cannot be part of the key.
  let text = literal.replace(/\\/g, "/").replace(/^\/+(?=[A-Za-z][:$]\/)/, "")
  let drive = ""
  const driveMatch = /^([A-Za-z])[:$]\//.exec(text)
  if (driveMatch !== null) {
    drive = `${driveMatch[1]!.toLowerCase()}:`
    text = text.slice(driveMatch[0].length - 1)
  }
  const stack: Array<string> = []
  for (const raw of text.split("/")) {
    const part = raw.replace(/;.*$/, "").replace(/[.\s]+$/, (run) =>
      // Keep a lone '..' or '...' intact; strip a trailing dot off a filename.
      /^\.+$/.test(raw) ? run : ""
    )
    if (part.length === 0 || part === ".") continue
    if (/^\.{2,}$/.test(part)) {
      stack.pop() // pop of an empty stack is a no-op: that IS the clamp
      continue
    }
    stack.push(part)
  }
  const joined = `/${stack.join("/")}`
  const out = drive + joined
  return WINDOWSISH.test(literal) ? out.toLowerCase() : out
}

/** `(resolved target)` half of the canonical key, straight from a payload. */
export const canonicalTarget = (payload: string): string => {
  const { body } = peelSuffix(payload.replace(/[ \t]+$/, ""))
  // A LEADING null byte is a prefix technique, not a truncator -- truncating
  // there would collapse every such payload onto the single target '/'.
  const withoutNull = body
    .replace(LEADING_PREFIX, "")
    .replace(/(?:%00|%2500|\\0).*$/i, "")
  const literal = toLiteral(withoutNull.replace(/\{FILE\}/g, "etc/passwd"))
  // A '%20' only becomes whitespace once decoded, so the trim has to happen
  // after `toLiteral`, not before it.
  return resolveClamped(literal).replace(/[\s.]+$/, "")
}

// ---------------------------------------------------------------------------
// Classification -- literal bytes only, never decoded
// ---------------------------------------------------------------------------

/**
 * The primary spelling class: how the traversal's dots and separators are
 * written. Exactly one per payload, mutually exclusive.
 *
 * `percent-u` and `nested-percent` are two escape SYNTAXES rather than two
 * characters, which is why they are primary classes and not features: a filter
 * that normalises `%XY` has no rule at all for `%u2216` or `%%35%63`.
 */
export type PrimaryClass =
  | "plain"
  | "partial-dots"
  | "partial-sep"
  | "full-url"
  | "double-url"
  | "triple-url"
  | "overlong"
  | "fullwidth"
  | "percent-u"
  | "nested-percent"
  | "base64"
  | "absolute-no-traversal"

/** Orthogonal features. Any number per payload, each a class in its own right. */
export type FeatureClass =
  | "backslash"
  | "noise-dot"
  | "noise-slash"
  | "semicolon"
  | "null-byte"
  | "trailing-ext"
  | "trailing-dot-space"

export type PayloadClass = PrimaryClass | FeatureClass

export const PRIMARY_CLASSES: ReadonlyArray<PrimaryClass> = [
  "plain",
  "partial-dots",
  "partial-sep",
  "full-url",
  "double-url",
  "triple-url",
  "overlong",
  "fullwidth",
  "percent-u",
  "nested-percent",
  "base64",
  "absolute-no-traversal"
]

export const FEATURE_CLASSES: ReadonlyArray<FeatureClass> = [
  "backslash",
  "noise-dot",
  "noise-slash",
  "semicolon",
  "null-byte",
  "trailing-ext",
  "trailing-dot-space"
]

export const ALL_CLASSES: ReadonlyArray<PayloadClass> = [
  ...PRIMARY_CLASSES,
  ...FEATURE_CLASSES
]

const TRIPLE = /%25252[ef]|%25255c/i
const DOUBLE = /%252[ef]|%255c|%25%5c|%25%2f/i
const OVERLONG = /%c0%a[ef]|%c1%9c/i
const FULLWIDTH = /%ef%bc%(?:8e|8f|bc)/i
const PERCENT_U = /%u[0-9a-f]{4}/i
const NESTED_PERCENT = /%%[0-9a-f]{2}/i
const ENCODED_DOT = /%2e/i
const ENCODED_SEP = /%2f|%5c/i
const LITERAL_DOTDOT = /\.\./
const MAYBE_BASE64 = /[A-Za-z0-9+/]{16,}/

/**
 * The primary class, decided by inspecting literal bytes.
 *
 * Order matters: the heavier spellings are checked first because a
 * triple-encoded payload also contains the double-encoded byte sequence as a
 * substring, and the strongest signature is the one a filter actually sees.
 * base64 is checked before the dot/separator logic because a base64 blob
 * contains neither a dot nor a separator and would otherwise be read as a plain
 * absolute path.
 */
export const primaryClass = (payload: string): PrimaryClass => {
  const text = payload.replace(/[ \t]+$/, "")
  if (TRIPLE.test(text)) return "triple-url"
  if (DOUBLE.test(text)) return "double-url"
  if (OVERLONG.test(text)) return "overlong"
  if (FULLWIDTH.test(text)) return "fullwidth"
  if (PERCENT_U.test(text)) return "percent-u"
  if (NESTED_PERCENT.test(text)) return "nested-percent"
  if (MAYBE_BASE64.test(text)) {
    for (const run of text.match(/[A-Za-z0-9+/]{16,}(?:={0,2}|(?:%3d){0,2})/gi) ?? []) {
      if (tryBase64(run) !== undefined) return "base64"
    }
  }
  const hasStep = HAS_STEP.test(text) || /%2e%2e|%252e/i.test(text)
  if (!hasStep) return "absolute-no-traversal"
  const dotsEncoded = ENCODED_DOT.test(text) && !LITERAL_DOTDOT.test(text)
  const sepEncoded = ENCODED_SEP.test(text)
  if (dotsEncoded && sepEncoded) return "full-url"
  if (dotsEncoded) return "partial-dots"
  if (sepEncoded) return "partial-sep"
  return "plain"
}

const NOISE_DOT = /[\\/]\.[\\/]|%2f\.%2f/i
const NOISE_SLASH = /\/\/|\\\\|\/\\|\\\/|%2f%2f|%5c%5c/i
const NULL_BYTE = /%00|%2500|\\0/i
/** A fake extension or bare truncator bolted onto the end of the path. */
const TRAILING_EXT = /(?:%00|\?|#|;)(?:\.[A-Za-z0-9]{1,5})?$/i
/** Win32 strips these from the resolved name, so they survive a filter. */
const TRAILING_DOT_SPACE = /[.\s]$/

/** Orthogonal feature classes present in this payload. */
export const featureClasses = (payload: string): Array<FeatureClass> => {
  const out: Array<FeatureClass> = []
  const text = payload
  if (/\\|%5c|%255c|%c1%9c|%ef%bc%bc|%u2216|%u005c/i.test(text)) out.push("backslash")
  if (NOISE_DOT.test(text)) out.push("noise-dot")
  if (NOISE_SLASH.test(text)) out.push("noise-slash")
  if (/;/.test(text)) out.push("semicolon")
  if (NULL_BYTE.test(text)) out.push("null-byte")
  if (TRAILING_EXT.test(text.replace(/[ \t]+$/, ""))) out.push("trailing-ext")
  if (TRAILING_DOT_SPACE.test(text)) out.push("trailing-dot-space")
  return out
}

/** Every class this payload belongs to: one primary plus its features. */
export const classesOf = (payload: string): Array<PayloadClass> => [
  primaryClass(payload),
  ...featureClasses(payload)
]
