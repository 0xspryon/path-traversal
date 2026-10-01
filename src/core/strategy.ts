/**
 * Strategies: an ordered UNION of named rewrite pipelines.
 *
 * Each strategy is one HYPOTHESIS about where the filter sits and what it does.
 * `url_encode:1` says "the filter checks before exactly one decode".
 * `overlong_utf8` says "the filter's decoder is strict and a downstream one is
 * lax". `dot_noise` says "the filter pattern-matches sequences and a normalizer
 * collapses them". These are mutually exclusive *explanations* of a single
 * unknown, so they are alternatives, not ingredients. Cross-producting them
 * would only emit payloads that require several independent unlikely things to
 * be true at once -- strictly less probable than either hypothesis alone, and
 * exponential in the number of techniques.
 *
 * Composition is therefore expressible with `>` but never automatic.
 *
 * ## Naming
 *
 * `:` means INTENSITY, always. `url_encode:1|2|3` and `padding:N` are one
 * technique turned up or down. Anything that is a genuinely different technique
 * gets its own name -- `dot_noise`, `double_slash`, `backtrack`, `matrix_param`,
 * `selective_first|_last|_alternating`, `hex_case_upper|_lower` -- so that two
 * entries in the catalog look like siblings exactly when they are.
 *
 * ## Typing
 *
 * Every stage has a SIGNATURE, and the parser type-checks a pipeline against it.
 * That is what rejects `base64 > dot_noise`: inserting `/./` into a base64 blob
 * is meaningless, and v1 parsed and ran it happily.
 */
import {
  base64Text,
  hexCaseText,
  percentEncodeChar,
  replaceChars,
  SEPARATORS,
  syntheticSegment,
  urlEncodeText,
  type Segment
} from "./segment.ts"

/** Raised for an unknown strategy name or malformed pipeline. */
export class PipelineError extends Error {
  readonly _tag = "PipelineError"
  constructor(message: string) {
    super(message)
    this.name = "PipelineError"
  }
}

// ---------------------------------------------------------------------------
// Stage types
// ---------------------------------------------------------------------------

/**
 * What a stage consumes and produces.
 *
 * - `path`     real filesystem syntax: literal `/` and `\` separators a stage can
 *              find, count and respell.
 * - `escapes`  text carrying `%XY` escapes, which is the one thing `hex_case_*`
 *              has anything to do.
 * - `opaque`   a blob with no path structure left -- what `base64` produces.
 * - `text`     anything at all. Every other kind is a `text`.
 *
 * `path`, `escapes` and `opaque` are all subtypes of `text`, and nothing else
 * subsumes anything. That single lattice replaces v1's `producesEscapes` boolean
 * and the one bespoke check that read it.
 */
export type Kind = "path" | "escapes" | "opaque" | "text"

/** Is `actual` acceptable where `required` is demanded? */
export const subsumes = (required: Kind, actual: Kind): boolean =>
  required === "text" || required === actual

export interface StageSignature {
  readonly accepts: ReadonlyArray<Kind>
  /** `preserve` means the stage hands its input's kind straight through. */
  readonly produces: Kind | "preserve"
}

/** Why a stage needs the kind it needs. Surfaces in the rejection message. */
const WHY: Readonly<Record<Kind, string>> = {
  path: "literal '/' or '\\' separators to work on",
  escapes: "'%XY' escapes that an earlier stage produced",
  opaque: "an encoded blob",
  text: "any text"
}

/**
 * How a stage walks the segment list. All four are first-class; none is a
 * special case of another.
 *
 * - `segment`    each transformable segment is rewritten independently. Sound
 *                only for rewrites that are homomorphic over concatenation.
 * - `positional` candidate characters are indexed across the WHOLE transformable
 *                view, so "first" means first in the payload, not first in each
 *                segment.
 * - `run`        each maximal contiguous run of transformable segments collapses
 *                into one segment. Required by base64, which is not homomorphic.
 * - `structural` the stage inserts segments or extends one by slot.
 */
