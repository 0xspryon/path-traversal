import { describe, expect, test } from "bun:test"
import {
  anchorSlotOf,
  collectingStore,
  DEFAULT_URL_ENCODE_CHARSET,
  generate,
  parsePipeline,
  type GeneratorOptions,
  type Segment,
  type Slot,
  type Strategy
} from "../src/core/index.ts"
import { protectedSeg, seg } from "./support.ts"

const strategy = (
  pipeline: string,
  extras: Omit<Partial<Strategy>, "label" | "stages"> = {},
  charset: string = DEFAULT_URL_ENCODE_CHARSET
): Strategy => {
  const parsed = parsePipeline(pipeline, charset)
  return { label: parsed.label, stages: parsed.stages, ...extras }
}

const slot = (
  name: string,
  members: ReadonlyArray<Segment>,
  extras: Partial<Omit<Slot, "name" | "members">> = {}
): Slot => ({
  name,
  members,
  optional: extras.optional ?? false,
  repeat: extras.repeat ?? [1],
  strip: extras.strip ?? "when_same_separator"
})

const options = (
  strategies: ReadonlyArray<Strategy>,
  overrides: Partial<GeneratorOptions> = {}
): GeneratorOptions => ({ strategies, ...overrides })

/** The v1 four-dimension shape, expressed as slots. */
const BASE: ReadonlyArray<Slot> = [
  slot("prefix", [seg("/var/www/html/", "prefix")], { optional: true }),
  slot("traversal", [seg("../", "traversal"), seg("..%2f", "traversal")], {
    optional: true,
    repeat: [3]
  }),
  slot("target", [seg("/etc/passwd", "target"), seg("/.env", "target")]),
  slot("suffix", [protectedSeg("%00.png")], { optional: true })
]

const run = (
  slots: ReadonlyArray<Slot>,
  opts: GeneratorOptions
) => generate(slots, { store: collectingStore(), ...opts })

const payloadsOf = (
  slots: ReadonlyArray<Slot>,
  opts: GeneratorOptions
): ReadonlyArray<string> => run(slots, opts).payloads ?? []

describe("strategies are a UNION, never a product", () => {
  test("N strategies cost at most N x the base, not the product", () => {
    const names = [
      "plain",
      "dot_noise",
      "url_encode:1",
      "url_encode:2",
      "overlong_utf8",
      "fullwidth",
      "selective_last",
      "base64"
    ]
    const base = run(BASE, options([strategy("plain")])).total
    const all = run(BASE, options(names.map((name) => strategy(name)))).total

    expect(base).toBeGreaterThan(0)
    expect(all).toBeLessThanOrEqual(base * names.length)
    // A product of the same techniques would be astronomically larger.
    expect(all).toBeLessThan(base ** 2)
  })

  test("each strategy emits exactly the base count", () => {
    const result = run(
      BASE,
      options([strategy("plain"), strategy("url_encode:1"), strategy("base64")])
    )
    const [first, ...rest] = result.strategies
    expect(first!.generated).toBeGreaterThan(0)
    for (const report of rest) {
      expect(report.generated).toBe(first!.generated)
    }
  })

  test("adding a strategy adds at most the base count to the total", () => {
    const one = run(BASE, options([strategy("plain")])).total
    const two = run(BASE, options([strategy("plain"), strategy("dot_noise")])).total
    expect(two).toBeGreaterThan(one)
    expect(two).toBeLessThanOrEqual(one * 2)
  })
})

describe("output order follows strategy order", () => {
  test("each strategy's block is contiguous and in config order", () => {
    const names = ["plain", "dot_noise", "url_encode:1", "url_encode:2"]
    const all = payloadsOf(BASE, options(names.map((n) => strategy(n))))

    let cursor = 0
    const seen = new Set<string>()
    for (const name of names) {
      const fresh = payloadsOf(BASE, options([strategy(name)])).filter(
        (payload) => !seen.has(payload)
      )
      expect(all.slice(cursor, cursor + fresh.length)).toEqual(fresh)
      for (const payload of fresh) seen.add(payload)
      cursor += fresh.length
    }
    expect(cursor).toBe(all.length)
  })

  test("a payload two strategies both emit appears once, at its earliest position", () => {
    // A target with no separator at all is spelled identically by every
    // strategy, so the second one contributes nothing.
    const result = run(
      [slot("target", [seg("passwd", "target")])],
      options([strategy("plain"), strategy("url_encode:1")])
    )
    expect(result.payloads).toEqual(["passwd"])
    expect(result.strategies[0]!.marginal).toBe(1)
    expect(result.strategies[1]!.marginal).toBe(0)
    expect(result.strategies[1]!.generated).toBe(1)
  })
})

