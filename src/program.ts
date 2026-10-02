import { Effect, FileSystem } from "effect"
import * as NodeFs from "node:fs"
import * as NodePath from "node:path"
import type { PtConfig, SlotConfig, StrategyConfig } from "./config.ts"
import { parseConfig } from "./config.ts"
import {
  decompose,
  fingerprintStore,
  generate,
  parseLines,
  toSegments,
  type Decomposition,
  type GenerateResult,
  type Segment,
  type Slot,
  type SlotOverride,
  type SourceLine,
  type Strategy
} from "./core/index.ts"
import { PtError } from "./errors.ts"
import {
  DEFAULT_STYLE,
  formatReport,
  formatStrategyTable,
  type ReportStyle
} from "./report.ts"
import { CONFIG_YML, SEED_TEMPLATES } from "./seed.ts"

const readText = (path: string, what: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readFileString(path).pipe(
      Effect.mapError(
        (cause) =>
          new PtError(`cannot read ${what} '${path}': ${cause.message}`, { cause })
      )
    )
  })

/** Parsed lines per absolute path, so a file shared by several slots is read once. */
type LineCache = Map<string, ReadonlyArray<SourceLine>>

const loadLines = (
  path: string,
  what: string,
  cache: LineCache
): Effect.Effect<ReadonlyArray<SourceLine>, PtError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const cached = cache.get(path)
    if (cached !== undefined) return cached
    const lines = parseLines(yield* readText(path, what))
    cache.set(path, lines)
    return lines
  })

/**
 * Load one slot's members.
 *
 * Several files in one slot are UNIONed, not cross-producted. The transform flag
 * comes from the slot itself, with a leading `!` on a line flipping it -- no path
 * resolution, no typo check, and nothing to misspell, which is three things v1's
 * `do_not_transform` needed.
 */
const loadMembers = (
  files: ReadonlyArray<string>,
  slot: string,
  transform: boolean,
  what: string,
  cache: LineCache
): Effect.Effect<Array<Segment>, PtError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const members: Array<Segment> = []
    for (const file of files) {
      const lines = yield* loadLines(file, what, cache)
      members.push(...toSegments(lines, slot, transform, file))
    }
    return members
  })

const loadSlots = (
  config: PtConfig,
  cache: LineCache
): Effect.Effect<Array<Slot>, PtError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const slots: Array<Slot> = []
    for (const slot of config.slots) {
      const members = yield* loadMembers(
        slot.files,
        slot.name,
        slot.transform,
        `slot '${slot.name}'`,
        cache
      )
      if (!slot.optional && members.length === 0) {
        return yield* Effect.fail(
          new PtError(
            `slot '${slot.name}' is required but loaded no members: every file it names is empty or contains only comments (${
              slot.files.join(", ")
            })`
          )
        )
      }
      slots.push({
        name: slot.name,
        members,
        optional: slot.optional,
        repeat: slot.repeat,
        strip: slot.strip
      })
    }
    return slots
  })

const buildStrategy = (
  strategy: StrategyConfig,
  config: PtConfig,
  cache: LineCache
): Effect.Effect<Strategy, PtError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const overrides: Record<string, SlotOverride> = {}
    for (const [name, override] of Object.entries(strategy.overrides)) {
      const slot = config.slots.find((candidate) => candidate.name === name)!
      const next: { members?: Array<Segment>; repeat?: ReadonlyArray<number> } = {}
      if (override.files !== undefined) {
        next.members = yield* loadMembers(
          override.files,
          name,
          slot.transform,
          `slot '${name}' override for strategy '${strategy.label}'`,
          cache
        )
        if (!slot.optional && next.members.length === 0) {
          return yield* Effect.fail(
            new PtError(
              `strategy '${strategy.label}': its '${name}' override loaded no members (every file is blank or comments only), and '${name}' is a required slot`
            )
          )
        }
      }
      if (override.repeat !== undefined) next.repeat = override.repeat
      overrides[name] = next
    }
    return {
      label: strategy.label,
      stages: strategy.stages,
      ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
      ...(strategy.note !== undefined ? { note: strategy.note } : {})
    }
  })

