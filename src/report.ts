/**
 * The contribution report.
 *
 * Three questions, and the shape of the answer is the point:
 *
 *  1. **What is each strategy worth?** Two numbers, not one. `new` is marginal
 *     given everything above it, which is order-DEPENDENT and good only for
 *     pruning the bottom of the list. `unique` is computed against the union of
 *     all the others, which is order-independent and is the number that answers
 *     "can I delete this?".
 *
 *  2. **What is each INPUT LINE worth?** Provenance makes this expressible at
 *     all. It is the more useful half: the strategy layer derives `..%2f` from
 *     `../`, so five of the eleven traversal seeds pt ships are now partly
 *     redundant, and before this report the only way to find that out was to
 *     delete lines and diff counts.
 *
 *  3. **How much of the real world is the generator missing?** The passthrough's
 *     size relative to the generated part, as a headline number rather than a row
 *     in a table.
 *
 * Bars are drawn only when the destination is a terminal. Piped, the same numbers
 * come out as plain aligned text, because the report goes to stderr and people
 * redirect stderr.
 */
import type { GenerateResult, InputReport, StrategyReport } from "./core/index.ts"

/**
 * Shorten a slot file for a report column.
 *
 * The basename plus the directory above it, because `templates/` is now split
 * into one folder per stack category and the basename alone cannot tell
 * `linux/target.txt` from `windows/target.txt`. A `templates` parent is dropped,
 * since every slot file has one and it says nothing.
 */
export const shortSlotPath = (file: string): string => {
  const parts = file.split(/[\\/]/).filter((part) => part.length > 0 && part !== ".")
  const base = parts[parts.length - 1] ?? file
  const parent = parts[parts.length - 2]
  return parent === undefined || parent === "templates" ? base : `${parent}/${base}`
}

export interface ReportStyle {
  /** Draw bars and emit ANSI colour. False when either stream is not a TTY. */
  readonly rich: boolean
  /** Bar width in columns. */
  readonly barWidth: number
  /** How many input lines to list before collapsing the tail. */
  readonly maxInputs: number
}

export const DEFAULT_STYLE: ReportStyle = { rich: false, barWidth: 24, maxInputs: 40 }

/** Resolve the style from the process's streams. */
export const styleFor = (
  streams: {
    readonly stdoutIsTty?: boolean | undefined
    readonly stderrIsTty?: boolean | undefined
    readonly columns?: number | undefined
  }
): ReportStyle => {
  // The report is written to stderr, so stderr has to be a terminal for bars to
  // make sense -- but `process.stdout.isTTY` is checked too, because `pt ... |
  // less` is the case the user means by "piped" and nobody wants half-ANSI
  // output interleaved with a pager.
  const rich = streams.stdoutIsTty === true && streams.stderrIsTty === true
  const columns = streams.columns ?? 80
  return {
    rich,
    barWidth: Math.max(8, Math.min(32, columns - 56)),
    maxInputs: 40
  }
}

const DIM = "\u001b[2m"
const BOLD = "\u001b[1m"
const CYAN = "\u001b[36m"
const YELLOW = "\u001b[33m"
const RESET = "\u001b[0m"

const paint = (style: ReportStyle, colour: string, text: string): string =>
  style.rich ? `${colour}${text}${RESET}` : text

const thousands = (value: number): string => value.toLocaleString("en-US")

const BLOCKS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"]

/**
 * A bar scaled to `max`, using eighth-width blocks so a value that rounds to
 * zero columns is still visibly different from an actual zero.
 */
const bar = (value: number, max: number, style: ReportStyle): string => {
  if (!style.rich) return ""
  if (max <= 0 || value <= 0) return ""
  const eighths = Math.round((value / max) * style.barWidth * 8)
  const full = Math.floor(eighths / 8)
  const rest = eighths % 8
  const text = "█".repeat(full) + BLOCKS[rest]!
  return text.length === 0 && value > 0 ? paint(style, DIM, "·") : paint(style, CYAN, text)
}

const rule = (width: number): string => "-".repeat(width)

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

