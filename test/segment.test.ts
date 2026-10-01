import { describe, expect, test } from "bun:test"
import {
  base64Text,
  DEFAULT_URL_ENCODE_CHARSET,
  hexCaseText,
  isCommentLine,
  parseLines,
  percentEncodeChar,
  readEscape,
  replaceChars,
  toSegments,
  urlEncodeText
} from "../src/core/index.ts"

const charset = DEFAULT_URL_ENCODE_CHARSET

describe("urlEncodeText", () => {
  test("0 passes is the identity", () => {
    expect(urlEncodeText("../etc/passwd", charset, 0)).toBe("../etc/passwd")
  })

  test("pass 1 percent-encodes only the charset characters", () => {
    expect(urlEncodeText("../etc/passwd", charset, 1)).toBe(
      "%2e%2e%2fetc%2fpasswd"
    )
  })

  test("later passes re-encode the percent signs", () => {
    expect(urlEncodeText("../", charset, 2)).toBe("%252e%252e%252f")
    expect(urlEncodeText("../", charset, 3)).toBe("%25252e%25252e%25252f")
  })

  test("a pre-existing percent sign in the input is re-encoded too", () => {
    expect(urlEncodeText("..%2f", charset, 1)).toBe("%2e%2e%2f")
    expect(urlEncodeText("..%2f", charset, 2)).toBe("%252e%252e%252f")
  })

  test("backslash is in the default charset", () => {
    expect(urlEncodeText("..\\", charset, 1)).toBe("%2e%2e%5c")
  })

  test("is homomorphic over concatenation, which is why it runs per segment", () => {
    const a = "../../"
    const b = "etc/passwd"
    expect(urlEncodeText(a, charset, 2) + urlEncodeText(b, charset, 2)).toBe(
      urlEncodeText(a + b, charset, 2)
    )
  })

  test("a non-default charset encodes different characters", () => {
    expect(urlEncodeText("a+b/c=d", "+/=", 1)).toBe("a%2bb%2fc%3dd")
    expect(urlEncodeText("a+b/c=d", charset, 1)).toBe("a+b%2fc=d")
  })
})

describe("percentEncodeChar", () => {
  test("encodes every UTF-8 byte in lowercase hex", () => {
    expect(percentEncodeChar("/")).toBe("%2f")
    expect(percentEncodeChar("\\")).toBe("%5c")
    expect(percentEncodeChar("／")).toBe("%ef%bc%8f")
  })
})

describe("hexCaseText", () => {
  test("rewrites escape hex digits only", () => {
    expect(hexCaseText("%2e%2e%2fetc", "upper")).toBe("%2E%2E%2Fetc")
    expect(hexCaseText("%2E%2E%2FETC", "lower")).toBe("%2e%2e%2fETC")
  })

  test("leaves a lone percent sign alone", () => {
    expect(hexCaseText("100%ok", "upper")).toBe("100%ok")
  })
})

describe("replaceChars", () => {
  test("expands one character into many", () => {
    expect(replaceChars("../a", { "/": "/./" })).toBe(".././a")
    expect(replaceChars("a/b", { "/": "//" })).toBe("a//b")
  })

  test("leaves unmapped characters untouched", () => {
    expect(replaceChars("abc", { "/": "X" })).toBe("abc")
  })
})

describe("base64Text", () => {
  test("base64 is NOT homomorphic over concatenation", () => {
    // `..%2f` is 5 bytes: not a multiple of 3, which is exactly where naive
    // per-segment base64 silently truncates.
    const a = "..%2f"
    const b = "etc/passwd"
    expect(base64Text(a) + base64Text(b)).not.toBe(base64Text(a + b))
    expect(base64Text(a).endsWith("=")).toBe(true)
  })

  test("round-trips through atob", () => {
    expect(atob(base64Text("../../../etc/passwd"))).toBe("../../../etc/passwd")
  })
})

describe("parseLines", () => {
  test("trims, drops blanks and drops comments", () => {
    expect(parseLines("  ../ \n\n# a comment\n#\n## banner\n/etc/passwd\n")).toEqual([
      { text: "../", line: 1 },
      { text: "/etc/passwd", line: 6 }
    ])
  })

  test("the line number counts the comments and blanks it skipped", () => {
    // Provenance has to point at the real line of the real file, or the report
    // sends the user to the wrong place.
    expect(parseLines("# header\n#\n/etc/passwd\n").map((l) => l.line)).toEqual([3])
  })

  test("keeps '#.png', which is a real payload and not a comment", () => {
    expect(parseLines("%00.png\n#.png\n;.png\n").map((l) => l.text)).toEqual([
      "%00.png",
      "#.png",
      ";.png"
    ])
    expect(isCommentLine("#.png")).toBe(false)
    expect(isCommentLine("# nope")).toBe(true)
  })
})

// §2: the per-line escape that replaces a file-level `do_not_transform` list.
describe("the '!' escape", () => {
  test("a leading '!' flips the slot's transform setting", () => {
    expect(readEscape("%00.png", true)).toEqual({ text: "%00.png", transform: true })
    expect(readEscape("!%00.png", true)).toEqual({ text: "%00.png", transform: false })
    expect(readEscape("%00.png", false)).toEqual({ text: "%00.png", transform: false })
    expect(readEscape("!%00.png", false)).toEqual({ text: "%00.png", transform: true })
  })

  test("'!!' is a literal leading '!' with the slot's own setting", () => {
    expect(readEscape("!!weird", true)).toEqual({ text: "!weird", transform: true })
    expect(readEscape("!!weird", false)).toEqual({ text: "!weird", transform: false })
  })
})

describe("toSegments", () => {
  test("tags every line with its slot, transform flag and provenance", () => {
    expect(toSegments([{ text: "%00.png", line: 7 }], "suffix", false, "/t/suffix.txt"))
      .toEqual([
        {
          text: "%00.png",
          slot: "suffix",
          transform: false,
          origin: { file: "/t/suffix.txt", line: 7 }
        }
      ])
  })

  test("the '!' escape reaches the segment", () => {
    expect(
      toSegments([{ text: "!/etc/passwd", line: 1 }], "target", true, "/t/x.txt")[0]
    ).toEqual({
      text: "/etc/passwd",
      slot: "target",
      transform: false,
      origin: { file: "/t/x.txt", line: 1 }
    })
  })

  test("a line that is nothing but '!' yields no segment", () => {
    expect(toSegments([{ text: "!", line: 1 }], "target", true, "/t/x.txt")).toEqual([])
  })
})