const loadRaw = (
  config: PtConfig,
  cache: LineCache
): Effect.Effect<Array<string>, PtError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const raw: Array<string> = []
    for (const file of config.rawFiles) {
      for (const line of yield* loadLines(file, "raw_file", cache)) {
        raw.push(line.text)
      }
    }
    return raw
  })

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const thousands = (value: number): string => value.toLocaleString("en-US")

/**
 * A line sink that appends to a file descriptor through a bounded buffer.
 *
 * This is the other half of §7. The generator never reads a payload back, so the
 * only reason v1 held 185,106 strings in memory was to join them at the end --
 * and that join built one more copy of the entire file as a single string. Here
 * each freshly-seen payload is appended to a 256 KB buffer which is flushed with
 * a synchronous write, so what the output costs is one buffer rather than a copy
 * of the whole file.
 *
 * `node:fs` rather than the Effect `FileSystem`, deliberately: `generate` is a
 * pure synchronous function and there is nowhere inside its loop to yield.
 */
const lineSink = (path: string) => {
  const fd = NodeFs.openSync(path, "w")
  let buffer = ""
  const flush = () => {
    if (buffer.length === 0) return
    NodeFs.writeSync(fd, buffer)
    buffer = ""
  }
  return {
    write: (line: string): void => {
      buffer += line
      buffer += "\n"
      if (buffer.length >= 1 << 18) flush()
    },
    close: (): void => {
      flush()
      NodeFs.closeSync(fd)
    },
    abort: (): void => {
      try {
        NodeFs.closeSync(fd)
      } catch {
        // already closed
      }
      try {
        NodeFs.unlinkSync(path)
      } catch {
        // never created
      }
    }
  }
}

export interface GenerateReport {
  readonly dryRun: boolean
  readonly outputFile: string
  readonly count: number
  readonly breakdown: string
  /** Set when the run crossed `limits.warn_above`. */
  readonly warning?: string
}

export interface GenerateOptions {
  readonly dryRun: boolean
  readonly style?: ReportStyle
}

/** `pt --config ./pt.yml [--dry-run]` */
export const runGenerate = (
  configPath: string,
  options: GenerateOptions
): Effect.Effect<GenerateReport, PtError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const style = options.style ?? DEFAULT_STYLE
    const config = yield* loadConfig(configPath)

    // Fail before doing any work if the output is in the way.
    if (!options.dryRun) {
      const outputExists = yield* fs.exists(config.outputFile).pipe(
        Effect.mapError(
          (cause) =>
            new PtError(
              `cannot stat output file '${config.outputFile}': ${cause.message}`,
              { cause }
            )
        )
      )
      if (outputExists && !config.overwriteOutputFile) {
        return yield* Effect.fail(
          new PtError(
            `output file '${config.outputFile}' already exists and 'overwrite_output_file' is false; ` +
              `set it to true or choose another 'output_file'.`
          )
        )
      }
    }

    const cache: LineCache = new Map()
    const slots = yield* loadSlots(config, cache)
    const raw = yield* loadRaw(config, cache)
    const strategies: Array<Strategy> = []
    for (const strategy of config.strategies) {
      strategies.push(yield* buildStrategy(strategy, config, cache))
    }

    // Written to a sibling `.part` and renamed on success, so a run that trips
    // `max_payloads` never leaves a truncated wordlist behind.
    let sink: ReturnType<typeof lineSink> | undefined
    let partPath: string | undefined
    if (!options.dryRun) {
      const outputDir = NodePath.dirname(config.outputFile)
      yield* fs.makeDirectory(outputDir, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new PtError(
              `cannot create output directory '${outputDir}': ${cause.message}`,
              { cause }
            )
        )
      )
      partPath = `${config.outputFile}.part`
      sink = yield* Effect.try({
        try: () => lineSink(partPath!),
        catch: (cause) =>
          new PtError(
            `cannot write output file '${partPath}': ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
            { cause }
          )
      })
    }

    const result = yield* Effect.try({
      try: (): GenerateResult =>
        generate(slots, {
          strategies,
          raw,
          store: fingerprintStore(
            sink === undefined ? undefined : (payload) => sink!.write(payload)
          ),
          attribute: options.dryRun,
          ...(config.limits.maxPayloads !== undefined
            ? { maxPayloads: config.limits.maxPayloads }
            : {})
        }),
      catch: (cause) => {
        sink?.abort()
        return cause instanceof PtError
          ? cause
          : new PtError(`generation failed: ${String(cause)}`, { cause })
      }
    })

    const count = result.total
    const breakdown = formatReport(result, style)

    if (result.exceeded) {
      sink?.abort()
      return yield* Effect.fail(
        new PtError(
          `stopped: this config generates more than ${
            thousands(config.limits.maxPayloads!)
          } unique payloads ('limits.max_payloads'). ` +
            `Prune strategies, repeats or slot files, or raise the limit deliberately.\n` +
            `Breakdown up to the stop point:\n${formatStrategyTable(result, style)}`
        )
      )
    }

    const warnAbove = config.limits.warnAbove
    const warning = warnAbove !== undefined && count > warnAbove
      ? `warning: ${thousands(count)} payloads exceeds 'limits.warn_above' (${
        thousands(warnAbove)
      }).`
      : undefined

    if (sink !== undefined && partPath !== undefined) {
      yield* Effect.try({
        try: () => {
          sink!.close()
          NodeFs.renameSync(partPath!, config.outputFile)
        },
        catch: (cause) =>
          new PtError(
            `cannot write output file '${config.outputFile}': ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
            { cause }
          )
      })
    }

    return {
      dryRun: options.dryRun,
      outputFile: config.outputFile,
      count,
      breakdown,
      ...(warning !== undefined ? { warning } : {})
    }
  })