export type StageKind = "segment" | "positional" | "run" | "structural"

/**
 * What a structural stage needs to know about the slot layout.
 *
 * `anchorSlot` is the slot a `trailing_*` stage appends to: the last REQUIRED
 * slot, which in every sane config is the target. It is passed in rather than
 * hard-coded because slot names are the user's to choose.
 */
export interface StageContext {
  readonly anchorSlot?: string
}

export interface Stage {
  /** Canonical rendering, e.g. `url_encode:1`. */
  readonly name: string
  readonly kind: StageKind
  readonly signature: StageSignature
  readonly apply: (
    segments: ReadonlyArray<Segment>,
    context: StageContext
  ) => Array<Segment>
}

// ---------------------------------------------------------------------------
// Stage constructors, one per application mode
// ---------------------------------------------------------------------------

const segmentStage = (
  name: string,
  signature: StageSignature,
  rewrite: (text: string) => string
): Stage => ({
  name,
  kind: "segment",
  signature,
  apply: (segments) =>
    segments.map((segment) => {
      if (!segment.transform) return segment
      const text = rewrite(segment.text)
      return text === segment.text ? segment : { ...segment, text }
    })
})

/**
 * Index candidate characters across the whole transformable view, then rewrite
 * the selected ones.
 *
 * Protected segments are invisible to the index as well as to the rewrite, so a
 * literal suffix neither gets encoded nor shifts the numbering.
 */
const positionalStage = (
  name: string,
  signature: StageSignature,
  options: {
    readonly isCandidate: (char: string) => boolean
    readonly select: (total: number) => ReadonlySet<number>
    readonly rewrite: (char: string) => string
  }
): Stage => ({
  name,
  kind: "positional",
  signature,
  apply: (segments) => {
    let total = 0
    for (const segment of segments) {
      if (!segment.transform) continue
      for (const char of segment.text) {
        if (options.isCandidate(char)) total += 1
      }
    }
    if (total === 0) return segments.slice()
    const chosen = options.select(total)
    let index = 0
    return segments.map((segment) => {
      if (!segment.transform) return segment
      let text = ""
      for (const char of segment.text) {
        if (!options.isCandidate(char)) {
          text += char
          continue
        }
        text += chosen.has(index) ? options.rewrite(char) : char
        index += 1
      }
      return { ...segment, text }
    })
  }
})

/**
 * Collapse each maximal contiguous run of transformable segments into one
 * segment and rewrite it as a single blob.
 *
 * base64 needs this because it is NOT homomorphic over concatenation:
 * `b64(a) + b64(b) != b64(a + b)` whenever `a`'s byte length is not a multiple
 * of 3, since the `=` padding terminates the decode and everything after it is
 * silently dropped. Protected segments act as run boundaries, which is how you
 * get `literal prefix + base64(traversal + target) + literal suffix`.
 */
const runStage = (
  name: string,
  signature: StageSignature,
  rewrite: (runText: string) => string
): Stage => ({
  name,
  kind: "run",
  signature,
  apply: (segments) => {
    const out: Array<Segment> = []
    let run: Array<string> = []
    const flush = () => {
      if (run.length > 0) {
        out.push(syntheticSegment(rewrite(run.join(""))))
        run = []
      }
    }
    for (const segment of segments) {
      if (segment.transform) {
        run.push(segment.text)
      } else {
        flush()
        out.push(segment)
      }
    }
    flush()
    return out
  }
})

const structuralStage = (
  name: string,
  signature: StageSignature,
  apply: (
    segments: ReadonlyArray<Segment>,
    context: StageContext
  ) => Array<Segment>
): Stage => ({ name, kind: "structural", signature, apply })

/** Kind-preserving: a stage that adds material without respelling anything. */
const STRUCTURAL_SIGNATURE: StageSignature = {
  accepts: ["path", "escapes", "text"],
  produces: "preserve"
}

