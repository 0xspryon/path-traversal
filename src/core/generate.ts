import { assemble, type AssemblySlot, type StripRule } from "./assemble.ts"
import {
  emptySegment,
  joinSegments,
  type Origin,
  type Segment
} from "./segment.ts"
import { collectingStore, type PayloadStore } from "./store.ts"
import { applyStages, type Stage, type StageContext } from "./strategy.ts"

/**
 * One slot: an ordered position in the payload, its members, and the three
 * properties that used to be four separate special cases in the config.
 *
 * v1 had `prefix` / `traversal` / `target` / `suffix` as four fixed dimensions
 * pretending to be a uniform cross-product. They were not: only `traversal` had a
 * repeat count, only `target` had no empty member, only `target` got the
 * leading-separator strip, and three of the four had an
 * `include_payloads_without_*` boolean that the fourth could not have. Every one
 * of those asymmetries was a branch in the code and an invisible rule in the
 * config. As slot properties they are just data, and the things v1 could not say
 * at all -- two traversal slots, a slot between target and suffix, more than one
 * suffix position -- become ordinary configs.
 */
export interface Slot {
  readonly name: string
  /** Lines loaded from this slot's files, in file order. */
  readonly members: ReadonlyArray<Segment>
  /** Does this slot have an empty member? (v1's `include_payloads_without_*`.) */
  readonly optional: boolean
  /** The repeat ladder. `[1]` for a slot whose text appears once. */
  readonly repeat: ReadonlyArray<number>
  readonly strip: StripRule
}

/** Per-strategy replacement of one slot's members and/or repeat ladder. */
export interface SlotOverride {
  readonly members?: ReadonlyArray<Segment>
  readonly repeat?: ReadonlyArray<number>
}

/** One member of the strategy union. */
export interface Strategy {
  /** Canonical pipeline rendering, e.g. `url_encode:1 > hex_case_upper`. */
  readonly label: string
  readonly stages: ReadonlyArray<Stage>
  /** Slot overrides by slot name; absent slots use the base definition. */
  readonly overrides?: Readonly<Record<string, SlotOverride>>
  /**
   * A short rendering of those overrides, for the report.
   *
   * Five `plain` entries differing only in which slot files they read are five
   * identical rows otherwise, which is exactly the config pt-full.yml is.
   */
  readonly note?: string
}

export interface GeneratorOptions {
  /** An ORDERED UNION, never a product. */
  readonly strategies: ReadonlyArray<Strategy>
  /**
   * Lines emitted verbatim: never decomposed, never rewritten by a strategy,
   * never repeat-multiplied. They exist for real-world wordlist entries that are
   * internally inconsistent and cannot be expressed generatively.
   */
  readonly raw?: ReadonlyArray<string>
  /** Stop as soon as the unique set grows past this. Keeps a runaway config cheap. */
  readonly maxPayloads?: number
  /**
   * Where payloads accumulate. Defaults to `collectingStore()`, which retains
   * them; the CLI passes a streaming `fingerprintStore` instead.
   */
  readonly store?: PayloadStore
  /**
   * Attribute marginal contribution to INPUT LINES as well as to strategies.
   * Costs one `Int32Array` of `payloads x slots`, so it is opt-in.
   */
  readonly attribute?: boolean
}

export interface StrategyReport {
  readonly label: string
  /** The strategy's slot overrides, rendered short. */
  readonly note?: string
  /** Payloads this strategy emitted, before deduping against earlier strategies. */
  readonly generated: number
  /**
   * Of those, how many were not already in the set.
   *
   * ORDER-DEPENDENT: it means "new given everything above it". Good for pruning
   * the bottom of the list, misleading for comparing two strategies in the middle.
   */
  readonly marginal: number
  /**
   * Payloads NO OTHER strategy produces, computed against the union of all the
   * others. ORDER-INDEPENDENT, and the number that answers "can I delete this?".
   */
  readonly unique: number
}

