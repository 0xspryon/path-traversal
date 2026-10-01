import { describe, expect, test } from "bun:test"
import * as NodeFs from "node:fs/promises"
import * as NodePath from "node:path"
import { isCommentLine } from "../src/core/index.ts"
import { classifyTarget, separatorFamily } from "../scripts/categorize.ts"

const TEMPLATES = NodePath.resolve(import.meta.dirname, "..", "templates")

const body = async (relative: string): Promise<Array<string>> =>
  (await NodeFs.readFile(NodePath.join(TEMPLATES, relative), "utf8"))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !isCommentLine(line))

/**
 * Rule 1 of the split: an OS-rooted path beats a stack marker, because the path
 * only resolves on that OS. Rule 2: otherwise the most specific component wins,
 * runtime before infrastructure before distro.
 */
describe("classifyTarget", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    // Rule 1 -- OS first, even when the path names a runtime or a server.
    ["C:\\xampp\\php\\php.ini", "windows"],
    ["C:\\inetpub\\wwwroot\\web.config", "windows"],
    ["\\xampp\\php\\php.ini", "windows"],
    ["/windows/win.ini", "windows"],
    ["//localhost/C$/Windows/system32/drivers/etc/hosts", "windows"],
    ["/Volumes/Macintosh_HD1/usr/local/php/lib/php.ini", "macos"],
    ["/Library/WebServer/Documents/index.php", "macos"],
    ["/opt/homebrew/etc/nginx/nginx.conf", "macos"],
    // Rule 2 -- runtime, then infrastructure, then distro.
    ["/etc/php/8.3/cli/php.ini", "language:php"],
    ["/.htaccess", "language:php"],
    ["/WEB-INF/web.xml", "language:java"],
    ["/etc/mono/2.0/web.config", "language:dotnet"],
    ["/root/.pypirc", "language:python"],
    ["/root/.npmrc", "language:node"],
    ["/config/database.yml", "language:ruby"],
    ["/etc/otrs/Kernel/Config.pm", "language:perl"],
    ["/etc/nginx/nginx.conf", "devops"],
    ["/usr/local/tomcat/conf/server.xml", "devops"],
    ["/run/secrets/kubernetes.io/serviceaccount/token", "devops"],
    ["/.mcp.json", "devops"],
    ["/root/.codex/auth.json", "devops"],
    ["/etc/passwd", "linux"],
    ["/proc/self/environ", "linux"],
    ["/root/.ssh/id_ed25519", "linux"],
    // A Linux target wearing Win32 noise is still a Linux target: the POSIX root
    // stops the SYNTACTIC windows tests, and both of these are in the corpus.
    [".\\\\./.\\\\./.\\\\./etc/passwd", "linux"],
    ["//etc/passwd", "linux"]
  ]

  for (const [value, expected] of cases) {
    test(`${value} -> ${expected}`, () => {
      const result = classifyTarget(value)
      const actual = result.category === "language"
        ? `language:${result.language}`
        : result.category
      expect(actual).toBe(expected)
    })
  }

  // The false positives that made the first version of the classifier wrong. An
  // extension has to be a real extension of the BASENAME, not a substring.
  test("an extension marker does not fire on a longer word", () => {
    expect(classifyTarget("/etc/cron.d/.placeholder").category).toBe("linux")
    expect(classifyTarget("/var/log/mail.warn").category).toBe("linux")
    expect(classifyTarget("/root/.continue/config.json").category).toBe("devops")
  })

  // macOS roots are anchored; unanchored they claim half of /etc.
  test("a macOS root only counts at the start of the path", () => {
    expect(classifyTarget("/etc/samba/private/smbpasswd").category).toBe("linux")
    expect(classifyTarget("/etc/selinux/mls/contexts/users/root").category).toBe("linux")
    expect(classifyTarget("/private/etc/master.passwd").category).toBe("macos")
  })
})

describe("separatorFamily", () => {
  test("a '\\' in any spelling is the backslash family", () => {
    for (
      const value of ["..\\", "..%5c", "..%255c", "..%25%5c", "..%c1%9c", "..%ef%bc%bc", "..0x5c", "..%u2216", "..%%35%63"]
    ) {
      expect(separatorFamily(value)).toBe("backslash")
    }
  })

  test("a '/'-only primitive is the slash family", () => {
    for (const value of ["../", "..%2f", "%2e%2e/", "..%c0%af", "..%ef%bc%8f", "..%u2215"]) {
      expect(separatorFamily(value)).toBe("slash")
    }
  })
})

/**
 * The five folders have to be a PARTITION, not five overlapping views: a value in
 * two folders is a payload generated twice and a line nobody can delete with
 * confidence. The harvest's own accounting table checks the counts; this checks
 * the shipped files.
 */
describe("the shipped templates are a partition", () => {
  const dimensions: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
    [
      "target",
      [
        "windows/target.txt",
        "macos/target.txt",
        "linux/target.txt",
        "devops/target.txt",
        "language/target-php.txt",
        "language/target-java.txt",
        "language/target-dotnet.txt",
        "language/target-python.txt",
        "language/target-node.txt",
        "language/target-ruby.txt",
        "language/target-perl.txt"
      ]
    ],
    [
      "traversal",
      ["windows/traversal.txt", "linux/traversal.txt", "language/traversal-java.txt"]
    ],
    ["prefix", ["windows/prefix.txt", "linux/prefix.txt", "devops/prefix.txt"]],
    ["suffix", ["windows/suffix.txt", "language/suffix.txt"]],
    ["raw", ["windows/raw.txt", "linux/raw.txt"]]
  ]

  for (const [dimension, files] of dimensions) {
    test(`no ${dimension} value appears in two files`, async () => {
      const seen = new Map<string, string>()
      const duplicated: Array<string> = []
      for (const file of files) {
        for (const value of await body(file)) {
          const first = seen.get(value)
          if (first !== undefined) duplicated.push(`${value} (${first} and ${file})`)
          else seen.set(value, file)
        }
      }
      expect(duplicated).toEqual([])
    })
  }

  test("every traversal file holds only its own separator family", async () => {
    for (const value of await body("windows/traversal.txt")) {
      expect(separatorFamily(value)).toBe("backslash")
    }
    for (const value of await body("linux/traversal.txt")) {
      expect(separatorFamily(value)).toBe("slash")
    }
  })

  test("each category's target file agrees with the classifier", async () => {
    // Curated sections are routed by the SECTION, not by the classifier, so only
    // the harvested block above the first '# ---' header is checked here.
    const harvested = async (relative: string): Promise<Array<string>> => {
      const raw = (await NodeFs.readFile(NodePath.join(TEMPLATES, relative), "utf8"))
        .split("\n")
      const firstSection = raw.findIndex((line) => line.startsWith("# --- "))
      return (firstSection < 0 ? raw : raw.slice(0, firstSection))
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !isCommentLine(line))
    }
    const expectations: ReadonlyArray<readonly [string, string]> = [
      ["windows/target.txt", "windows"],
      ["linux/target.txt", "linux"],
      ["devops/target.txt", "devops"],
      ["language/target-php.txt", "language:php"],
      ["language/target-java.txt", "language:java"]
    ]
    for (const [file, expected] of expectations) {
      const wrong: Array<string> = []
      for (const value of await harvested(file)) {
        const result = classifyTarget(value)
        const actual = result.category === "language"
          ? `language:${result.language}`
          : result.category
        if (actual !== expected) wrong.push(`${value} -> ${actual}`)
      }
      expect(wrong).toEqual([])
    }
  })
})
