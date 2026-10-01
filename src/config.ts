import { Schema } from "effect"
import * as NodePath from "node:path"
import { parse as parseYaml } from "yaml"
import {
  DEFAULT_URL_ENCODE_CHARSET,
  parsePipeline,
  PipelineError,
  STRIP_RULES,
  SYNTHETIC,
  type Stage,
  type StripRule
} from "./core/index.ts"
import { PtError } from "./errors.ts"
import { shortSlotPath } from "./report.ts"

const NonEmptyText = Schema.String.check(Schema.isNonEmpty())
const PathList = Schema.Array(NonEmptyText)
/** A file reference accepts a single path or a list of them. */
const PathRef = Schema.Union([NonEmptyText, PathList])

const NonNegativeInt = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0)
)

const PositiveInt = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(1)
)

/**
 * One slot, as written on disk.
 *
 * This is the whole of §1: an ORDERED LIST of positions, each carrying its own
 * properties, in place of v1's four fixed dimensions plus `traversal_depth` plus
 * three `include_payloads_without_*` booleans plus `do_not_transform`.
 */
const SlotSchema = Schema.Struct({
  name: NonEmptyText,
  files: Schema.optional(PathRef),
  /** Does this slot have an empty member? v1's `include_payloads_without_*`. */
  optional: Schema.optional(Schema.Boolean),
  /** The repeat ladder. v1's `traversal_depth`, which only one dimension had. */
  repeat: Schema.optional(Schema.Array(PositiveInt)),
  /** May a strategy rewrite these bytes? v1's `do_not_transform`, co-located. */
  transform: Schema.optional(Schema.Boolean),
  // The one source of truth for the rule names lives in core/assemble.ts.
  strip_leading_separator: Schema.optional(Schema.Literals(STRIP_RULES))
})

/** The YAML config file, exactly as written on disk. */
const ConfigFileSchema = Schema.Struct({
  slots: Schema.Array(SlotSchema),
  raw_file: Schema.optional(PathList),
  output_file: NonEmptyText,
  overwrite_output_file: Schema.optional(Schema.Boolean),
  /** Always scalar strings. See `parseStrategyEntry`. */
  strategies: Schema.optional(Schema.Array(NonEmptyText)),
  url_encode_charset: Schema.optional(Schema.String),
  limits: Schema.optional(
    Schema.Struct({
      warn_above: Schema.optional(NonNegativeInt),
      max_payloads: Schema.optional(PositiveInt)
    })
  )
})

const decodeConfigFile = Schema.decodeUnknownResult(ConfigFileSchema)

/** Defaults applied to every key the user may omit. */
export const DEFAULTS = {
  overwriteOutputFile: false,
  strategies: ["plain"] as ReadonlyArray<string>,
  urlEncodeCharset: DEFAULT_URL_ENCODE_CHARSET,
  slotOptional: false,
  slotTransform: true,
  slotRepeat: [1] as ReadonlyArray<number>,
  /**
   * The strip rule every slot gets unless it says otherwise.
   *
   * `when_same_separator` is the safe default because it is a no-op everywhere it
   * is not needed: it only fires when the slot's text begins with a separator AND
   * the text in front of it ends in the same separator, which is precisely the
   * doubled separator the rule exists to remove.
   */
  slotStrip: "when_same_separator" as StripRule
} as const

/**
 * Keys pt no longer has, and the sentence that migrates each one.
 *
 * v1 -> v2 is a breaking config change, so every removed key has to say what
 * replaced it rather than merely being rejected as unknown.
 */
const REMOVED_KEYS: Readonly<Record<string, string>> = {
  url_encode:
    "replaced by 'strategies'. Instead of 'url_encode: [0, 1, 2]' list the passes you want as separate members: '- plain', '- url_encode:1', '- url_encode:2'.",
  base64_encode:
    "replaced by 'strategies'. Instead of 'base64_encode: [0, 1]' add '- base64' as a strategy member.",
  prefix_file:
    "replaced by 'slots'. Write '- { name: prefix, files: [...], optional: true }' as the first entry of the ordered 'slots' list.",
  traversal_file:
    "replaced by 'slots'. Write '- { name: traversal, files: [...], optional: true, repeat: [3, 6, 10, 16] }' as a 'slots' entry.",
  target_file:
    "replaced by 'slots'. Write '- { name: target, files: [...] }' as a 'slots' entry -- a slot with 'optional' unset is the one with no empty member.",
  suffix_file:
    "replaced by 'slots'. Write '- { name: suffix, files: [...], optional: true, transform: false }' as the last 'slots' entry.",
  traversal_depth:
    "replaced by the 'repeat' property of the slot it applies to: '- { name: traversal, files: [...], repeat: [3, 6, 10, 16] }'. Any slot can repeat now, not just one.",
  include_payloads_without_prefix:
    "replaced by the 'optional' property of the slot: 'optional: true' gives that slot an empty member.",
  include_payloads_without_traversal:
    "replaced by the 'optional' property of the slot: 'optional: true' gives that slot an empty member.",
  include_payloads_without_suffix:
    "replaced by the 'optional' property of the slot: 'optional: true' gives that slot an empty member.",
  do_not_transform:
    "replaced by 'transform: false' on the slot itself, which needs no path matching and cannot be misspelled. For a one-line exception, prefix that line with '!' in the file ('!!' for a literal leading '!')."
}