const formatStrategies = (
  strategies: ReadonlyArray<StrategyReport>,
  rawCount: number,
  rawUnique: number,
  total: number,
  style: ReportStyle
): Array<string> => {
  const rows: Array<readonly [string, number, number, number]> = [
    ...(rawCount > 0
      ? [["raw_file (verbatim)", rawCount, rawCount, rawUnique] as const]
      : []),
    ...strategies.map(
      (report) =>
        [
          report.note === undefined ? report.label : `${report.label} | ${report.note}`,
          report.generated,
          report.marginal,
          report.unique
        ] as const
    )
  ]

  // The note can be long (five `plain` entries differing only in slot files), so
  // the label column is capped and the note is what gets clipped.
  const labelWidth = Math.min(72, Math.max(12, ...rows.map(([label]) => label.length)))
  const numberWidth = Math.max(
    8,
    ...rows.map(([, generated]) => thousands(generated).length)
  )
  const maxUnique = Math.max(1, ...rows.map(([, , , unique]) => unique))

  const header = `  ${"strategy".padEnd(labelWidth)}  ${
    "payloads".padStart(numberWidth)
  }  ${"new".padStart(10)}  ${"unique".padStart(numberWidth)}`

  const lines = rows.map(([label, generated, marginal, unique]) => {
    const note = unique === 0
      ? paint(style, YELLOW, "  <- every payload also comes from elsewhere")
      : generated > 0 && marginal / generated < 0.05
      ? paint(style, DIM, "  <- earning almost nothing")
      : ""
    const shown = label.length <= labelWidth
      ? label.padEnd(labelWidth)
      : `${label.slice(0, labelWidth - 1)}\u2026`
    return `  ${shown}  ${
      thousands(generated).padStart(numberWidth)
    }  ${`(+${thousands(marginal)})`.padStart(10)}  ${
      thousands(unique).padStart(numberWidth)
    }  ${bar(unique, maxUnique, style)}${note}`.trimEnd()
  })

  return [
    paint(style, BOLD, "strategies -- what each hypothesis is worth"),
    header,
    `  ${rule(labelWidth + numberWidth * 2 + 16)}`,
    ...lines,
    `  ${"total unique".padEnd(labelWidth)}  ${thousands(total).padStart(numberWidth)}`,
    "",
    paint(
      style,
      DIM,
      "  'new' is marginal given everything above it, so it depends on order."
    ),
    paint(
      style,
      DIM,
      "  'unique' is against the union of all the others, so it does not. A zero"
    ),
    paint(style, DIM, "  there means the strategy is safe to delete.")
  ]
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------



const formatInputs = (
  inputs: ReadonlyArray<InputReport>,
  style: ReportStyle
): Array<string> => {
  if (inputs.length === 0) return []

  const ordered = [...inputs].sort(
    (a, b) =>
      a.unique - b.unique ||
      a.marginal - b.marginal ||
      a.file.localeCompare(b.file) ||
      a.line - b.line
  )
  const redundant = ordered.filter((input) => input.unique === 0)
  // Redundant lines first and in full, because they are the actionable ones. With
  // none to show, the cheapest few FROM EACH SLOT say where to look next -- a flat
  // "lowest 15" would be fifteen targets and never mention the traversals.
  const perSlot = Math.max(2, Math.floor(style.maxInputs / 8))
  const quota = new Map<string, number>()
  const cheapestPerSlot = ordered.filter((input) => {
    const key = input.slots.join("+")
    const used = quota.get(key) ?? 0
    if (used >= perSlot) return false
    quota.set(key, used + 1)
    return true
  })
  const shown = redundant.length > 0
    ? redundant.slice(0, style.maxInputs)
    : cheapestPerSlot.slice(0, style.maxInputs)

  const where = (input: InputReport) => `${shortSlotPath(input.file)}:${input.line}`
  const whereWidth = Math.max(10, ...shown.map((input) => where(input).length))
  const valueWidth = Math.min(
    28,
    Math.max(6, ...shown.map((input) => input.text.length))
  )
  const numberWidth = Math.max(
    8,
    ...ordered.map((input) => thousands(input.marginal).length)
  )
  const maxUnique = Math.max(1, ...ordered.map((input) => input.unique))

  const clip = (text: string) =>
    text.length <= valueWidth ? text.padEnd(valueWidth) : `${text.slice(0, valueWidth - 1)}…`

  const lines = shown.map((input) => {
    const note = input.unique === 0
      ? input.witness === undefined
        ? paint(style, YELLOW, "  <- contributes nothing unique")
        : paint(
          style,
          YELLOW,
          `  <- already covered by '${input.witness.strategy}'${
            input.witness.instead === "the empty member"
              ? ""
              : ` (from '${input.witness.instead}')`
          }`
        )
      : ""
    return `  ${where(input).padEnd(whereWidth)}  ${clip(input.text)}  ${
      thousands(input.marginal).padStart(numberWidth)
    }  ${thousands(input.unique).padStart(numberWidth)}  ${
      bar(input.unique, maxUnique, style)
    }${note}`.trimEnd()
  })

  const header = `  ${"file:line".padEnd(whereWidth)}  ${
    "value".padEnd(valueWidth)
  }  ${"payloads".padStart(numberWidth)}  ${"unique".padStart(numberWidth)}`

  const hidden = redundant.length > 0
    ? redundant.length - shown.length
    : ordered.length - shown.length
  const tail = hidden > 0
    ? [
      paint(
        style,
        DIM,
        `  ... and ${hidden} more line${hidden === 1 ? "" : "s"}${
          redundant.length > 0 ? " that contribute nothing unique" : " that earn at least as much"
        }`
      )
    ]
    : []

  return [
    "",
    paint(style, BOLD, "inputs -- what each line of each slot file is worth"),
    header,
    `  ${rule(whereWidth + valueWidth + numberWidth * 2 + 8)}`,
    ...lines,
    ...tail,
    "",
    paint(
      style,
      redundant.length > 0 ? YELLOW : DIM,
      redundant.length === 0
        ? `  0 of ${ordered.length} input lines are redundant: every one earns at least one`
        : `  ${redundant.length} of ${ordered.length} input lines are REDUNDANT: deleting one changes`
    ),
    paint(
      style,
      redundant.length > 0 ? YELLOW : DIM,
      redundant.length === 0
        ? "  payload that no other line and strategy combination produces."
        : "  the output by exactly nothing."
    )
  ]
}

// ---------------------------------------------------------------------------
// The passthrough ratio
// ---------------------------------------------------------------------------

const pct = (part: number, whole: number): string => {
  if (whole === 0) return "n/a"
  const value = (part / whole) * 100
  // A ratio of one verbatim line against 185,785 generated payloads is a real
  // number and `0.00%` is not it.
  const digits = value === 0 ? 2 : value < 0.01 ? 4 : 2
  return `${value.toFixed(digits)}%`
}

/**
 * §8 as a first-class number.
 *
 * `raw_file` bypasses assembly and every strategy, which is correct -- real
 * wordlists contain internally inconsistent lines that cannot be generated -- but
 * that makes it the escape hatch that proves the generative model is incomplete.
 * pt is a generator WITH A PASSTHROUGH, and the passthrough's size relative to the
 * generated part is the measurement of how much of the real world the model does
 * not capture. The stricter figure uses only the verbatim entries no strategy also
 * produces, which is the part the model genuinely cannot reach.
 */
export const formatPassthrough = (
  result: GenerateResult,
  style: ReportStyle
): Array<string> => {
  const generated = result.total - result.rawCount
  if (result.rawCount === 0) {
    return [
      "",
      paint(style, BOLD, "raw ratio  0.00%"),
      paint(
        style,
        DIM,
        `  No passthrough: all ${thousands(result.total)} payloads are generated.`
      )
    ]
  }
  return [
    "",
    paint(
      style,
      BOLD,
      `raw ratio  ${pct(result.rawCount, generated)}  -- ${
        thousands(result.rawCount)
      } verbatim entr${result.rawCount === 1 ? "y" : "ies"} against ${
        thousands(generated)
      } generated payloads`
    ),
    `  ${thousands(result.rawUnique)} of them (${
      pct(result.rawUnique, result.rawCount)
    }) are reachable ONLY verbatim, which is a raw ratio of ${
      pct(result.rawUnique, generated)
    } against the generated part; the rest some strategy also derives.`,
    paint(
      style,
      DIM,
      "  That ratio is how much of the real world the generative model does not"
    ),
    paint(
      style,
      DIM,
      "  capture. raw_file is a hole in the model, and it should be."
    )
  ]
}

// ---------------------------------------------------------------------------
// Whole report
// ---------------------------------------------------------------------------

export const formatReport = (
  result: GenerateResult,
  style: ReportStyle = DEFAULT_STYLE
): string =>
  [
    ...formatStrategies(
      result.strategies,
      result.rawCount,
      result.rawUnique,
      result.total,
      style
    ),
    ...formatInputs(result.inputs, style),
    ...formatPassthrough(result, style)
  ].join("\n")

/** The strategy table alone, for the `max_payloads` failure message. */
export const formatStrategyTable = (
  result: GenerateResult,
  style: ReportStyle = DEFAULT_STYLE
): string =>
  formatStrategies(
    result.strategies,
    result.rawCount,
    result.rawUnique,
    result.total,
    style
  ).join("\n")
