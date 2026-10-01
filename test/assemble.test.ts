import { describe, expect, test } from "bun:test"
import {
  assemble,
  joinSegments,
  leadingSeparator,
  stripLeading,
  trailingSeparator,
  type StripRule
} from "../src/core/index.ts"
import { seg, slotOf } from "./support.ts"

const none = (slot: string) => seg("", slot, false)

const build = (parts: {
  prefix?: string
  traversal?: string
  depth?: number
  target: string
  suffix?: string
  strip?: StripRule
}): string =>
  joinSegments(
    assemble([
      slotOf(
        parts.prefix === undefined ? none("prefix") : seg(parts.prefix, "prefix")
      ),
      slotOf(
        parts.traversal === undefined
          ? none("traversal")
          : seg(parts.traversal, "traversal"),
        parts.depth ?? 1
      ),
      slotOf(seg(parts.target, "target"), 1, parts.strip ?? "when_same_separator"),
      slotOf(parts.suffix === undefined ? none("suffix") : seg(parts.suffix, "suffix"))
    ])
  )

describe("real wordlist entries reconstruct from their decompositions", () => {
  test("prefix + no traversal + target, separator not doubled", () => {
    expect(
      build({ prefix: "/var/www/localhost/htdocs/", target: "/.htaccess" })
    ).toBe("/var/www/localhost/htdocs/.htaccess")
  })

  test("separator-padding prefix + traversal x 3 + target", () => {
    expect(
      build({ prefix: "///////", traversal: "../", depth: 3, target: "/etc/passwd" })
    ).toBe("///////../../../etc/passwd")
  })

  test("odd traversal primitive x 6 + target that has no leading slash", () => {
    expect(
      build({ prefix: "/", traversal: ".\\\\./", depth: 6, target: "boot.ini" })
    ).toBe("/.\\\\./.\\\\./.\\\\./.\\\\./.\\\\./.\\\\./boot.ini")
  })

  // Regression test for the conditional strip: 536 of the 930 lines in the
  // Jhaddix LFI list are bare absolute paths, so dropping this slash would
  // destroy most of the list.
  test("nothing precedes the target, so its leading slash is PRESERVED", () => {
    expect(build({ target: "/etc/passwd" })).toBe("/etc/passwd")
  })
})

/**
 * The §-finding: the strip is only correct when the two separators either side of
 * the boundary spell THE SAME separator.
 */
describe("strip_leading_separator: when_same_separator", () => {
  test("same separator, literal: strips (unchanged from v1)", () => {
    expect(
      build({ traversal: "../", depth: 3, target: "/etc/passwd" })
    ).toBe("../../../etc/passwd")
  })

  test("same separator, encoded: strips, because %2f IS '/'", () => {
    expect(
      build({ traversal: "..%2f", depth: 3, target: "/etc/passwd" })
    ).toBe("..%2f..%2f..%2fetc/passwd")
  })

  test("DIFFERENT separator: keeps both -- the payload v1 destroyed", () => {
    expect(
      build({ traversal: "..\\", depth: 3, target: "/etc/passwd" })
    ).toBe("..\\..\\..\\/etc/passwd")
  })

  test("nothing precedes: keeps, so an absolute path stays absolute", () => {
    expect(build({ target: "/etc/passwd" })).toBe("/etc/passwd")
  })

  test("every decode-aware spelling of '/' counts as '/'", () => {
    for (const traversal of ["../", "..%2f", "..%252f", "..%25252f", "..%c0%af", "..%ef%bc%8f"]) {
      expect(build({ traversal, depth: 2, target: "/etc/passwd" })).toBe(
        `${traversal}${traversal}etc/passwd`
      )
    }
  })

  test("every decode-aware spelling of '\\\\' keeps a leading '/'", () => {
    for (const traversal of ["..\\", "..%5c", "..%255c", "..%c1%9c", "..%ef%bc%bc"]) {
      expect(build({ traversal, depth: 2, target: "/etc/passwd" })).toBe(
        `${traversal}${traversal}/etc/passwd`
      )
    }
  })

  test("a preceding segment that does not end in a separator keeps the target's", () => {
    // v1 stripped here too and produced '/var/www/htmletc/passwd'.
    expect(build({ prefix: "/var/www/html", target: "/etc/passwd" })).toBe(
      "/var/www/html/etc/passwd"
    )
  })

  test("strips EXACTLY ONE separator, so a doubled junction survives", () => {
    expect(build({ prefix: "/var/www/", target: "///etc/passwd" })).toBe(
      "/var/www///etc/passwd"
    )
  })

  test("the one it strips is the leading one, whatever follows it", () => {
    expect(build({ prefix: "/var/www/", target: "//\\etc/passwd" })).toBe(
      "/var/www//\\etc/passwd"
    )
  })
})