/** Prepend `./` x count. Pads the path past a length limit. */
const paddingStage = (count: number): Stage =>
  structuralStage(`padding:${count}`, STRUCTURAL_SIGNATURE, (segments) => [
    syntheticSegment("./".repeat(count)),
    ...segments
  ])

/**
 * Append a character to the ANCHOR slot's segment.
 *
 * Positional with respect to the *path*, not the payload string: the dot has to
 * land on the target, not after a `%00.png` suffix. The anchor slot is the last
 * required slot -- the one slot every payload is guaranteed to contain -- which
 * is how this stays a slot property rather than a hard-coded role.
 *
 * Two rules follow:
 *
 * - A protected anchor segment is left alone. `transform: false` means untouched,
 *   and appending is a modification.
 * - The fallback to "the last transformable segment" applies only when no anchor
 *   segment survives at all (an earlier `base64` stage collapses slots into
 *   `synthetic`). Falling back while a *protected* anchor is present would put
 *   the dot in the middle of the traversal, which is nonsense.
 */
const trailingStage = (name: string, char: string): Stage =>
  structuralStage(name, STRUCTURAL_SIGNATURE, (segments, context) => {
    const anchor = context.anchorSlot
    const hasAnchor = anchor !== undefined &&
      segments.some((segment) => segment.slot === anchor)
    const index = hasAnchor
      ? segments.findLastIndex(
        (segment) => segment.slot === anchor && segment.transform
      )
      : segments.findLastIndex((segment) => segment.transform)
    if (index < 0) return segments.slice()
    return segments.map((segment, at) =>
      at === index ? { ...segment, text: segment.text + char } : segment
    )
  })

// ---------------------------------------------------------------------------
// Catalog data
// ---------------------------------------------------------------------------

const separatorSet = new Set(Array.from(SEPARATORS))
const isSeparator = (char: string) => separatorSet.has(char)

const OVERLONG: Readonly<Record<string, string>> = {
  "/": "%c0%af",
  "\\": "%c1%9c"
}

const OVERLONG_DOTS: Readonly<Record<string, string>> = {
  ...OVERLONG,
  ".": "%c0%ae"
}

const FULLWIDTH: Readonly<Record<string, string>> = {
  "/": "%ef%bc%8f",
  "\\": "%ef%bc%bc",
  ".": "%ef%bc%8e"
}

/**
 * The `/` codepoint a `utf16_escape` stage spells when the config names none.
 *
 * U+2215 DIVISION SLASH is a `/` LOOKALIKE rather than `/` itself: a stack that
 * resolves `%uXXXX` at all tends to fold the lookalikes onto the ASCII character,
 * while a filter that only knows `%XY` has no rule for the sequence whatsoever.
 * U+2044 FRACTION SLASH is the same bet on a different codepoint, which is why it
 * is an ARGUMENT and not a second catalog entry -- same hypothesis, same stage.
 */
const UTF16_SLASH_DEFAULT = "2215"

/** `\` has no lookalike worth the trouble, so it is spelled as itself. */
const UTF16_BACKSLASH = "%u005c"

/**
 * `%` + the percent-encoded HEX DIGITS of a separator's escape.
 *
 * `%32` is `2` and `%66` is `f`, so one decode of `%%32%66` is the literal text
 * `%2f` and a second gives `/`. It is a double encoding that never puts `%25` on
 * the wire, which is the one byte sequence a filter looking for double encoding
 * is most likely to be looking for.
 */
const DOUBLE_PERCENT: Readonly<Record<string, string>> = {
  "/": "%%32%66",
  "\\": "%%35%63"
}

// ---------------------------------------------------------------------------
// Token grammar
// ---------------------------------------------------------------------------

/** One inline argument: `charset="+/="`, `charset=./\` or the bare flag `+dots`. */
export interface StageArg {
  readonly key: string
  /** `undefined` for a bare flag. */
  readonly value: string | undefined
}