/** Marginal contribution of one input LINE, which provenance makes possible. */
export interface InputReport {
  readonly file: string
  readonly line: number
  readonly text: string
  /** Slots this line was read into. Usually one. */
  readonly slots: ReadonlyArray<string>
  /** Unique payloads whose FIRST producer used this line. Order-dependent. */
  readonly marginal: number
  /**
   * Payloads that would disappear if this line were deleted. ORDER-INDEPENDENT:
   * a payload counts here only when every combination that produces it uses this
   * line.
   */
  readonly unique: number
  /**
   * For a line that earns nothing: one other way the same payload arrives.
   *
   * Recorded the first time some other combination produces a payload this line
   * had already been credited with, which is exactly the evidence a user needs to
   * delete the line -- "'..%252f' is redundant because url_encode:2 derives it
   * from '../'".
   */
  readonly witness?: { readonly strategy: string; readonly instead: string }
}

export interface GenerateResult {
  /** Total unique payloads, passthrough included. */
  readonly total: number
  /** Verbatim `raw` entries, which lead the output. */
  readonly rawCount: number
  /** Of those, how many no strategy also produces -- §8's honest number. */
  readonly rawUnique: number
  readonly strategies: ReadonlyArray<StrategyReport>
  /** Empty unless `attribute` was set. */
  readonly inputs: ReadonlyArray<InputReport>
  /** True when `maxPayloads` cut the run short; the output is then incomplete. */
  readonly exceeded: boolean
  /** Present only when the store retains payloads. */
  readonly payloads?: ReadonlyArray<string>
}

const ascendingUnique = (values: ReadonlyArray<number>): Array<number> =>
  Array.from(new Set(values)).sort((a, b) => a - b)

/** A slot position cannot be blamed on any single input line. */
const CONFLICT = -2
/** The passthrough, as a pseudo-strategy. */
const RAW_STRATEGY = -1

interface Candidate {
  readonly segment: Segment
  readonly repeats: ReadonlyArray<number>
  /** Index into the input table, or `CONFLICT` for the empty member. */
  readonly inputId: number
}

interface SlotPlan {
  readonly strip: StripRule
  readonly candidates: ReadonlyArray<Candidate>
}

/** Growable parallel arrays indexed by payload, for the attribution pass. */
const growableInt32 = (stride: number) => {
  let data = new Int32Array(Math.max(stride, 1024) * 16)
  return {
    ensure: (rows: number): void => {
      const needed = rows * stride
      if (needed <= data.length) return
      let next = data.length * 2
      while (next < needed) next *= 2
      const grown = new Int32Array(next)
      grown.set(data)
      data = grown
    },
    get: (): Int32Array => data
  }
}

/**
 * Walk the strategy union, cross-producting the SLOTS inside each member, and
 * dedupe.
 *
 * Loop order, outermost first: strategy, then every slot in config order, then
 * each slot's repeat ladder. The strategy loop is outermost because the output is
 * consumed top-to-bottom by a fuzzer and the strategy list is ordered by priority
 * -- the first entries are the likeliest to simply work. Results accumulate into
 * a store in insertion order, so output is deterministic and diffs cleanly, and a
 * payload two strategies would both emit appears once, at its earliest position.
 */
