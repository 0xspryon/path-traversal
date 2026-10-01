import { describe, expect, test } from "bun:test"
import * as NodePath from "node:path"
import { DEFAULTS, parseConfig, parseStrategyEntry } from "../src/config.ts"
import { PtError } from "../src/errors.ts"

const BASE = "/tmp/pt-config-test"
const parse = (yaml: string) => parseConfig(yaml, BASE, "pt.yml")
const at = (relative: string) => NodePath.join(BASE, relative)

const MINIMAL = `slots:
  - { name: target, files: [./templates/target.txt] }
output_file: ./out/wordlist.txt
`

const FOUR_SLOTS = `slots:
  - { name: prefix, files: [./templates/prefix.txt], optional: true }
  - { name: traversal, files: [./templates/traversal.txt], optional: true, repeat: [3, 6] }
  - { name: target, files: [./templates/target.txt] }
  - { name: suffix, files: [./templates/suffix.txt], optional: true, transform: false }
output_file: ./out/wordlist.txt
`

describe("parseConfig", () => {
  test("resolves every path against the config file's directory", () => {
    const config = parse(MINIMAL)
    expect(config.slots[0]!.files).toEqual([at("templates/target.txt")])
    expect(config.outputFile).toBe(at("out/wordlist.txt"))
  })

  test("applies defaults for every omitted key", () => {
    const config = parse(MINIMAL)
    expect(config.overwriteOutputFile).toBe(DEFAULTS.overwriteOutputFile)
    expect(config.limits).toEqual({})
    expect(config.rawFiles).toEqual([])
    // No strategies means the identity, so pt still does something sensible.
    expect(config.strategies.map((s) => s.label)).toEqual(["plain"])
  })

  test("applies defaults for every omitted SLOT property", () => {
    const slot = parse(MINIMAL).slots[0]!
    expect(slot.optional).toBe(false)
    expect(slot.transform).toBe(true)
    expect(slot.repeat).toEqual([1])
    // The strip rule is a no-op wherever it is not needed, so it is the default.
    expect(slot.strip).toBe("when_same_separator")
  })

  test("reads every slot property", () => {
    const slots = parse(FOUR_SLOTS).slots
    expect(slots.map((s) => s.name)).toEqual(["prefix", "traversal", "target", "suffix"])
    expect(slots[0]!.optional).toBe(true)
    expect(slots[1]!.repeat).toEqual([3, 6])
    expect(slots[2]!.optional).toBe(false)
    expect(slots[3]!.transform).toBe(false)
  })

  test("slot order is config order -- a slot between target and suffix is legal", () => {
    const config = parse(`slots:
  - { name: traversal, files: [./t.txt], optional: true, repeat: [3] }
  - { name: target, files: [./g.txt] }
  - { name: extension, files: [./e.txt], optional: true }
  - { name: suffix, files: [./s.txt], optional: true }
output_file: ./out.txt
`)
    expect(config.slots.map((s) => s.name)).toEqual([
      "traversal",
      "target",
      "extension",
      "suffix"
    ])
  })

  test("a slot can declare its own strip rule", () => {
    const config = parse(`slots:
  - { name: target, files: [./g.txt], strip_leading_separator: never }
output_file: ./out.txt
`)
    expect(config.slots[0]!.strip).toBe("never")
  })

  test("reads limits", () => {
    const config = parse(`${MINIMAL}limits:
  warn_above: 1000
  max_payloads: 2000
`)
    expect(config.limits).toEqual({ warnAbove: 1000, maxPayloads: 2000 })
  })

  test("a single path is accepted where a list is", () => {
    const config = parse(`slots:
  - { name: target, files: ./g.txt }
output_file: ./out.txt
`)
    expect(config.slots[0]!.files).toEqual([at("g.txt")])
  })
})