/** Parsed form of one pipeline token. */
export interface Token {
  readonly raw: string
  readonly name: string
  /** The part after `:` -- the INTENSITY, and nothing else. */
  readonly intensity: string | undefined
  readonly args: ReadonlyArray<StageArg>
}

const NAME_PATTERN = /^[a-z0-9_]+/

/**
 * Split `url_encode:1(charset="+/=")` into name, intensity and arguments.
 *
 * The argument group is the §4 fix: charset is semantically PER STAGE, and
 * `url_encode:1 > base64 > url_encode:1(charset="+/=")` is the composition that
 * a per-pipeline charset simply cannot express. v1 already parsed a `(...)` group
 * for `overlong_utf8(+dots)`, so this extends that grammar rather than inventing
 * one: a comma-separated list of `key=value` pairs and bare `+flag` items, with
 * double quotes available for a value containing a comma or a bracket.
 */
export const tokenize = (raw: string): Token => {
  const name = NAME_PATTERN.exec(raw)?.[0]
  if (name === undefined || name.length === 0) {
    throw new PipelineError(
      `'${raw}' is not a valid strategy stage: a stage starts with a lowercase name.\nValid strategies:\n${catalogHelp()}`
    )
  }
  let rest = raw.slice(name.length)

  let intensity: string | undefined
  if (rest.startsWith(":")) {
    const end = rest.indexOf("(")
    intensity = (end < 0 ? rest.slice(1) : rest.slice(1, end)).trim()
    rest = end < 0 ? "" : rest.slice(end)
  }

  const args: Array<StageArg> = []
  if (rest.length > 0) {
    if (rest.startsWith("(") && !rest.endsWith(")")) {
      throw new PipelineError(
        `strategy '${raw}': unterminated argument list -- '(' with no matching ')'.`
      )
    }
    if (!rest.startsWith("(")) {
      throw new PipelineError(
        `'${raw}' is not a valid strategy stage: expected 'name', 'name:intensity' or 'name(arg=value)', got trailing '${rest}'.`
      )
    }
    args.push(...parseArgs(raw, rest.slice(1, rest.length - 1)))
  }

  return { raw, name, intensity, args }
}

const parseArgs = (raw: string, source: string): Array<StageArg> => {
  const args: Array<StageArg> = []
  let index = 0
  const skipSpace = () => {
    while (index < source.length && /\s/.test(source[index]!)) index += 1
  }
  skipSpace()
  if (index >= source.length) return args

  for (;;) {
    skipSpace()
    const keyStart = index
    while (index < source.length && /[a-z0-9_+]/i.test(source[index]!)) index += 1
    const key = source.slice(keyStart, index).replace(/^\+/, "")
    if (key.length === 0) {
      throw new PipelineError(
        `strategy '${raw}': cannot read the argument list '(${source})'; expected 'key=value' or a bare '+flag'.`
      )
    }
    skipSpace()
    let value: string | undefined
    if (source[index] === "=") {
      index += 1
      skipSpace()
      if (source[index] === '"') {
        index += 1
        let out = ""
        for (;;) {
          if (index >= source.length) {
            throw new PipelineError(
              `strategy '${raw}': unterminated quoted value in '(${source})'.`
            )
          }
          const char = source[index]!
          index += 1
          if (char === '"') break
          if (char === "\\" && index < source.length) {
            out += source[index]!
            index += 1
            continue
          }
          out += char
        }
        value = out
      } else {
        const start = index
        while (index < source.length && source[index] !== ",") index += 1
        value = source.slice(start, index).trim()
      }
    }
    args.push({ key, value })
    skipSpace()
    if (index >= source.length) break
    if (source[index] !== ",") {
      throw new PipelineError(
        `strategy '${raw}': expected ',' between arguments in '(${source})', got '${source[index]}'.`
      )
    }
    index += 1
  }
  return args
}

// ---------------------------------------------------------------------------
// Argument readers
// ---------------------------------------------------------------------------

interface Defaults {
  readonly charset: string
}