export interface SlotOverrideConfig {
  readonly files?: ReadonlyArray<string>
  readonly repeat?: ReadonlyArray<number>
}

/** One member of the strategy union, validated and with its paths resolved. */
export interface StrategyConfig {
  readonly label: string
  readonly stages: ReadonlyArray<Stage>
  /** Per-slot overrides, by slot name. */
  readonly overrides: Readonly<Record<string, SlotOverrideConfig>>
  /** The overrides rendered short, so the report can tell two `plain`s apart. */
  readonly note?: string
}

export interface SlotConfig {
  readonly name: string
  readonly files: ReadonlyArray<string>
  readonly optional: boolean
  readonly repeat: ReadonlyArray<number>
  readonly transform: boolean
  readonly strip: StripRule
}

export interface Limits {
  readonly warnAbove?: number
  readonly maxPayloads?: number
}

/** A config with defaults applied and every path resolved to absolute. */
export interface PtConfig {
  readonly slots: ReadonlyArray<SlotConfig>
  readonly rawFiles: ReadonlyArray<string>
  readonly outputFile: string
  readonly overwriteOutputFile: boolean
  readonly strategies: ReadonlyArray<StrategyConfig>
  readonly limits: Limits
}

const indent = (text: string): string =>
  text.split("\n").map((line) => `  ${line}`).join("\n")

const SLOT_NAME = /^[a-z][a-z0-9_]*$/

/**
 * Split a strategy entry into its pipeline and its per-slot overrides.
 *
 * §9: `strategies` is ALWAYS a list of scalar strings now. v1 allowed a string or
 * a mapping, the schema modelled that as a union, and every consumer branched on
 * the entry's type -- for the sake of one key, `charset`, which §4's inline stage
 * arguments now carry (`url_encode:1(charset="+/=")`). What the mapping form still
 * had to carry was the per-strategy slot overrides, so they move into the string
 * after a `|`:
 *
 *     plain
 *     url_encode:1(charset=".")
 *     plain | target=./templates/windows/target.txt, traversal=
 *     padding:2048 | target=./templates/target-padding.txt, traversal.repeat=3
 *
 * `slot=` with nothing after it means "no files", which with `optional: true`
 * leaves just the empty member -- v1 needed a real empty file on disk to say that.
 * Repeating a slot name unions its files.
 */
export const parseStrategyEntry = (
  entry: string
): {
  readonly pipeline: string
  readonly overrides: Readonly<Record<string, { files?: Array<string>; repeat?: Array<number> }>>
} => {
  const bar = entry.indexOf("|")
  if (bar < 0) return { pipeline: entry.trim(), overrides: {} }
  const pipeline = entry.slice(0, bar).trim()
  const overrides: Record<string, { files?: Array<string>; repeat?: Array<number> }> = {}

  for (const chunk of entry.slice(bar + 1).split(",")) {
    const text = chunk.trim()
    if (text.length === 0) continue
    const equals = text.indexOf("=")
    if (equals < 0) {
      throw new PipelineError(
        `slot override '${text}' needs an '=': write 'slotName=path' or 'slotName.repeat=3 6'.`
      )
    }
    const key = text.slice(0, equals).trim()
    const value = text.slice(equals + 1).trim()
    const dot = key.indexOf(".")
    const slot = dot < 0 ? key : key.slice(0, dot)
    const property = dot < 0 ? "files" : key.slice(dot + 1)
    if (!SLOT_NAME.test(slot)) {
      throw new PipelineError(
        `slot override '${text}': '${slot}' is not a slot name (lowercase, digits and '_').`
      )
    }
    const bucket = overrides[slot] ?? (overrides[slot] = {})
    if (property === "files") {
      bucket.files ??= []
      if (value.length > 0) bucket.files.push(value)
    } else if (property === "repeat") {
      const numbers = value.split(/\s+/).filter((part) => part.length > 0).map(Number)
      if (numbers.length === 0 || numbers.some((n) => !Number.isInteger(n) || n < 1)) {
        throw new PipelineError(
          `slot override '${text}': 'repeat' needs one or more positive integers, e.g. '${slot}.repeat=3 6'.`
        )
      }
      bucket.repeat = [...(bucket.repeat ?? []), ...numbers]
    } else {
      throw new PipelineError(
        `slot override '${text}': '${property}' cannot be overridden per strategy; only 'files' (the default) and 'repeat' can.`
      )
    }
  }

  return { pipeline, overrides }
}

