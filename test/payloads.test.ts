import { describe, expect, test } from "bun:test"
import {
  canonicalTarget,
  classesOf,
  decompose,
  primaryClass,
  reassemble,
  rejectReason,
  resolveClamped,
  toLiteral,
  type Decomposition
} from "../src/core/index.ts"

const ok = (line: string): Decomposition => {
  const result = decompose(line)
  if (result.kind !== "ok") {
    throw new Error(`expected '${line}' to decompose, got ${result.kind}: ${result.why}`)
  }
  return result.parts
}

describe("decompose round-trips through the REAL assemble", () => {
  const LINES = [
    "/etc/passwd",
    "../../../etc/passwd",
    "/var/www/html/../../../etc/passwd",
    "..%2f..%2f..%2fetc/passwd",
    "....//....//etc/passwd",
    "%00/etc/passwd",
    "../../../etc/passwd%00.png",
    "..\\..\\..\\boot.ini",
    "..\\..\\..\\/etc/passwd",
    "\\\\.\\C:\\boot.ini",
    "..;/..;/etc/passwd",
    "proc/self/environ"
  ]

  for (const line of LINES) {
    test(line, () => {
      expect(reassemble(ok(line))).toBe(line)
    })
  }
})

// The separator-identity finding, from the decomposition side.
describe("a traversal whose separator differs from the target's", () => {
  test("decomposes instead of going to the passthrough", () => {
    // v1's permissive step matcher let the last step swallow the target's '/',
    // which made the chain 'a clean repetition that breaks at the last step' and
    // sent the entry to raw_file.
    expect(ok("..\\..\\..\\/etc/passwd")).toEqual({
      prefix: "",
      traversal: "..\\",
      depth: 3,
      target: "/etc/passwd",
      suffix: ""
    })
  })

  test("the recovered depth is the real depth, not 1", () => {
    expect(ok("..\\..\\..\\..\\..\\/etc/passwd").depth).toBe(5)
    expect(ok("...\\...\\...\\/etc/passwd")).toMatchObject({
      traversal: "...\\",
      depth: 3
    })
  })

  test("a target after a MATCHING separator keeps the leading-slash spelling", () => {
    // '/etc/passwd' is the spelling that serves both the bare block and the
    // traversal blocks, because the strip takes it off again.
    expect(ok("../../../etc/passwd").target).toBe("/etc/passwd")
  })

  test("a target after a BACKSLASH keeps no invented separator", () => {
    // Inventing '/' here would rebuild '..\\..\\..\\/boot.ini', a different payload.
    expect(ok("..\\..\\..\\boot.ini").target).toBe("boot.ini")
  })

  test("the permissive parse still wins where it is right", () => {
    // '..//' is a legitimate primitive; splitting its run would be wrong.
    expect(ok("..//..//..//etc/passwd")).toMatchObject({
      traversal: "..//",
      depth: 3
    })
  })
})

/**
 * The non-greedy strip, from the decomposition side.
 *
 * These lines were 251 of `raw-full.txt`'s 398 entries. Nothing about them is
 * internally inconsistent -- the doubled junction was simply not expressible while
 * the strip removed every leading separator the target had.
 */
describe("a doubled junction is a target spelling, not a passthrough entry", () => {
  const ROWS: ReadonlyArray<readonly [string, string, string, number]> = [
    ["../../..//etc/passwd", "../", "//etc/passwd", 3],
    ["../../../../..//etc/passwd", "../", "//etc/passwd", 5],
    ["..//..//..///etc/passwd", "..//", "//etc/passwd", 3],
    [".../.../...//etc/passwd", ".../", "//etc/passwd", 3],
    ["..%2f..%2f..%2f/etc/passwd", "..%2f", "//etc/passwd", 3],
    ["..\\..\\..\\\\boot.ini", "..\\", "\\\\boot.ini", 3]
  ]

  for (const [line, traversal, target, depth] of ROWS) {
    test(line, () => {
      expect(ok(line)).toEqual({ prefix: "", traversal, depth, target, suffix: "" })
      // The round trip is the real assertion: assemble gives up exactly one
      // separator, so the target has to carry one more than the wire shows.
      expect(reassemble(ok(line))).toBe(line)
    })
  }

  test("the reflow is narrow: a different TOKEN at the tail is still raw", () => {
    // Twelve steps ending in '%25%5c' and one in '%255c' are two different
    // tokens, not a separator the target should get back.
    const result = decompose("..%25%5c..%25%5c..%25%5c..%255cboot.ini")
    expect(result.kind).toBe("raw")
  })

  test("the reflow is narrow: it never invents a depth-1 monolith", () => {
    // Head period 2, odd length: reflowing would give a chain with no proper
    // period, i.e. a primitive that reproduces one string and nothing else.
    const result = decompose("..\\..\\\\..\\..\\\\..\\\\\\boot.ini")
    expect(result.kind).toBe("raw")
  })
})

describe("entries the generative model cannot reach", () => {
  test("a repetition that breaks at its last step goes to raw", () => {
    const result = decompose("..%25%5c..%25%5c..%25%5c..%255cboot.ini")
    expect(result.kind).toBe("raw")
    if (result.kind === "raw") expect(result.why).toMatch(/breaks at the last step/)
  })

  test("a corrupt line is rejected rather than routed", () => {
    expect(decompose("..2f..2f..2fetc2fpasswd").kind).toBe("reject")
    expect(rejectReason("..2f..2f..2fetc2fpasswd")).toBe("corrupt:stripped-percent")
  })
})

describe("classification never decodes", () => {
  test("partial and full encoding are siblings, not a subset relation", () => {
    expect(primaryClass("../../../etc/passwd")).toBe("plain")
    expect(primaryClass("../../../etc%2fpasswd")).toBe("partial-sep")
    expect(primaryClass("%2e%2e/%2e%2e/etc/passwd")).toBe("partial-dots")
    expect(primaryClass("%2e%2e%2f%2e%2e%2fetc%2fpasswd")).toBe("full-url")
    expect(primaryClass("%252e%252e%252fetc")).toBe("double-url")
  })

  test("features are orthogonal and additive", () => {
    expect([...classesOf("..\\..\\boot.ini%00.jpg")].sort()).toEqual([
      "backslash",
      "null-byte",
      "plain",
      "trailing-ext"
    ])
  })
})

describe("the canonical key collapses depth but not spelling", () => {
  test("any depth resolves to the same target, because '..' clamps at the root", () => {
    expect(canonicalTarget("../../../etc/passwd")).toBe("/etc/passwd")
    expect(canonicalTarget("../".repeat(30) + "etc/passwd")).toBe("/etc/passwd")
    expect(resolveClamped("/../../../etc/passwd")).toBe("/etc/passwd")
  })

  test("every spelling resolves to the same target", () => {
    for (
      const payload of [
        "..%2f..%2fetc%2fpasswd",
        "%2e%2e%2f%2e%2e%2fetc%2fpasswd",
        "..%c0%af..%c0%afetc%c0%afpasswd",
        "..%ef%bc%8f..%ef%bc%8fetc%ef%bc%8fpasswd"
      ]
    ) {
      expect(canonicalTarget(payload)).toBe("/etc/passwd")
    }
  })

  test("toLiteral folds a base64 blob back to its path", () => {
    expect(toLiteral("Li4vLi4vLi4vZXRjL3Bhc3N3ZA==")).toBe("../../../etc/passwd")
  })
})