const requireNoIntensity = (token: Token): void => {
  if (token.intensity !== undefined) {
    throw new PipelineError(
      `strategy '${token.name}' takes no ':' intensity, got ':${token.intensity}'.`
    )
  }
}

const requireCount = (token: Token): number => {
  const value = Number(token.intensity)
  if (
    token.intensity === undefined ||
    token.intensity.length === 0 ||
    !Number.isInteger(value) ||
    value < 1
  ) {
    throw new PipelineError(
      `strategy '${token.raw}' needs a positive integer intensity: ${token.name}:<N>`
    )
  }
  return value
}

/** Consume an argument by name, leaving the rest for `rejectUnusedArgs`. */
const takeValue = (
  token: Token,
  used: Set<string>,
  key: string
): string | undefined => {
  const found = token.args.find((arg) => arg.key === key)
  if (found === undefined) return undefined
  used.add(key)
  if (found.value === undefined) {
    throw new PipelineError(
      `strategy '${token.raw}': argument '${key}' needs a value, e.g. ${token.name}(${key}="...").`
    )
  }
  return found.value
}

const takeFlag = (token: Token, used: Set<string>, key: string): boolean => {
  const found = token.args.find((arg) => arg.key === key)
  if (found === undefined) return false
  used.add(key)
  if (found.value !== undefined && found.value !== "true") {
    throw new PipelineError(
      `strategy '${token.raw}': '${key}' is a flag, so write '+${key}' rather than '${key}=${found.value}'.`
    )
  }
  return true
}

const rejectUnusedArgs = (
  token: Token,
  used: Set<string>,
  allowed: ReadonlyArray<string>
): void => {
  const extra = token.args.filter((arg) => !used.has(arg.key))
  if (extra.length === 0) return
  throw new PipelineError(
    `strategy '${token.raw}': unknown argument${extra.length === 1 ? "" : "s"} ${
      extra.map((arg) => `'${arg.key}'`).join(", ")
    }; ${
      allowed.length === 0
        ? `'${token.name}' takes no arguments.`
        : `'${token.name}' accepts ${allowed.map((a) => `'${a}'`).join(", ")}.`
    }`
  )
}

/** Every stage may carry `charset=` -- it is the one argument that is universal. */
const charsetOf = (token: Token, used: Set<string>, defaults: Defaults): string =>
  takeValue(token, used, "charset") ?? defaults.charset

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

interface CatalogEntry {
  readonly usage: string
  /** What filter behaviour this technique is betting on. */
  readonly hypothesis: string
  readonly signature: string
  readonly build: (token: Token, defaults: Defaults) => Stage
}

const simple = (
  name: string,
  hypothesis: string,
  signature: StageSignature,
  rewrite: (text: string) => string,
  rendered: string
): CatalogEntry => ({
  usage: name,
  hypothesis,
  signature: rendered,
  build: (token) => {
    requireNoIntensity(token)
    rejectUnusedArgs(token, new Set(), [])
    return segmentStage(name, signature, rewrite)
  }
})

const selective = (
  name: string,
  hypothesis: string,
  select: (total: number) => ReadonlySet<number>
): CatalogEntry => ({
  usage: name,
  hypothesis,
  signature: "path -> escapes",
  build: (token) => {
    requireNoIntensity(token)
    rejectUnusedArgs(token, new Set(), [])
    return positionalStage(name, { accepts: ["path"], produces: "escapes" }, {
      isCandidate: isSeparator,
      select,
      rewrite: percentEncodeChar
    })
  }
})

const noise = (name: string, replacement: string, hypothesis: string): CatalogEntry =>
  simple(
    name,
    hypothesis,
    { accepts: ["path"], produces: "preserve" },
    (text) => replaceChars(text, { "/": replacement }),
    "path -> path"
  )