/**
 * The doubled junction, which a greedy strip made inexpressible at ANY target
 * spelling: every one of `/etc/passwd`, `//etc/passwd` and `///etc/passwd`
 * collapsed onto the same payload. 205 of the 398 entries in
 * templates/raw-full.txt are this shape.
 */
describe("the strip is non-greedy: one separator in, one separator out", () => {
  test("one leading separator: stripped, as before", () => {
    expect(build({ traversal: "../", depth: 3, target: "/etc/passwd" })).toBe(
      "../../../etc/passwd"
    )
  })

  test("two: one goes, one stays -- the doubled junction", () => {
    expect(build({ traversal: "../", depth: 3, target: "//etc/passwd" })).toBe(
      "../../..//etc/passwd"
    )
  })

  test("three: one goes, two stay", () => {
    expect(build({ traversal: "../", depth: 3, target: "///etc/passwd" })).toBe(
      "../../..///etc/passwd"
    )
  })

  test("nothing precedes: nothing is stripped at any count", () => {
    expect(build({ target: "/etc/passwd" })).toBe("/etc/passwd")
    expect(build({ target: "//etc/passwd" })).toBe("//etc/passwd")
  })

  test("the encoded spellings strip one token, not the run", () => {
    expect(build({ traversal: "..%2f", depth: 2, target: "%2f%2fetc/passwd" })).toBe(
      "..%2f..%2f%2fetc/passwd"
    )
  })
})

describe("the other two strip rules", () => {
  test("'never' leaves the separator alone, doubling and all", () => {
    expect(
      build({ traversal: "../", depth: 2, target: "/etc/passwd", strip: "never" })
    ).toBe("../..//etc/passwd")
  })

  test("'when_preceded' is v1's rule, kept so a v1 config can be reproduced", () => {
    expect(
      build({ traversal: "..\\", depth: 3, target: "/etc/passwd", strip: "when_preceded" })
    ).toBe("..\\..\\..\\etc/passwd")
  })

  test("'when_preceded' strips one '/' too, so the two rules cannot disagree", () => {
    expect(
      build({ traversal: "../", depth: 3, target: "//etc/passwd", strip: "when_preceded" })
    ).toBe("../../..//etc/passwd")
    expect(
      build({ traversal: "..\\", depth: 2, target: "//etc/passwd", strip: "when_preceded" })
    ).toBe("..\\..\\/etc/passwd")
  })
})

describe("separator identity", () => {
  test("longest token wins, so %252f is not read as %2f", () => {
    expect(trailingSeparator("..%252f")).toEqual({ token: "%252f", kind: "/" })
    expect(leadingSeparator("%255cetc")).toEqual({ token: "%255c", kind: "\\" })
  })

  test("case does not matter", () => {
    expect(trailingSeparator("..%2F")).toEqual({ token: "%2f", kind: "/" })
  })

  test("a non-separator ending has no token", () => {
    expect(trailingSeparator("/etc/passwd")).toBeUndefined()
    expect(leadingSeparator("etc/passwd")).toBeUndefined()
  })

  test("stripLeading is a no-op with nothing in front", () => {
    expect(stripLeading("/etc/passwd", "", "when_same_separator")).toBe("/etc/passwd")
  })
})

describe("assemble", () => {
  test("stripping does not alter the segment's transform flag or slot", () => {
    const segments = assemble([
      slotOf(seg("/var/www/", "prefix", true)),
      slotOf(seg("/etc/passwd", "target", false))
    ])
    expect(segments).toEqual([
      { text: "/var/www/", slot: "prefix", transform: true },
      { text: "etc/passwd", slot: "target", transform: false }
    ])
  })

  test("an empty slot member is never repeat-multiplied", () => {
    expect(build({ prefix: "/a/", traversal: "", depth: 22, target: "b" })).toBe("/a/b")
  })

  test("empty segments are filtered out of the assembly", () => {
    expect(
      assemble([
        slotOf(none("prefix")),
        slotOf(none("traversal")),
        slotOf(seg("/etc/passwd", "target")),
        slotOf(none("suffix"))
      ])
    ).toHaveLength(1)
  })

  test("any number of slots in any order -- not four fixed dimensions", () => {
    // Two traversal slots, which v1 could not express at all: '../' x 3 then
    // '..\\' x 2, for a stack that normalises one separator and not the other.
    expect(
      joinSegments(
        assemble([
          slotOf(seg("../", "traversal_posix"), 3),
          slotOf(seg("..\\", "traversal_win32"), 2),
          slotOf(seg("/etc/passwd", "target")),
          slotOf(seg(".bak", "extension")),
          slotOf(seg("%00.png", "suffix"))
        ])
      )
    ).toBe("../../../..\\..\\/etc/passwd.bak%00.png")
  })
})