const loadConfig = (
  configPath: string
): Effect.Effect<PtConfig, PtError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const absoluteConfig = NodePath.resolve(configPath)
    const source = yield* readText(absoluteConfig, "config file")
    return yield* Effect.try({
      try: () => parseConfig(source, NodePath.dirname(absoluteConfig), configPath),
      catch: (cause) =>
        cause instanceof PtError
          ? cause
          : new PtError(`${configPath}: ${String(cause)}`, { cause })
    })
  })

// ---------------------------------------------------------------------------
// Scaffold
// ---------------------------------------------------------------------------

export interface ScaffoldReport {
  readonly configFile: string
  readonly written: ReadonlyArray<string>
  /** Templates left untouched because a file already existed there. */
  readonly skipped: ReadonlyArray<string>
}

/** `pt --generate-basic-config ./pt.yml` */
export const runScaffold = (
  configPath: string
): Effect.Effect<ScaffoldReport, PtError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const absoluteConfig = NodePath.resolve(configPath)
    const baseDir = NodePath.dirname(absoluteConfig)

    const write = (path: string, contents: string) =>
      Effect.gen(function* () {
        const dir = NodePath.dirname(path)
        yield* fs.makeDirectory(dir, { recursive: true }).pipe(
          Effect.mapError(
            (cause) =>
              new PtError(`cannot create directory '${dir}': ${cause.message}`, {
                cause
              })
          )
        )
        yield* fs.writeFileString(path, contents).pipe(
          Effect.mapError(
            (cause) => new PtError(`cannot write '${path}': ${cause.message}`, { cause })
          )
        )
        return path
      })

    // The config path is the argument the user named, so writing it is the whole
    // point of the command. The template paths are NOT named by the user, and in
    // a clone of the repo they already hold a harvested corpus of tens of
    // thousands of lines. Overwriting those with the small seed would destroy
    // work the user never asked us to touch, so an existing template is left
    // exactly as it is and reported instead.
    const written: Array<string> = [yield* write(absoluteConfig, CONFIG_YML)]
    const skipped: Array<string> = []
    for (const template of SEED_TEMPLATES) {
      const path = NodePath.resolve(baseDir, template.path)
      if (yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false))) {
        skipped.push(path)
        continue
      }
      written.push(yield* write(path, template.contents))
    }

    return { configFile: absoluteConfig, written, skipped }
  })

// ---------------------------------------------------------------------------
// pt add
// ---------------------------------------------------------------------------