const trailing = (name: string, char: string, hypothesis: string): CatalogEntry => ({
  usage: name,
  hypothesis,
  signature: "any -> same",
  build: (token) => {
    requireNoIntensity(token)
    rejectUnusedArgs(token, new Set(), [])
    return trailingStage(name, char)
  }
})

const hexCase = (to: "upper" | "lower"): CatalogEntry => ({
  usage: `hex_case_${to}`,
  hypothesis: "the blocklist matches escape sequences in one letter case only",
  signature: "escapes -> escapes",
  build: (token) => {
    requireNoIntensity(token)
    rejectUnusedArgs(token, new Set(), [])
    return segmentStage(
      `hex_case_${to}`,
      { accepts: ["escapes"], produces: "escapes" },
      (text) => hexCaseText(text, to)
    )
  }
})

const CATALOG: Readonly<Record<string, CatalogEntry>> = {
  url_encode: {
    usage: 'url_encode:N [ (charset="./\\\\") ]',
    hypothesis: "the filter checks the value before exactly N decodes happen",
    signature: "text -> escapes",
    build: (token, defaults) => {
      const used = new Set<string>()
      const passes = requireCount(token)
      const charset = charsetOf(token, used, defaults)
      rejectUnusedArgs(token, used, ["charset"])
      // A charset that differs from the pipeline default is part of the stage's
      // IDENTITY, so it belongs in the label: two `url_encode:1` entries that
      // escape different characters are two different hypotheses, and a report
      // that printed both as `url_encode:1` would be lying.
      const name = charset === defaults.charset
        ? `url_encode:${passes}`
        : `url_encode:${passes}(charset=${JSON.stringify(charset)})`
      return segmentStage(
        name,
        { accepts: ["text"], produces: "escapes" },
        (text) => urlEncodeText(text, charset, passes)
      )
    }
  },
  hex_case_upper: hexCase("upper"),
  hex_case_lower: hexCase("lower"),
  overlong_utf8: {
    usage: "overlong_utf8 | overlong_utf8(+dots)",
    hypothesis: "the filter's UTF-8 decoder is strict, a downstream one is lax",
    signature: "path -> escapes",
    build: (token) => {
      requireNoIntensity(token)
      const used = new Set<string>()
      const dots = takeFlag(token, used, "dots")
      rejectUnusedArgs(token, used, ["+dots"])
      return segmentStage(
        dots ? "overlong_utf8(+dots)" : "overlong_utf8",
        { accepts: ["path"], produces: "escapes" },
        (text) => replaceChars(text, dots ? OVERLONG_DOTS : OVERLONG)
      )
    }
  },
  fullwidth: simple(
    "fullwidth",
    "NFKC normalisation folds the character back to '/' after the check",
    { accepts: ["path"], produces: "escapes" },
    (text) => replaceChars(text, FULLWIDTH),
    "path -> escapes"
  ),
  utf16_escape: {
    usage: 'utf16_escape [ (codepoint="2215") ]',
    hypothesis:
      "the server resolves the non-standard '%uXXXX' form the filter has no rule for",
    signature: "path -> escapes",
    build: (token) => {
      requireNoIntensity(token)
      const used = new Set<string>()
      const codepoint = (takeValue(token, used, "codepoint") ?? UTF16_SLASH_DEFAULT)
        .toLowerCase()
      rejectUnusedArgs(token, used, ["codepoint"])
      if (!/^[0-9a-f]{4}$/.test(codepoint)) {
        throw new PipelineError(
          `strategy '${token.raw}': 'codepoint' is four hex digits naming the ` +
            `codepoint '/' is spelled as, e.g. utf16_escape(codepoint="2044") for ` +
            `U+2044 FRACTION SLASH; got '${codepoint}'.`
        )
      }
      return segmentStage(
        codepoint === UTF16_SLASH_DEFAULT
          ? "utf16_escape"
          : `utf16_escape(codepoint="${codepoint}")`,
        { accepts: ["path"], produces: "escapes" },
        (text) =>
          replaceChars(text, { "/": `%u${codepoint}`, "\\": UTF16_BACKSLASH })
      )
    }
  },
  double_percent: simple(
    "double_percent",
    "two decodes happen after the check, and '%25' never appears on the wire",
    { accepts: ["path"], produces: "escapes" },
    (text) => replaceChars(text, DOUBLE_PERCENT),
    "path -> escapes"
  ),
  dot_noise: noise(
    "dot_noise",
    "/./",
    "the filter pattern-matches sequences a normalizer later collapses"
  ),
  double_slash: noise(
    "double_slash",
    "//",
    "the filter collapses repeated separators only after it has checked"
  ),
  backtrack: noise(
    "backtrack",
    "/zz/../",
    "a decoy directory survives the filter and the resolver throws it away"
  ),
  matrix_param: noise(
    "matrix_param",
    ";a=b/",
    "the servlet container strips matrix parameters after the filter ran"
  ),
  selective_first: selective(
    "selective_first",
    "the stack decodes once and then checks, so the first escape survives",
    () => new Set([0])
  ),
  selective_last: selective(
    "selective_last",
    "the stack decodes once and then checks, so the last escape survives",
    (total) => new Set([total - 1])
  ),
  selective_alternating: selective(
    "selective_alternating",
    "a normalizer rewrites runs, so alternating escapes break its pattern",
    (total) => {
      const chosen = new Set<number>()
      for (let index = 0; index < total; index += 2) chosen.add(index)
      return chosen
    }
  ),
  base64: {
    usage: "base64",
    hypothesis: "the app base64-decodes the parameter before using it as a path",
    signature: "text -> opaque",
    build: (token) => {
      requireNoIntensity(token)
      rejectUnusedArgs(token, new Set(), [])
      return runStage("base64", { accepts: ["text"], produces: "opaque" }, base64Text)
    }
  },
  path_case_upper: simple(
    "path_case_upper",
    "the filesystem is case-insensitive but the filter is case-sensitive",
    { accepts: ["path"], produces: "preserve" },
    (text) => text.toUpperCase(),
    "path -> path"
  ),
  padding: {
    usage: "padding:N",
    hypothesis: "a path-length limit truncates an extension the app appends",
    signature: "any -> same",
    build: (token) => {
      const count = requireCount(token)
      rejectUnusedArgs(token, new Set(), [])
      return paddingStage(count)
    }
  },
  trailing_dot: trailing(
    "trailing_dot",
    ".",
    "Win32 strips a trailing '.' from the resolved name"
  ),
  trailing_space: trailing(
    "trailing_space",
    " ",
    "Win32 strips a trailing space from the resolved name"
  )
}