/**
 * Parse and validate a config file's text.
 *
 * `baseDir` is the directory the config file itself lives in; every relative path
 * inside the config resolves against it, so a config is portable and
 * `pt --config /elsewhere/pt.yml` behaves the way you would expect.
 */
export const parseConfig = (
  source: string,
  baseDir: string,
  configPathForMessages: string
): PtConfig => {
  const fail = (message: string, cause?: unknown): never => {
    throw new PtError(`${configPathForMessages}: ${message}`, { cause })
  }

  let raw: unknown
  try {
    raw = parseYaml(source)
  } catch (cause) {
    return fail(
      `not valid YAML: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause
    )
  }

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return fail(
      `expected a YAML mapping at the top level, got ${
        raw === null ? "an empty document" : Array.isArray(raw) ? "a list" : typeof raw
      }`
    )
  }

  for (const [key, advice] of Object.entries(REMOVED_KEYS)) {
    if (key in raw) fail(`'${key}' was removed: ${advice}`)
  }

  // A v1 mapping strategy is a type error the schema would report obscurely, so
  // catch it here and name the replacement.
  const rawStrategies = (raw as Record<string, unknown>)["strategies"]
  if (Array.isArray(rawStrategies)) {
    rawStrategies.forEach((entry, index) => {
      if (entry !== null && typeof entry === "object") {
        const mapping = entry as Record<string, unknown>
        const pipeline = typeof mapping["pipeline"] === "string"
          ? mapping["pipeline"]
          : "<pipeline>"
        const parts: Array<string> = []
        if (typeof mapping["charset"] === "string") {
          parts.push(`charset moves into the stage: '${pipeline}(charset="${
            mapping["charset"]
          }")'`)
        }
        for (const key of ["prefixes", "traversals", "targets", "suffixes"]) {
          if (mapping[key] === undefined) continue
          const slot = key.replace(/e?s$/, "")
          parts.push(`'${key}' becomes '| ${slot}=<path>' after the pipeline`)
        }
        if (mapping["depths"] !== undefined) {
          parts.push(`'depths' becomes '| <slot>.repeat=3 6' after the pipeline`)
        }
        fail(
          `strategies[${index}] is a mapping; strategies are always scalar strings now. ` +
            `Write '- "${pipeline} | target=./file.txt"'.${
              parts.length > 0 ? ` Specifically: ${parts.join("; ")}.` : ""
            }`
        )
      }
    })
  }

  const decoded = decodeConfigFile(raw, {
    errors: "all",
    onExcessProperty: "error"
  })
  if (decoded._tag === "Failure") {
    return fail(`invalid config:\n${indent(decoded.failure.message)}`, decoded.failure)
  }
  const config = decoded.success

  const resolve = (path: string) => NodePath.resolve(baseDir, path)
  const resolveRef = (ref: string | ReadonlyArray<string> | undefined) =>
    ref === undefined ? [] : typeof ref === "string" ? [resolve(ref)] : ref.map(resolve)

  // ------------------------------------------------------------------- slots
  if (config.slots.length === 0) {
    fail(
      `'slots' must list at least one slot. A slot is one ordered position in the payload: '- { name: target, files: [./templates/linux/target.txt] }'.`
    )
  }

  const seen = new Set<string>()
  const slots: Array<SlotConfig> = config.slots.map((slot, index) => {
    const where = `slots[${index}]`
    if (!SLOT_NAME.test(slot.name)) {
      fail(
        `${where}: '${slot.name}' is not a usable slot name. Use lowercase letters, digits and '_', starting with a letter.`
      )
    }
    if (slot.name === SYNTHETIC) {
      fail(
        `${where}: '${SYNTHETIC}' is reserved -- it is the slot name pt gives segments a strategy invented (a 'padding:N' run, a 'base64' blob). Pick another name.`
      )
    }
    if (seen.has(slot.name)) {
      fail(
        `${where}: slot name '${slot.name}' is used twice. Slot names identify a slot in a strategy override, so they have to be unique; two traversal positions could be 'traversal' and 'traversal_2'.`
      )
    }
    seen.add(slot.name)

    const files = resolveRef(slot.files)
    const optional = slot.optional ?? DEFAULTS.slotOptional
    const repeat = slot.repeat ?? DEFAULTS.slotRepeat
    if (slot.repeat !== undefined && slot.repeat.length === 0) {
      fail(`${where}: 'repeat' must not be an empty list; omit it for a single pass.`)
    }
    if (!optional && files.length === 0) {
      fail(
        `${where}: slot '${slot.name}' is required (no 'optional: true') but names no files, so it can never contribute anything and the whole product collapses. Add 'files', or 'optional: true'.`
      )
    }
    return {
      name: slot.name,
      files,
      optional,
      repeat,
      transform: slot.transform ?? DEFAULTS.slotTransform,
      strip: slot.strip_leading_separator ?? DEFAULTS.slotStrip
    }
  })

  if (slots.every((slot) => slot.optional)) {
    fail(
      `every slot is 'optional: true', so pt would be allowed to emit the empty payload and nothing else is guaranteed. At least one slot must be required -- in the default config that is the target, the one slot with no empty member.`
    )
  }

  const slotNames = new Set(slots.map((slot) => slot.name))
  const rawFiles = (config.raw_file ?? []).map(resolve)

  // -------------------------------------------------------------- strategies
  const defaultCharset = config.url_encode_charset ?? DEFAULTS.urlEncodeCharset
  const entries = config.strategies ?? DEFAULTS.strategies
  if (entries.length === 0) {
    fail(`'strategies' must not be an empty list (use '- plain' for no rewrite).`)
  }

  const strategies: Array<StrategyConfig> = []

  entries.forEach((entry, index) => {
    const where = `strategies[${index}]`

    let split
    try {
      split = parseStrategyEntry(entry)
    } catch (cause) {
      return void fail(
        `${where} ('${entry}'): ${
          cause instanceof PipelineError ? cause.message : String(cause)
        }`,
        cause
      )
    }

    let parsed
    try {
      parsed = parsePipeline(split.pipeline, defaultCharset)
    } catch (cause) {
      return void fail(
        `${where} ('${split.pipeline}'): ${
          cause instanceof PipelineError ? cause.message : String(cause)
        }`,
        cause
      )
    }

    const overrides: Record<string, SlotOverrideConfig> = {}
    for (const [name, override] of Object.entries(split.overrides)) {
      if (!slotNames.has(name)) {
        fail(
          `${where}: override names slot '${name}', which no 'slots' entry declares. Declared slots: ${
            slots.map((slot) => slot.name).join(", ")
          }.`
        )
      }
      const slot = slots.find((candidate) => candidate.name === name)!
      const files = override.files?.map(resolve)
      if (files !== undefined && files.length === 0 && !slot.optional) {
        fail(
          `${where}: override turns off required slot '${name}' ('${name}=' with no path). A required slot must always have files; mark the slot 'optional: true' if a strategy may skip it.`
        )
      }
      overrides[name] = {
        ...(files !== undefined ? { files } : {}),
        ...(override.repeat !== undefined ? { repeat: override.repeat } : {})
      }
    }

    const note = renderOverrides(overrides)
    strategies.push({
      label: parsed.label,
      stages: parsed.stages,
      overrides,
      ...(note !== undefined ? { note } : {})
    })
  })

  return {
    slots,
    rawFiles,
    outputFile: resolve(config.output_file),
    overwriteOutputFile:
      config.overwrite_output_file ?? DEFAULTS.overwriteOutputFile,
    strategies,
    limits: {
      ...(config.limits?.warn_above !== undefined
        ? { warnAbove: config.limits.warn_above }
        : {}),
      ...(config.limits?.max_payloads !== undefined
        ? { maxPayloads: config.limits.max_payloads }
        : {})
    }
  }
}

/**
 * Render a strategy's slot overrides short enough for a report column.
 *
 * Short paths only, and `off` for a slot turned off, because the point is to tell
 * a dozen `plain` entries apart and not to repeat the config.
 */
const renderOverrides = (
  overrides: Readonly<Record<string, SlotOverrideConfig>>
): string | undefined => {
  const parts: Array<string> = []
  for (const [name, override] of Object.entries(overrides)) {
    if (override.files !== undefined) {
      parts.push(
        `${name}=${
          override.files.length === 0
            ? "off"
            : override.files.map(shortSlotPath).join("+")
        }`
      )
    }
    if (override.repeat !== undefined) {
      parts.push(`${name}.repeat=${override.repeat.join(" ")}`)
    }
  }
  return parts.length === 0 ? undefined : parts.join(", ")
}