/** What `pt add` did to one value. */
export interface AddAction {
  readonly outcome: "added" | "already-present" | "routed-to-raw"
  /** Slot name, or `raw_file`. */
  readonly target: string
  readonly file: string
  readonly value: string
  /** Line number it was written to, or the line it was already on. */
  readonly line: number
  readonly why?: string
}

export interface AddReport {
  readonly actions: ReadonlyArray<AddAction>
  readonly notes: ReadonlyArray<string>
}

export interface AddRequest {
  /** `--slot NAME --value TEXT` pairs, in order. */
  readonly slots: ReadonlyArray<{ readonly slot: string; readonly value: string }>
  readonly raw: ReadonlyArray<string>
  readonly decompose: ReadonlyArray<string>
}

/** Slot names `--decompose` fills, in assembly order. */
const DECOMPOSED_SLOTS = ["prefix", "traversal", "target", "suffix"] as const

/**
 * `pt add` -- grow the corpus without hand-editing files.
 *
 * Three guarantees, because an append-only tool that gets any of them wrong is
 * worse than editing by hand:
 *
 *  - **Idempotent.** A value already in the file is reported and not written
 *    again, so re-running a command is free.
 *  - **Append-only.** Existing lines are never reordered or rewritten, and the
 *    comment header at the top of every generated slot file survives untouched.
 *  - **Honest about failure.** `--decompose` reassembles its candidate through the
 *    REAL `assemble` and only accepts a decomposition that rebuilds the payload
 *    byte for byte. Anything else goes to `raw_file`, with the reason printed.
 */