/**
 * Names that existed before §5 split intensity from identity, and the names they
 * became.
 *
 * Keyed by `name` or `name:intensity`, so `noise:dot` gets a precise answer and a
 * bare `noise` gets the family.
 */
const RENAMED: Readonly<Record<string, string>> = {
  "noise:dot": "dot_noise",
  "noise:double_slash": "double_slash",
  "noise:backtrack": "backtrack",
  "noise:matrix_param": "matrix_param",
  noise: "dot_noise, double_slash, backtrack or matrix_param",
  "selective:first": "selective_first",
  "selective:last": "selective_last",
  "selective:alternating": "selective_alternating",
  selective: "selective_first, selective_last or selective_alternating",
  "hex_case:upper": "hex_case_upper",
  "hex_case:lower": "hex_case_lower",
  hex_case: "hex_case_upper or hex_case_lower",
  "path_case:upper": "path_case_upper",
  path_case: "path_case_upper"
}

/** Every valid strategy name, with its argument shape. For error messages and docs. */
export const STRATEGY_CATALOG: ReadonlyArray<{
  readonly usage: string
  readonly hypothesis: string
  readonly signature: string
}> = [
  { usage: "plain", hypothesis: "the path is not filtered at all", signature: "path -> path" },
  ...Object.values(CATALOG).map(({ hypothesis, signature, usage }) => ({
    usage,
    hypothesis,
    signature
  }))
]