export const generate = (
  slots: ReadonlyArray<Slot>,
  options: GeneratorOptions
): GenerateResult => {
  const store = options.store ?? collectingStore()
  const { maxPayloads } = options

  // Raw entries are verbatim by definition, so they lead the file.
  for (const line of options.raw ?? []) {
    if (line.length > 0) store.offer(line)
  }
  const rawCount = store.size()

  // ------------------------------------------------------------------ inputs
  /** `file:line` -> index into `inputs`. */
  const inputIds = new Map<string, number>()
  const inputs: Array<{
    file: string
    line: number
    text: string
    slots: Set<string>
    marginal: number
    unique: number
    witness?: { strategy: string; instead: string }
  }> = []

  const inputIdOf = (segment: Segment): number => {
    const origin: Origin | undefined = segment.origin
    if (origin === undefined || !options.attribute) return CONFLICT
    const key = `${origin.file}\u0000${origin.line}`
    const existing = inputIds.get(key)
    if (existing !== undefined) {
      inputs[existing]!.slots.add(segment.slot)
      return existing
    }
    const id = inputs.length
    inputIds.set(key, id)
    inputs.push({
      file: origin.file,
      line: origin.line,
      text: segment.text,
      slots: new Set([segment.slot]),
      marginal: 0,
      unique: 0
    })
    return id
  }

  // ------------------------------------------------------- attribution state
  const slotCount = slots.length
  const perSlot = options.attribute ? growableInt32(slotCount) : undefined
  const perStrategy = growableInt32(1)
  perStrategy.ensure(Math.max(rawCount, 1))
  for (let index = 0; index < rawCount; index++) {
    perStrategy.get()[index] = RAW_STRATEGY
  }
  if (perSlot !== undefined) {
    perSlot.ensure(Math.max(rawCount, 1))
    perSlot.get().fill(CONFLICT, 0, rawCount * slotCount)
  }

  const reports: Array<StrategyReport> = []
  let exceeded = false

  const current: Array<AssemblySlot> = slots.map((slot) => ({
    segment: emptySegment(slot.name),
    repeat: 1,
    strip: slot.strip
  }))
  const currentInputs = new Int32Array(Math.max(slotCount, 1))

  const anchorSlot = anchorSlotOf(slots)
  const context: StageContext = {
    ...(anchorSlot !== undefined ? { anchorSlot } : {})
  }

  options.strategies.forEach((strategy, strategyAt) => {
    if (exceeded) return

    const plans: Array<SlotPlan> = slots.map((slot) => {
      const override = strategy.overrides?.[slot.name]
      const members = override?.members ?? slot.members
      const ladder = ascendingUnique(override?.repeat ?? slot.repeat).filter(
        (n) => n > 0
      )
      const repeats = ladder.length === 0 ? [1] : ladder
      const candidates: Array<Candidate> = []
      // An empty slot still needs the empty member or the whole product collapses.
      if (slot.optional || members.length === 0) {
        candidates.push({
          segment: emptySegment(slot.name),
          // `'' x 22 === ''`, so an empty member must not walk the repeat ladder:
          // every rung would produce the same duplicate.
          repeats: [1],
          inputId: CONFLICT
        })
      }
      for (const member of members) {
        candidates.push({
          segment: member,
          repeats,
          inputId: inputIdOf(member)
        })
      }
      return { strip: slot.strip, candidates }
    })

    const before = store.size()
    let generated = 0

    const emit = (): void => {
      const segments = applyStages(assemble(current), strategy.stages, context)
      const payload = joinSegments(segments)
      if (payload.length === 0) return
      generated += 1
      const { fresh, index } = store.offer(payload)

      perStrategy.ensure(index + 1)
      const strategyData = perStrategy.get()

      if (perSlot !== undefined) {
        perSlot.ensure(index + 1)
        const slotData = perSlot.get()
        const base = index * slotCount
        if (fresh) {
          for (let at = 0; at < slotCount; at++) {
            slotData[base + at] = currentInputs[at]!
            const id = currentInputs[at]!
            if (id >= 0) inputs[id]!.marginal += 1
          }
        } else {
          const priorStrategy = strategyData[index]!
          for (let at = 0; at < slotCount; at++) {
            const prior = slotData[base + at]!
            const now = currentInputs[at]!
            if (prior === now) continue
            // This payload no longer depends on either line at this slot, and
            // each of them now has a witness: the other route to the same bytes.
            if (prior >= 0 && inputs[prior]!.witness === undefined) {
              inputs[prior]!.witness = {
                strategy: strategy.label,
                instead: now >= 0 ? inputs[now]!.text : "the empty member"
              }
            }
            if (now >= 0 && inputs[now]!.witness === undefined) {
              inputs[now]!.witness = {
                strategy: priorStrategy === RAW_STRATEGY
                  ? "the raw passthrough"
                  : priorStrategy === CONFLICT
                  ? "several earlier strategies"
                  : options.strategies[priorStrategy]?.label ?? "an earlier strategy",
                instead: prior >= 0 ? inputs[prior]!.text : "the empty member"
              }
            }
            slotData[base + at] = CONFLICT
          }
        }
      }

      // Order-independent per-strategy uniqueness, in one pass: a payload every
      // producer of which is this strategy is unique to it. NOTES §6 proposed one
      // extra full pass per strategy; collapsing the producers to "this one" or
      // "more than one" gets the same number for free.
      if (fresh) strategyData[index] = strategyAt
      else if (strategyData[index] !== strategyAt) strategyData[index] = CONFLICT
    }

    const walk = (at: number): void => {
      if (at === slotCount) {
        emit()
        return
      }
      const plan = plans[at]!
      for (const candidate of plan.candidates) {
        for (const repeat of candidate.repeats) {
          current[at] = {
            segment: candidate.segment,
            repeat,
            strip: plan.strip
          }
          currentInputs[at] = candidate.inputId
          walk(at + 1)
        }
        if (
          at === 0 &&
          maxPayloads !== undefined &&
          store.size() > maxPayloads
        ) {
          exceeded = true
          return
        }
      }
    }

    if (slotCount === 0) emit()
    else walk(0)

    reports.push({
      label: strategy.label,
      ...(strategy.note !== undefined ? { note: strategy.note } : {}),
      generated,
      marginal: store.size() - before,
      unique: 0
    })
  })

  // ------------------------------------------------- order-independent uniques
  const total = store.size()
  const uniquePerStrategy = new Int32Array(options.strategies.length)
  let rawUnique = 0
  const strategyData = perStrategy.get()
  for (let index = 0; index < total; index++) {
    const sole = strategyData[index]!
    if (sole === RAW_STRATEGY) rawUnique += 1
    else if (sole >= 0 && sole < uniquePerStrategy.length) uniquePerStrategy[sole]! += 1
  }

  if (perSlot !== undefined) {
    const slotData = perSlot.get()
    for (let index = 0; index < total; index++) {
      const base = index * slotCount
      for (let at = 0; at < slotCount; at++) {
        const id = slotData[base + at]!
        if (id >= 0) inputs[id]!.unique += 1
      }
    }
  }

  const strategies = reports.map((report, at) => ({
    ...report,
    unique: uniquePerStrategy[at] ?? 0
  }))

  return {
    total,
    rawCount,
    rawUnique,
    strategies,
    inputs: inputs.map((input) => ({
      file: input.file,
      line: input.line,
      text: input.text,
      slots: Array.from(input.slots),
      marginal: input.marginal,
      unique: input.unique,
      ...(input.witness !== undefined ? { witness: input.witness } : {})
    })),
    exceeded,
    ...(store.payloads !== undefined ? { payloads: store.payloads() } : {})
  }
}

/**
 * The slot a `trailing_*` stage appends to: the LAST REQUIRED slot.
 *
 * Every payload contains it by construction, which is what makes it the only
 * sound place to put a character that has to land on the path rather than after a
 * `%00.png`. In every sane config that is the target, but it is derived from the
 * slot list rather than hard-coded, because slot names belong to the user.
 */
export const anchorSlotOf = (slots: ReadonlyArray<Slot>): string | undefined => {
  for (let at = slots.length - 1; at >= 0; at--) {
    const slot = slots[at]!
    if (!slot.optional && slot.members.length > 0) return slot.name
  }
  return undefined
}