// §9: always-scalar strategies, with the slot overrides the mapping form carried.
describe("strategies are always scalar strings", () => {
  test("a bare pipeline has no overrides", () => {
    const config = parse(`${MINIMAL}strategies:
  - plain
  - url_encode:1>hex_case_upper
  - dot_noise
`)
    expect(config.strategies.map((s) => s.label)).toEqual([
      "plain",
      "url_encode:1 > hex_case_upper",
      "dot_noise"
    ])
    expect(config.strategies[0]!.stages).toHaveLength(0)
    expect(config.strategies[1]!.stages).toHaveLength(2)
    expect(config.strategies[0]!.overrides).toEqual({})
  })

  test("charset rides inside the stage, which is what deleted the mapping form", () => {
    const config = parse(`${MINIMAL}strategies:
  - 'base64 > url_encode:1(charset="+/=")'
`)
    expect(config.strategies[0]!.label).toBe('base64 > url_encode:1(charset="+/=")')
  })

  test("slot overrides come after a '|'", () => {
    const config = parse(`${FOUR_SLOTS}strategies:
  - "plain | target=./templates/php.txt, traversal.repeat=3"
  - "plain | prefix=./a.txt, prefix=./b.txt"
  - "plain | suffix="
`)
    expect(config.strategies[0]!.overrides).toEqual({
      target: { files: [at("templates/php.txt")] },
      traversal: { repeat: [3] }
    })
    expect(config.strategies[1]!.overrides.prefix).toEqual({
      files: [at("a.txt"), at("b.txt")]
    })
    // 'suffix=' with nothing after it turns an optional slot off, which v1 needed
    // a real empty file on disk to express.
    expect(config.strategies[2]!.overrides.suffix).toEqual({ files: [] })
  })

  test("parseStrategyEntry on its own", () => {
    expect(parseStrategyEntry("plain")).toEqual({ pipeline: "plain", overrides: {} })
    expect(parseStrategyEntry("padding:2048 | target=./a.txt, traversal.repeat=3 6"))
      .toEqual({
        pipeline: "padding:2048",
        overrides: { target: { files: ["./a.txt"] }, traversal: { repeat: [3, 6] } }
      })
  })

  test("the default charset is the fallback for a stage with no argument", () => {
    const config = parse(`${MINIMAL}url_encode_charset: "+/="
strategies:
  - url_encode:1
`)
    expect(config.strategies[0]!.stages[0]!.name).toBe("url_encode:1")
  })
})