const catalogHelp = (): string =>
  STRATEGY_CATALOG.map(({ signature, usage }) =>
    `  ${usage.padEnd(38)} ${signature}`
  ).join("\n")

// ---------------------------------------------------------------------------
// Pipeline parsing
// ---------------------------------------------------------------------------

export interface ParsedPipeline {
  /** Canonical rendering of the whole pipeline, used in reports. */
  readonly label: string
  readonly stages: ReadonlyArray<Stage>
  /** The kind the whole pipeline leaves the payload in. */
  readonly produces: Kind
}

/**
 * Parse `"url_encode:1 > hex_case_upper"` into an ordered list of stages, and
 * TYPE-CHECK the ordering while doing it.
 *
 * The payload starts life as a `path` -- literal separators, no escapes -- and
 * each stage's signature says what it needs and what it leaves behind. That one
 * rule replaces v1's single bespoke check (`hex_case` must follow something that
 * produces escapes) and catches the whole class it belonged to:
 *
 *   hex_case_upper                 escapes required, got path    rejected
 *   base64 > dot_noise             path required, got opaque     rejected
 *   base64 > overlong_utf8         path required, got opaque     rejected
 *   base64 > path_case_upper       path required, got opaque     rejected
 *   base64 > url_encode:1          text accepts opaque           allowed
 *
 * `charset` is the default for stages that do not set their own with
 * `(charset="...")`.
 */
export const parsePipeline = (source: string, charset: string): ParsedPipeline => {
  const raws = source
    .split(">")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)

  if (raws.length === 0) {
    throw new PipelineError(
      `empty pipeline.\nValid strategies:\n${catalogHelp()}`
    )
  }

  const defaults: Defaults = { charset }
  const labels: Array<string> = []
  const stages: Array<Stage> = []
  let kind: Kind = "path"

  for (const raw of raws) {
    if (raw === "plain") {
      labels.push("plain")
      continue
    }
    const token = tokenize(raw)

    const renamedKey = token.intensity === undefined
      ? token.name
      : `${token.name}:${token.intensity}`
    const replacement = RENAMED[renamedKey] ?? RENAMED[token.name]
    if (replacement !== undefined && CATALOG[token.name] === undefined) {
      throw new PipelineError(
        `strategy '${renamedKey}' was renamed to '${replacement}': ':' now means ` +
          `INTENSITY only (url_encode:1|2|3, padding:N), so techniques that merely ` +
          `shared a namespace each got their own name.`
      )
    }

    const entry = CATALOG[token.name]
    if (entry === undefined) {
      throw new PipelineError(
        `unknown strategy '${token.name}'.\nValid strategies:\n${catalogHelp()}`
      )
    }
    const stage = entry.build(token, defaults)

    const accepted = stage.signature.accepts.some((required) => subsumes(required, kind))
    if (!accepted) {
      const wanted = stage.signature.accepts
        .map((required) => `'${required}'`)
        .join(" or ")
      const producer = stages.length === 0
        ? "the assembled payload"
        : `'${stages[stages.length - 1]!.name}'`
      throw new PipelineError(
        `'${stage.name}' needs ${wanted} (${
          WHY[stage.signature.accepts[0]!]
        }), but ${producer} produced '${kind}'. ` +
          `Stage signatures:\n${catalogHelp()}`
      )
    }

    if (stage.signature.produces !== "preserve") kind = stage.signature.produces
    labels.push(stage.name)
    stages.push(stage)
  }

  return { label: labels.join(" > "), stages, produces: kind }
}

/** Run a parsed pipeline over an assembled payload. */
export const applyStages = (
  segments: ReadonlyArray<Segment>,
  stages: ReadonlyArray<Stage>,
  context: StageContext = {}
): ReadonlyArray<Segment> => {
  let current = segments
  for (const stage of stages) {
    current = stage.apply(current, context)
  }
  return current
}