export const runAdd = (
  configPath: string,
  request: AddRequest
): Effect.Effect<AddReport, PtError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const config = yield* loadConfig(configPath)
    const actions: Array<AddAction> = []
    const notes: Array<string> = []

    /** Pending appends per file, so one file written once keeps its order. */
    const pending = new Map<string, Array<string>>()
    /** Existing trimmed lines per file, including the ones queued this run. */
    const existing = new Map<string, Set<string>>()
    /** Total physical line count per file, for reporting a written line number. */
    const lineCount = new Map<string, number>()

    const load = (path: string, what: string) =>
      Effect.gen(function* () {
        if (existing.has(path)) return
        const exists = yield* fs.exists(path).pipe(
          Effect.mapError(
            (cause) =>
              new PtError(`cannot stat ${what} '${path}': ${cause.message}`, { cause })
          )
        )
        if (!exists) {
          return yield* Effect.fail(
            new PtError(
              `cannot append to ${what} '${path}': it does not exist. Create it (or run 'pt --generate-basic-config') first; 'pt add' never invents a slot file.`
            )
          )
        }
        const contents = yield* readText(path, what)
        const physical = contents.length === 0
          ? 0
          : contents.split(/\r?\n/).length - (contents.endsWith("\n") ? 1 : 0)
        lineCount.set(path, physical)
        existing.set(
          path,
          new Set(contents.split(/\r?\n/).map((line) => line.trim()))
        )
      })

    const append = (
      path: string,
      target: string,
      value: string,
      why?: string
    ): AddAction => {
      const known = existing.get(path)!
      const trimmed = value.trim()
      if (known.has(trimmed)) {
        const lines = (lineCount.get(path) ?? 0)
        return {
          outcome: "already-present",
          target,
          file: path,
          value: trimmed,
          line: lines,
          ...(why !== undefined ? { why } : {})
        }
      }
      known.add(trimmed)
      const queue = pending.get(path) ?? []
      queue.push(trimmed)
      pending.set(path, queue)
      const line = (lineCount.get(path) ?? 0) + queue.length
      return {
        outcome: target === "raw_file" && why !== undefined ? "routed-to-raw" : "added",
        target,
        file: path,
        value: trimmed,
        line,
        ...(why !== undefined ? { why } : {})
      }
    }

    const slotFile = (name: string): SlotConfig => {
      const slot = config.slots.find((candidate) => candidate.name === name)
      if (slot === undefined) {
        throw new PtError(
          `no slot named '${name}' in ${configPath}. Declared slots: ${
            config.slots.map((candidate) => candidate.name).join(", ")
          }.`
        )
      }
      if (slot.files.length === 0) {
        throw new PtError(
          `slot '${name}' names no files, so there is nothing to append to. Give it a 'files:' entry first.`
        )
      }
      return slot
    }

    const rawPath = (): string => {
      if (config.rawFiles.length === 0) {
        throw new PtError(
          `${configPath} has no 'raw_file', so there is nowhere to put a verbatim payload. Add 'raw_file: [./templates/linux/raw.txt]' and create the file.`
        )
      }
      return config.rawFiles[0]!
    }

    // ------------------------------------------------------- --slot / --value
    for (const { slot: name, value } of request.slots) {
      const slot = yield* Effect.try({
        try: () => slotFile(name),
        catch: (cause) => (cause instanceof PtError ? cause : new PtError(String(cause)))
      })
      const path = slot.files[0]!
      if (slot.files.length > 1) {
        notes.push(
          `slot '${name}' names ${slot.files.length} files; appending to the first, ${path}.`
        )
      }
      yield* load(path, `slot '${name}' file`)
      actions.push(append(path, name, value))
    }

    // ------------------------------------------------------------------ --raw
    for (const value of request.raw) {
      const path = yield* Effect.try({
        try: () => rawPath(),
        catch: (cause) => (cause instanceof PtError ? cause : new PtError(String(cause)))
      })
      yield* load(path, "raw_file")
      actions.push(append(path, "raw_file", value))
    }

    // ------------------------------------------------------------ --decompose
    const toRaw = (value: string, why: string) =>
      Effect.gen(function* () {
        const path = yield* Effect.try({
          try: () => rawPath(),
          catch: (cause) =>
            cause instanceof PtError ? cause : new PtError(String(cause))
        })
        yield* load(path, "raw_file")
        actions.push(append(path, "raw_file", value, why))
      })

    for (const payload of request.decompose) {
      const result = decompose(payload)

      if (result.kind === "reject") {
        notes.push(
          `'${payload}' looks corrupt (${result.why}), but you asked for it by hand, so it goes in verbatim.`
        )
        yield* toRaw(payload, `decomposition rejected it: ${result.why}`)
        continue
      }
      if (result.kind === "raw") {
        yield* toRaw(payload, result.why)
        continue
      }

      const parts: Decomposition = result.parts
      const missing = DECOMPOSED_SLOTS.filter(
        (name) =>
          parts[name].length > 0 &&
          config.slots.every((candidate) => candidate.name !== name)
      )
      if (missing.length > 0) {
        yield* toRaw(
          payload,
          `it decomposes into ${missing.join(", ")}, and ${configPath} declares no slot ${
            missing.length === 1 ? "with that name" : "with those names"
          }`
        )
        continue
      }

      for (const name of DECOMPOSED_SLOTS) {
        const value = parts[name]
        if (value.length === 0) continue
        const slot = yield* Effect.try({
          try: () => slotFile(name),
          catch: (cause) =>
            cause instanceof PtError ? cause : new PtError(String(cause))
        })
        const path = slot.files[0]!
        yield* load(path, `slot '${name}' file`)
        actions.push(append(path, name, value))
        if (name === "traversal" && parts.depth > 1 && !slot.repeat.includes(parts.depth)) {
          notes.push(
            `'${payload}' repeats '${value}' ${parts.depth}x, and slot '${name}' repeats ${
              slot.repeat.join(", ")
            }. Add ${parts.depth} to that slot's 'repeat' to reproduce this payload at its original depth -- though '..' clamps at the root, so a deeper rung already covers it.`
          )
        }
      }
    }

    // ----------------------------------------------------------------- commit
    for (const [path, lines] of pending) {
      const contents = yield* readText(path, "file")
      const separator = contents.length === 0 || contents.endsWith("\n") ? "" : "\n"
      yield* fs
        .writeFileString(path, `${contents}${separator}${lines.join("\n")}\n`)
        .pipe(
          Effect.mapError(
            (cause) => new PtError(`cannot write '${path}': ${cause.message}`, { cause })
          )
        )
    }

    return { actions, notes }
  })