describe("marginal contribution reporting", () => {
  test("generated counts every payload, marginal only the new ones", () => {
    const result = run(
      BASE,
      options([strategy("plain"), strategy("plain"), strategy("url_encode:1")])
    )
    const [first, second, third] = result.strategies
    expect(second!.generated).toBe(first!.generated)
    expect(second!.marginal).toBe(0) // an exact duplicate earns nothing
    expect(third!.marginal).toBeGreaterThan(0)
    expect(result.total).toBe(first!.marginal + third!.marginal)
  })

  test("raw entries are counted separately and lead the output", () => {
    const result = run(
      BASE,
      options([strategy("plain")], { raw: ["..%c0%af..%c1%9cboot.ini"] })
    )
    expect(result.rawCount).toBe(1)
    expect(result.payloads![0]).toBe("..%c0%af..%c1%9cboot.ini")
  })
})

// §6: the order-independent column.
describe("'unique' is order-independent, 'new' is not", () => {
  test("two identical strategies each earn ZERO unique, whatever the order", () => {
    const result = run(BASE, options([strategy("plain"), strategy("plain")]))
    expect(result.strategies[0]!.marginal).toBeGreaterThan(0)
    expect(result.strategies[1]!.marginal).toBe(0)
    // Neither can be deleted on the evidence of 'new' alone; both can on 'unique'.
    expect(result.strategies[0]!.unique).toBe(0)
    expect(result.strategies[1]!.unique).toBe(0)
  })

  test("swapping two strategies swaps their 'new' but not their 'unique'", () => {
    // 'plain' makes {passwd, /etc/passwd}; 'url_encode:1' makes
    // {passwd, %2fetc%2fpasswd}. They overlap on exactly one payload, so whichever
    // runs second shows a smaller 'new' while both keep the same 'unique'.
    const slots = [slot("target", [seg("passwd", "target"), seg("/etc/passwd", "target")])]
    const a = strategy("plain")
    const b = strategy("url_encode:1")
    const forward = run(slots, options([a, b]))
    const backward = run(slots, options([b, a]))

    expect(forward.strategies.map((r) => r.marginal)).toEqual([2, 1])
    expect(backward.strategies.map((r) => r.marginal)).toEqual([2, 1])
    expect(forward.strategies[0]!.unique).toBe(backward.strategies[1]!.unique)
    expect(forward.strategies[1]!.unique).toBe(backward.strategies[0]!.unique)
    expect(forward.strategies.map((r) => r.unique)).toEqual([1, 1])
  })

  test("a strategy nothing else duplicates has unique === marginal", () => {
    const result = run(BASE, options([strategy("plain"), strategy("base64")]))
    expect(result.strategies[1]!.unique).toBe(result.strategies[1]!.marginal)
  })

  test("rawUnique counts the verbatim entries no strategy also produces", () => {
    const result = run(
      [slot("target", [seg("/etc/passwd", "target")])],
      options([strategy("plain")], {
        raw: ["/etc/passwd", "..%25%5c..%255cboot.ini"]
      })
    )
    expect(result.rawCount).toBe(2)
    // '/etc/passwd' is also generated, so only the inconsistent one is raw-only.
    expect(result.rawUnique).toBe(1)
  })
})

