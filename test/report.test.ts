import { describe, expect, test } from "bun:test"
import type { GenerateResult } from "../src/core/index.ts"
import { formatReport, styleFor } from "../src/report.ts"

const RESULT: GenerateResult = {
  total: 1_000,
  rawCount: 100,
  rawUnique: 60,
  strategies: [
    { label: "plain", generated: 500, marginal: 500, unique: 400 },
    { label: "dot_noise", generated: 500, marginal: 400, unique: 400 },
    { label: "url_encode:1 > hex_case_lower", generated: 500, marginal: 0, unique: 0 }
  ],
  inputs: [
    {
      file: "/t/templates/traversal.txt",
      line: 3,
      text: "..%252f",
      slots: ["traversal"],
      marginal: 0,
      unique: 0,
      witness: { strategy: "url_encode:2", instead: "../" }
    },
    {
      file: "/t/templates/traversal.txt",
      line: 1,
      text: "../",
      slots: ["traversal"],
      marginal: 900,
      unique: 500
    },
    {
      file: "/t/templates/target.txt",
      line: 2,
      text: "/etc/passwd",
      slots: ["target"],
      marginal: 400,
      unique: 300
    }
  ],
  exceeded: false
}

const PLAIN = { rich: false, barWidth: 24, maxInputs: 40 }
const RICH = { rich: true, barWidth: 24, maxInputs: 40 }

describe("styleFor", () => {
  test("bars need BOTH streams to be a terminal", () => {
    expect(styleFor({ stdoutIsTty: true, stderrIsTty: true }).rich).toBe(true)
    expect(styleFor({ stdoutIsTty: false, stderrIsTty: true }).rich).toBe(false)
    expect(styleFor({ stdoutIsTty: true, stderrIsTty: false }).rich).toBe(false)
    expect(styleFor({}).rich).toBe(false)
  })

  test("the bar width follows the terminal, within bounds", () => {
    expect(styleFor({ columns: 80 }).barWidth).toBe(24)
    expect(styleFor({ columns: 40 }).barWidth).toBe(8)
    expect(styleFor({ columns: 400 }).barWidth).toBe(32)
  })
})

describe("piped output", () => {
  const text = formatReport(RESULT, PLAIN)

  test("has no ANSI escapes and no bars", () => {
    expect(text).not.toContain("\u001b[")
    expect(text).not.toContain("█")
    expect(text).not.toContain("▏")
  })

  test("is aligned: every strategy row's numbers line up", () => {
    const rows = text
      .split("\n")
      .filter((line) => /^ {2}(raw_file|plain|dot_noise|url_encode)/.test(line))
    expect(rows).toHaveLength(4)
    // Numbers are right-aligned, so the column that must agree is where the
    // 'unique' figure ENDS, not where any field starts.
    const widths = rows.map(
      (row) => /^(.*?\(\+[\d,]+\)\s+[\d,]+)/.exec(row)![1]!.length
    )
    expect(new Set(widths).size).toBe(1)
  })

  test("carries both contribution columns and the totals", () => {
    expect(text).toMatch(/payloads\s+new\s+unique/)
    expect(text).toContain("(+500)")
    expect(text).toContain("total unique")
    expect(text).toContain("1,000")
  })

  test("flags a strategy whose unique contribution is zero", () => {
    expect(text).toContain("every payload also comes from elsewhere")
  })
})

describe("TTY output", () => {
  const text = formatReport(RESULT, RICH)

  test("draws bars and colours them", () => {
    expect(text).toContain("█")
    expect(text).toContain("\u001b[36m")
    expect(text).toContain("\u001b[1m")
  })

  test("the bars are proportional to the unique column", () => {
    const widthOf = (label: string) => {
      const row = text.split("\n").find((line) => line.includes(label))!
      return (row.match(/█/g) ?? []).length
    }
    // plain:400 and dot_noise:400 are equal; raw_file:60 is far smaller.
    expect(widthOf("plain")).toBe(widthOf("dot_noise"))
    expect(widthOf("raw_file")).toBeLessThan(widthOf("plain"))
    expect(widthOf("raw_file")).toBeGreaterThan(0)
    // A zero earns no bar at all, not an empty coloured one.
    expect(widthOf("url_encode:1 > hex_case_lower")).toBe(0)
    expect(text.split("\n").find((line) => line.includes("hex_case_lower"))!)
      .not.toContain("\u001b[36m")
  })

  test("stripping the escapes and the blocks leaves the piped numbers", () => {
    const stripped = text
      .replace(/\u001b\[\d+m/g, "")
      .replace(/[█▏-▟·]/g, "")
      .replace(/ +$/gm, "")
    for (const fragment of ["total unique", "1,000", "(+500)", "raw ratio"]) {
      expect(stripped).toContain(fragment)
    }
  })
})

// §6: per-input attribution, with the witness that makes it actionable.
describe("the inputs table", () => {
  const text = formatReport(RESULT, PLAIN)

  test("lists the redundant lines by file and line number", () => {
    expect(text).toContain("inputs -- what each line of each slot file is worth")
    expect(text).toMatch(/traversal\.txt:3\s+\.\.%252f\s+0\s+0/)
  })

  test("names the strategy that already covers a redundant line", () => {
    expect(text).toContain("already covered by 'url_encode:2' (from '../')")
  })

  test("counts the redundant lines", () => {
    expect(text).toContain("1 of 3 input lines are REDUNDANT")
  })

  test("shows only the redundant ones when there are any", () => {
    expect(text).not.toContain("/etc/passwd")
  })

  test("falls back to the cheapest lines when nothing is redundant", () => {
    const noRedundancy = formatReport(
      {
        ...RESULT,
        inputs: RESULT.inputs.filter((input) => input.unique > 0)
      },
      PLAIN
    )
    expect(noRedundancy).toContain("0 of 2 input lines are redundant")
    expect(noRedundancy).toContain("/etc/passwd")
  })

  test("is omitted entirely when attribution was not requested", () => {
    const noInputs = formatReport({ ...RESULT, inputs: [] }, PLAIN)
    expect(noInputs).not.toContain("inputs -- what each line")
  })
})

// §8: the raw ratio as a headline figure.
describe("the raw ratio", () => {
  test("is its own headline, with both the gross and the verbatim-only figure", () => {
    const text = formatReport(RESULT, PLAIN)
    // 100 verbatim against 900 generated.
    expect(text).toMatch(/raw ratio\s+11\.11%/)
    expect(text).toContain("100 verbatim entries against 900 generated payloads")
    expect(text).toContain("60 of them (60.00%) are reachable ONLY verbatim")
    expect(text).toContain("6.67%")
  })

  test("a ratio far below a hundredth of a percent is still printed as a number", () => {
    const text = formatReport(
      { ...RESULT, total: 185_786, rawCount: 1, rawUnique: 1 },
      PLAIN
    )
    expect(text).toContain("0.0005%")
    expect(text).not.toMatch(/raw ratio\s+0\.00%/)
  })

  test("with no passthrough it says so instead of dividing by nothing", () => {
    const text = formatReport({ ...RESULT, rawCount: 0, rawUnique: 0 }, PLAIN)
    expect(text).toContain("raw ratio  0.00%")
    expect(text).toContain("No passthrough")
  })
})