describe("parseConfig fails loudly", () => {
  const expectError = (yaml: string, match: RegExp) => {
    let thrown: unknown
    try {
      parse(yaml)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(PtError)
    expect((thrown as PtError).message).toMatch(match)
  }

  test("on an unknown strategy name, naming the valid set", () => {
    expectError(`${MINIMAL}strategies: [url_encoded:1]\n`, /strategies\[0\]/)
    expectError(`${MINIMAL}strategies: [url_encoded:1]\n`, /unknown strategy 'url_encoded'/)
    expectError(`${MINIMAL}strategies: [url_encoded:1]\n`, /Valid strategies:/)
    expectError(`${MINIMAL}strategies: [url_encoded:1]\n`, /url_encode:N/)
  })

  test("on a standalone hex_case, through the stage signature", () => {
    expectError(`${MINIMAL}strategies: [hex_case_upper]\n`, /needs 'escapes'/)
    expectError(`${MINIMAL}strategies: ["plain", "hex_case_lower"]\n`, /strategies\[1\]/)
  })

  test("on a composition the signatures forbid", () => {
    expectError(
      `${MINIMAL}strategies: ["base64 > dot_noise"]\n`,
      /'dot_noise' needs 'path'/
    )
  })

  test("on an empty strategies list", () => {
    expectError(`${MINIMAL}strategies: []\n`, /'strategies' must not be an empty list/)
  })

  test("on an override of a slot that does not exist", () => {
    expectError(
      `${MINIMAL}strategies: ["plain | traversal=./a.txt"]\n`,
      /override names slot 'traversal', which no 'slots' entry declares/
    )
    expectError(
      `${MINIMAL}strategies: ["plain | traversal=./a.txt"]\n`,
      /Declared slots: target/
    )
  })

  test("on an override that turns a REQUIRED slot off", () => {
    expectError(
      `${MINIMAL}strategies: ["plain | target="]\n`,
      /override turns off required slot 'target'/
    )
  })

  test("on malformed override syntax", () => {
    expectError(`${MINIMAL}strategies: ["plain | target"]\n`, /needs an '='/)
    expectError(
      `${MINIMAL}strategies: ["plain | target.repeat=x"]\n`,
      /needs one or more positive integers/
    )
    expectError(
      `${MINIMAL}strategies: ["plain | target.transform=false"]\n`,
      /cannot be overridden per strategy/
    )
  })

  test("the removed v1 keys each explain their migration", () => {
    const cases: ReadonlyArray<readonly [string, RegExp]> = [
      ["url_encode: [0, 1, 2]", /'url_encode' was removed/],
      ["base64_encode: [0, 1]", /add '- base64' as a strategy/],
      ["prefix_file: [./a.txt]", /replaced by 'slots'/],
      ["traversal_file: [./a.txt]", /name: traversal/],
      ["target_file: [./a.txt]", /the one with no empty member/],
      ["suffix_file: [./a.txt]", /transform: false/],
      ["traversal_depth: [3]", /replaced by the 'repeat' property/],
      ["include_payloads_without_prefix: true", /replaced by the 'optional' property/],
      ["include_payloads_without_traversal: true", /optional: true/],
      ["include_payloads_without_suffix: false", /optional: true/],
      ["do_not_transform: [./a.txt]", /replaced by 'transform: false' on the slot/],
      ["do_not_transform: [./a.txt]", /prefix that line with '!'/]
    ]
    for (const [line, match] of cases) {
      expectError(`${MINIMAL}${line}\n`, match)
    }
  })

  test("a v1 mapping strategy explains the scalar replacement", () => {
    expectError(
      `${MINIMAL}strategies:\n  - { pipeline: "base64 > url_encode:1", charset: "+/=" }\n`,
      /strategies\[0\] is a mapping/
    )
    expectError(
      `${MINIMAL}strategies:\n  - { pipeline: "base64 > url_encode:1", charset: "+/=" }\n`,
      /charset moves into the stage/
    )
    expectError(
      `${MINIMAL}strategies:\n  - { pipeline: plain, targets: ./a.txt, depths: [3] }\n`,
      /'targets' becomes '\| target=<path>'/
    )
    expectError(
      `${MINIMAL}strategies:\n  - { pipeline: plain, depths: [3] }\n`,
      /'depths' becomes '\| <slot>\.repeat=3 6'/
    )
  })

  test("on a renamed strategy name", () => {
    expectError(`${MINIMAL}strategies: ["noise:dot"]\n`, /was renamed to 'dot_noise'/)
    expectError(`${MINIMAL}strategies: ["selective:last"]\n`, /'selective_last'/)
  })

  test("on an unknown config key", () => {
    expectError(`${MINIMAL}url_encoed: [1]\n`, /Expected no excess property/)
  })

  test("on a missing or empty slots list", () => {
    expectError(`output_file: ./out.txt\n`, /Missing key[\s\S]*slots/i)
    expectError(`slots: []\noutput_file: ./out.txt\n`, /must list at least one slot/)
  })

  test("on a required slot with no files", () => {
    expectError(
      `slots:\n  - { name: target }\noutput_file: ./out.txt\n`,
      /required \(no 'optional: true'\) but names no files/
    )
  })

  test("when every slot is optional", () => {
    expectError(
      `slots:\n  - { name: a, files: [./a.txt], optional: true }\noutput_file: ./out.txt\n`,
      /At least one slot must be required/
    )
  })

  test("on a duplicate or unusable slot name", () => {
    expectError(
      `slots:\n  - { name: target, files: [./a.txt] }\n  - { name: target, files: [./b.txt] }\noutput_file: ./o.txt\n`,
      /slot name 'target' is used twice/
    )
    expectError(
      `slots:\n  - { name: Target, files: [./a.txt] }\noutput_file: ./o.txt\n`,
      /is not a usable slot name/
    )
    expectError(
      `slots:\n  - { name: synthetic, files: [./a.txt] }\noutput_file: ./o.txt\n`,
      /'synthetic' is reserved/
    )
  })

  test("on a repeat of 0 or an empty ladder", () => {
    expectError(
      `slots:\n  - { name: target, files: [./a.txt], repeat: [0] }\noutput_file: ./o.txt\n`,
      /greater than or equal to 1/
    )
    expectError(
      `slots:\n  - { name: target, files: [./a.txt], repeat: [] }\noutput_file: ./o.txt\n`,
      /'repeat' must not be an empty list/
    )
  })

  test("on an unknown strip rule", () => {
    expectError(
      `slots:\n  - { name: target, files: [./a.txt], strip_leading_separator: sometimes }\noutput_file: ./o.txt\n`,
      /when_same_separator/
    )
  })

  test("on a bad limits value", () => {
    expectError(`${MINIMAL}limits: { max_payloads: 0 }\n`, /greater than or equal to 1/)
    expectError(`${MINIMAL}limits: { warn_above: -1 }\n`, /greater than or equal to 0/)
    expectError(`${MINIMAL}limits: { warn_abov: 1 }\n`, /Expected no excess property/)
  })

  test("on malformed YAML", () => {
    expectError(`slots: [\n  oops\n`, /not valid YAML/)
  })

  test("on a top-level document that is not a mapping", () => {
    expectError(`- a\n- b\n`, /expected a YAML mapping at the top level/)
    expectError(``, /expected a YAML mapping at the top level/)
  })
})