// §3 + §6: provenance makes per-INPUT attribution expressible.
describe("per-input attribution", () => {
  const withOrigin = (
    text: string,
    slotName: string,
    file: string,
    line: number
  ): Segment => ({ text, slot: slotName, transform: true, origin: { file, line } })

  test("nothing is attributed unless asked", () => {
    const result = run(BASE, options([strategy("plain")]))
    expect(result.inputs).toEqual([])
  })

  test("a line that only one combination produces earns its payloads", () => {
    const result = run(
      [
        slot("traversal", [withOrigin("../", "traversal", "/t/trav.txt", 4)], {
          repeat: [3]
        }),
        slot("target", [withOrigin("/etc/passwd", "target", "/t/target.txt", 2)])
      ],
      options([strategy("plain")], { attribute: true })
    )
    expect(result.inputs).toHaveLength(2)
    for (const input of result.inputs) {
      expect(input.marginal).toBe(1)
      expect(input.unique).toBe(1)
    }
    expect(result.inputs[0]).toMatchObject({ file: "/t/trav.txt", line: 4, text: "../" })
  })

  // The NOTES.md idea, measured rather than assumed. A pre-encoded traversal seed
  // is redundant only against the strategies that derive the same bytes:
  // `url_encode:1` maps BOTH '../' and '..%2f' onto '%2e%2e%2f', so with only that
  // strategy enabled each seed earns nothing the other does not, and the report
  // names the strategy that covers it.
  test("a seed another seed+strategy derives earns ZERO unique, and says who covers it", () => {
    const result = run(
      [
        slot(
          "traversal",
          [
            withOrigin("../", "traversal", "/t/traversal.txt", 1),
            withOrigin("..%2f", "traversal", "/t/traversal.txt", 3)
          ],
          { repeat: [3] }
        ),
        slot("target", [withOrigin("passwd", "target", "/t/target.txt", 1)])
      ],
      options([strategy("url_encode:1")], { attribute: true })
    )
    expect(result.total).toBe(1)
    const encoded = result.inputs.find((input) => input.text === "..%2f")!
    expect(encoded.unique).toBe(0)
    expect(encoded.witness).toEqual({ strategy: "url_encode:1", instead: "../" })
  })

  // ... and the honest converse: with 'plain' in the union the same seed is NOT
  // redundant, because its own literal spelling reaches the wire.
  test("the same seed earns its keep as soon as a strategy emits it literally", () => {
    const result = run(
      [
        slot(
          "traversal",
          [
            withOrigin("../", "traversal", "/t/traversal.txt", 1),
            withOrigin("..%2f", "traversal", "/t/traversal.txt", 3)
          ],
          { repeat: [3] }
        ),
        slot("target", [withOrigin("passwd", "target", "/t/target.txt", 1)])
      ],
      options([strategy("plain"), strategy("url_encode:1")], { attribute: true })
    )
    const encoded = result.inputs.find((input) => input.text === "..%2f")!
    expect(encoded.unique).toBe(1)
    expect(result.payloads).toContain("..%2f..%2f..%2fpasswd")
  })

  test("two identical lines in one slot make each other redundant", () => {
    const result = run(
      [
        slot("target", [
          withOrigin("/etc/passwd", "target", "/t/a.txt", 1),
          withOrigin("/etc/passwd", "target", "/t/b.txt", 1)
        ])
      ],
      options([strategy("plain")], { attribute: true })
    )
    expect(result.total).toBe(1)
    expect(result.inputs.map((input) => input.unique)).toEqual([0, 0])
  })

  test("a line used by two slots records both slot names", () => {
    const shared = { file: "/t/both.txt", line: 1 }
    const result = run(
      [
        { ...slot("alpha", [{ text: "a/", slot: "alpha", transform: true, origin: shared }]) },
        { ...slot("beta", [{ text: "a/", slot: "beta", transform: true, origin: shared }]) }
      ],
      options([strategy("plain")], { attribute: true })
    )
    expect(result.inputs).toHaveLength(1)
    expect([...result.inputs[0]!.slots].sort()).toEqual(["alpha", "beta"])
  })
})

describe("raw entries", () => {
  const raw = "..%c0%af..%c0%af..%c1%9cboot.ini"

  test("are verbatim: never rewritten by any strategy, never repeat-multiplied", () => {
    const result = run(
      [
        slot("traversal", [seg("../", "traversal")], { optional: true, repeat: [3, 6] }),
        slot("target", [seg("/etc/passwd", "target")])
      ],
      options(["plain", "url_encode:1", "base64", "dot_noise"].map((n) => strategy(n)), {
        raw: [raw]
      })
    )
    expect(result.payloads!.filter((p) => p === raw)).toHaveLength(1)
    expect(result.payloads!.some((p) => p !== raw && p.includes("%c1%9c"))).toBe(false)
  })
})

describe("dedupe", () => {
  test("identical input lines produce a single payload", () => {
    const payloads = payloadsOf(
      [
        slot("traversal", [seg("../", "traversal"), seg("../", "traversal")], {
          optional: true,
          repeat: [3, 3]
        }),
        slot("target", [seg("/etc/passwd", "target"), seg("/etc/passwd", "target")])
      ],
      options([strategy("plain")])
    )
    expect(new Set(payloads).size).toBe(payloads.length)
    expect(payloads).toEqual(["/etc/passwd", "../../../etc/passwd"])
  })

  test("an empty slot member does not walk the repeat ladder", () => {
    expect(
      payloadsOf(
        [
          slot("traversal", [seg("../", "traversal")], {
            optional: true,
            repeat: [1, 2, 3]
          }),
          slot("target", [seg("/etc/passwd", "target")])
        ],
        options([strategy("plain")])
      )
    ).toEqual([
      "/etc/passwd",
      "../etc/passwd",
      "../../etc/passwd",
      "../../../etc/passwd"
    ])
  })
})

describe("per-strategy slot overrides", () => {
  test("an override replaces only that slot's members", () => {
    const result = run(
      BASE,
      options([
        strategy("padding:2", {
          overrides: {
            target: { members: [seg("/etc/passwd", "target")] },
            traversal: { repeat: [3] }
          }
        })
      ])
    )
    expect(result.payloads!.every((p) => p.includes("etc/passwd"))).toBe(true)
    expect(result.payloads!.some((p) => p.includes(".env"))).toBe(false)
    expect(result.payloads!.some((p) => p.startsWith("././"))).toBe(true)
  })

  test("a repeat override replaces the ladder for that strategy only", () => {
    const result = run(
      [
        slot("traversal", [seg("../", "traversal")], { optional: true, repeat: [5] }),
        slot("target", [seg("/etc/passwd", "target")])
      ],
      options([
        strategy("plain"),
        strategy("dot_noise", { overrides: { traversal: { repeat: [1] } } })
      ])
    )
    expect(result.payloads).toContain("../../../../../etc/passwd")
    expect(result.payloads).toContain(".././etc/./passwd")
    expect(result.payloads!.some((p) => p === ".././.././.././.././.././etc/./passwd"))
      .toBe(false)
  })

  test("an override to no members at all turns an optional slot off", () => {
    const result = run(
      BASE,
      options([strategy("plain", { overrides: { suffix: { members: [] } } })])
    )
    expect(result.payloads!.some((p) => p.includes("%00.png"))).toBe(false)
  })
})

// §1: `optional` is the whole of v1's three `include_payloads_without_*` booleans.
describe("optional slots", () => {
  test("a required slot has no empty member", () => {
    const payloads = payloadsOf(
      [
        slot("prefix", [seg("/var/www/", "prefix")]),
        slot("traversal", [seg("../", "traversal")]),
        slot("target", [seg("/etc/passwd", "target")]),
        slot("suffix", [seg("%00.png", "suffix")])
      ],
      options([strategy("plain")])
    )
    expect(payloads).toEqual(["/var/www/../etc/passwd%00.png"])
  })

  test("a slot with no files at all still yields the empty member", () => {
    expect(
      payloadsOf(
        [
          slot("prefix", [], { optional: true }),
          slot("target", [seg("/etc/passwd", "target")])
        ],
        options([strategy("plain")])
      )
    ).toEqual(["/etc/passwd"])
  })

  test("any slot can repeat, not just a traversal", () => {
    expect(
      payloadsOf(
        [
          slot("target", [seg("/etc/passwd", "target")]),
          slot("suffix", [seg(".bak", "suffix")], { optional: true, repeat: [1, 3] })
        ],
        options([strategy("plain")])
      )
    ).toEqual(["/etc/passwd", "/etc/passwd.bak", "/etc/passwd.bak.bak.bak"])
  })
})

describe("anchorSlotOf", () => {
  test("is the LAST required slot with members", () => {
    expect(anchorSlotOf(BASE)).toBe("target")
  })

  test("is undefined when every slot is optional", () => {
    expect(anchorSlotOf([slot("a", [seg("x", "a")], { optional: true })])).toBeUndefined()
  })
})

describe("maxPayloads", () => {
  test("stops the run and flags it", () => {
    const result = run(
      BASE,
      options(
        ["plain", "url_encode:1", "url_encode:2", "base64"].map((n) => strategy(n)),
        { maxPayloads: 5 }
      )
    )
    expect(result.exceeded).toBe(true)
    expect(result.total).toBeGreaterThan(5)
    // It stopped early, so not every strategy was reached.
    expect(result.strategies.length).toBeLessThan(4)
  })

  test("a run that fits is not flagged", () => {
    const result = run(BASE, options([strategy("plain")], { maxPayloads: 1000 }))
    expect(result.exceeded).toBe(false)
    expect(result.strategies).toHaveLength(1)
  })
})
