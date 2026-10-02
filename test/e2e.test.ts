import { NodeServices } from "@effect/platform-node"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect, FileSystem } from "effect"
import * as NodeFs from "node:fs/promises"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import { parseConfig } from "../src/config.ts"
import { PtError } from "../src/errors.ts"
import { runAdd, runGenerate, runScaffold } from "../src/program.ts"

const run = <A>(effect: Effect.Effect<A, PtError, FileSystem.FileSystem>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)))

/** Run something expected to fail and hand back the PtError itself. */
const failure = <A>(effect: Effect.Effect<A, PtError, FileSystem.FileSystem>) =>
  Effect.runPromise(effect.pipe(Effect.flip, Effect.provide(NodeServices.layer)))

let dir: string
const yml = () => NodePath.join(dir, "pt.yml")

/** Copy the scaffolded config with substitutions, under a new name. */
// `from` may be a RegExp so a test can target a config KEY without pinning the
// seed's current VALUE -- pinning values couples every test to src/seed.ts and
// breaks the moment a default is retuned.
const variant = async (
  name: string,
  replacements: ReadonlyArray<readonly [string | RegExp, string]>
): Promise<string> => {
  const path = NodePath.join(dir, name)
  let source = await NodeFs.readFile(yml(), "utf8")
  for (const [from, to] of replacements) {
    if (typeof from === "string") expect(source).toContain(from)
    else expect(source).toMatch(from)
    source = source.replace(from, to)
  }
  await NodeFs.writeFile(path, source)
  return path
}

beforeAll(async () => {
  dir = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "pt-e2e-"))
})

afterAll(async () => {
  await NodeFs.rm(dir, { recursive: true, force: true })
})

describe("--generate-basic-config then --config", () => {
  let payloads: Array<string>
  let count: number

  test("scaffolds the config and the templates", async () => {
    const report = await run(runScaffold(yml()))
    expect(report.written.map((p) => NodePath.relative(dir, p)).sort()).toEqual([
      "pt.yml",
      "templates/devops/prefix.txt",
      "templates/devops/target.txt",
      "templates/language/suffix.txt",
      "templates/language/target-java.txt",
      "templates/language/target-php.txt",
      "templates/linux/prefix.txt",
      "templates/linux/raw.txt",
      "templates/linux/target.txt",
      "templates/linux/traversal.txt",
      "templates/macos/target.txt",
      "templates/target-padding.txt",
      "templates/windows/prefix.txt",
      "templates/windows/raw.txt",
      "templates/windows/suffix.txt",
      "templates/windows/target.txt",
      "templates/windows/traversal.txt"
    ])
  })

  // Task: the default config targets linux + language + devops. windows and macos
  // SHIP but are not read, because which folders you read is the recon-driven
  // decision the whole tool is about.
  test("the default config reads linux, language and devops -- and nothing else", async () => {
    const config = parseConfig(await NodeFs.readFile(yml(), "utf8"), dir, yml())
    const files = config.slots.flatMap((slot) => slot.files)
    expect(files.length).toBeGreaterThan(0)
    const categories = new Set(
      files.map((file) => NodePath.basename(NodePath.dirname(file)))
    )
    expect([...categories].sort()).toEqual(["devops", "language", "linux"])
    expect(files).toContain(
      NodePath.join(dir, "templates", "devops", "target.txt")
    )
    expect(files).toContain(
      NodePath.join(dir, "templates", "language", "target-php.txt")
    )
    expect(files).toContain(NodePath.join(dir, "templates", "linux", "target.txt"))
    for (const file of [...files, ...config.rawFiles]) {
      expect(await NodeFs.readFile(file, "utf8")).toBeTruthy()
    }
  })

  test("every slot file the default config names exists and holds members", async () => {
    const config = parseConfig(await NodeFs.readFile(yml(), "utf8"), dir, yml())
    for (const slot of config.slots) {
      const members = (
        await Promise.all(
          slot.files.map(async (file) =>
            (await NodeFs.readFile(file, "utf8"))
              .split("\n")
              .map((line) => line.trim())
              .filter((line) => line.length > 0 && !/^#(\s|#|$)/.test(line))
          )
        )
      ).flat()
      expect(members.length).toBeGreaterThan(0)
    }
  })

  test("windows and macos seeds ship, are valid, and are not in the config", async () => {
    const config = parseConfig(await NodeFs.readFile(yml(), "utf8"), dir, yml())
    const named = new Set(config.slots.flatMap((slot) => slot.files))
    for (
      const relative of [
        "templates/windows/target.txt",
        "templates/windows/traversal.txt",
        "templates/windows/prefix.txt",
        "templates/windows/suffix.txt",
        "templates/macos/target.txt"
      ]
    ) {
      const absolute = NodePath.join(dir, relative)
      expect(named.has(absolute)).toBe(false)
      const body = (await NodeFs.readFile(absolute, "utf8"))
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !/^#(\s|#|$)/.test(line))
      expect(body.length).toBeGreaterThan(0)
    }
    // ... and the config documents the switch rather than leaving it to be guessed.
    const source = await NodeFs.readFile(yml(), "utf8")
    expect(source).toContain("./templates/windows/traversal.txt")
    expect(source).toContain("./templates/macos/target.txt")
  })

  test("the scaffolded config is the new slot format", async () => {
    const source = await NodeFs.readFile(yml(), "utf8")
    expect(source).toContain("slots:")
    expect(source).toContain("- name: target")
    expect(source).toContain("strip_leading_separator: when_same_separator")
    // and none of the keys it replaced
    for (
      const gone of [
        "prefix_file:",
        "traversal_file:",
        "target_file:",
        "suffix_file:",
        "traversal_depth:",
        "do_not_transform:",
        "include_payloads_without"
      ]
    ) {
      expect(source).not.toContain(gone)
    }
  })

  test("the scaffolded config keeps its explanatory comments and strategy catalog", async () => {
    const source = await NodeFs.readFile(yml(), "utf8")
    expect(source).toContain("An ordered UNION of pipelines -- NOT a cross-product")
    expect(source).toContain("available, off by default")
    for (
      const commented of [
        "# - url_encode:3",
        "# - overlong_utf8(+dots)",
        "# - double_slash",
        "# - backtrack",
        "# - matrix_param",
        "# - selective_first",
        "# - selective_alternating",
        "# - path_case_upper",
        "# - trailing_dot",
        "# - trailing_space"
      ]
    ) {
      expect(source).toContain(commented)
    }
  })

  test("generates a wordlist from the scaffolded config", async () => {
    const report = await run(runGenerate(yml(), { dryRun: false }))
    count = report.count
    expect(count).toBeGreaterThan(10_000)
    const contents = await NodeFs.readFile(report.outputFile, "utf8")
    payloads = contents.split("\n").slice(0, -1)
    expect(payloads).toHaveLength(count)
  })

  test("no '.part' file is left behind", async () => {
    await expect(
      NodeFs.stat(NodePath.join(dir, "wordlist", "pt_wordlist.txt.part"))
    ).rejects.toThrow()
  })

  test("every default strategy is represented in the output", () => {
    const witnesses: ReadonlyArray<readonly [string, string]> = [
      ["plain", "/etc/passwd"],
      ["dot_noise", ".././.././.././etc/./passwd"],
      ["url_encode:1", "%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd"],
      ["url_encode:1 > hex_case_upper", "%2E%2E%2F%2E%2E%2F%2E%2E%2Fetc%2Fpasswd"],
      ["url_encode:2", "%252e%252e%252f%252e%252e%252f%252e%252e%252fetc%252fpasswd"],
      ["overlong_utf8", "..%c0%af..%c0%af..%c0%afetc%c0%afpasswd"],
      [
        "fullwidth",
        "%ef%bc%8e%ef%bc%8e%ef%bc%8f%ef%bc%8e%ef%bc%8e%ef%bc%8f%ef%bc%8e%ef%bc%8e%ef%bc%8fetc%ef%bc%8fpasswd"
      ],
      ["selective_last", "../../../etc%2fpasswd"],
      ["base64", "Li4vLi4vLi4vZXRjL3Bhc3N3ZA=="],
      ["base64 > url_encode:1 (charset +/=)", "Li4vLi4vLi4vZXRjL3Bhc3N3ZA%3d%3d"]
    ]
    const missing = witnesses.filter(([, payload]) => !payloads.includes(payload))
    expect(missing.map(([name]) => name)).toEqual([])
  })

  test("the output is deduped", () => {
    expect(new Set(payloads).size).toBe(payloads.length)
  })

  test("bare absolute targets keep their leading slash", () => {
    expect(payloads).toContain("/etc/passwd")
    expect(payloads).toContain("/root/.ssh/id_ed25519")
  })

  // The separator-identity rule, end to end against the shipped seeds. The '\\'
  // primitives live in templates/windows/ now, so this exercises the documented
  // Windows switch at the same time.
  test("a '\\\\' traversal keeps the target's '/' -- v1 destroyed this payload", async () => {
    const path = await variant("windows.yml", [
      [
        "files: [./templates/linux/traversal.txt]",
        "files: [./templates/windows/traversal.txt]"
      ],
      ["output_file: ./wordlist/pt_wordlist.txt", "output_file: ./wordlist/windows.txt"]
    ])
    const report = await run(runGenerate(path, { dryRun: false }))
    const lines = (await NodeFs.readFile(report.outputFile, "utf8")).split("\n")
    expect(lines).toContain("..\\..\\..\\/etc/passwd")
    expect(lines).toContain("..%5c..%5c..%5c/etc/passwd")
  })

  test("a '/' traversal still strips it, encoded or not", () => {
    expect(payloads).toContain("../../../etc/passwd")
    expect(payloads).toContain("..%2f..%2f..%2fetc/passwd")
    expect(payloads).not.toContain("..%2f..%2f..%2f/etc/passwd")
  })

  test("the raw entry is emitted verbatim and leads the file", () => {
    // The default config reads linux + language + devops, so the verbatim entry
    // that leads the file comes from templates/linux/raw.txt. The windows one is
    // scaffolded alongside but not read until you switch.
    expect(payloads[0]).toBe("./.././.././..//etc/passwd")
  })

  test("the '#.png' suffix survived the comment filter", () => {
    expect(payloads).toContain("/etc/passwd#.png")
  })

  test("a 'transform: false' slot stays literal while the traversal is rewritten", () => {
    expect(payloads).toContain("%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd%00.png")
    expect(payloads).toContain("..%c0%af..%c0%af..%c0%afetc%c0%afpasswd%00.png")
    expect(payloads).toContain("Li4vLi4vLi4vZXRjL3Bhc3N3ZA==%00.png")
  })

  test("the plain block is exactly the leading prefix of the file", () => {
    // Strategies are the outermost loop and ordered by priority, so a run with
    // only the first strategy must reproduce the head of the full run.
    const plainOnly = payloads.slice(0, payloads.indexOf("/etc/passwd#.png") + 1)
    expect(plainOnly.every((p) => !p.includes("%2e") && !p.includes("%252e"))).toBe(
      true
    )
  })

  test("refuses to clobber the output when overwrite_output_file is false", async () => {
    const path = await variant("no-overwrite.yml", [
      ["overwrite_output_file: true", "overwrite_output_file: false"]
    ])
    const error = await failure(runGenerate(path, { dryRun: false }))
    expect(error).toBeInstanceOf(PtError)
    expect(error.message).toMatch(/already exists/)
  })

  test("--dry-run writes nothing and its total matches a real run", async () => {
    const path = await variant("dry.yml", [
      ["output_file: ./wordlist/pt_wordlist.txt", "output_file: ./wordlist/dry.txt"]
    ])
    const report = await run(runGenerate(path, { dryRun: true }))
    expect(report.dryRun).toBe(true)
    expect(report.count).toBe(count)
    await expect(NodeFs.stat(report.outputFile)).rejects.toThrow()
  })
})

// §6 + §8: what the report has to say.
describe("the contribution report", () => {
  let breakdown: string

  beforeAll(async () => {
    breakdown = (await run(runGenerate(yml(), { dryRun: true }))).breakdown
  })

  test("names every strategy and the passthrough", () => {
    expect(breakdown).toContain("raw_file (verbatim)")
    for (
      const label of [
        "plain",
        "dot_noise",
        "url_encode:1 > hex_case_upper",
        "base64 > url_encode:1"
      ]
    ) {
      expect(breakdown).toContain(label)
    }
    expect(breakdown).toMatch(/\(\+[\d,]+\)/)
    expect(breakdown).toContain("total unique")
  })

  test("has both an order-dependent and an order-independent column", () => {
    expect(breakdown).toMatch(/payloads\s+new\s+unique/)
    expect(breakdown).toContain("'unique' is against the union of all the others")
  })

  test("attributes contribution to input LINES, with file and line number", () => {
    expect(breakdown).toContain("inputs -- what each line of each slot file is worth")
    expect(breakdown).toMatch(/traversal\.txt:\d+\s+\.\.%2f/)
    expect(breakdown).toMatch(/target\.txt:\d+\s+\/\.dockerenv/)
    expect(breakdown).toMatch(/input lines are/)
  })

  test("prints the raw ratio as a headline figure, not a table row", () => {
    expect(breakdown).toMatch(/raw ratio\s+[\d.]+%/)
    expect(breakdown).toContain("reachable ONLY verbatim")
    expect(breakdown).toContain("generated payloads")
  })

  test("piped, there are no bars and no ANSI escapes", () => {
    expect(breakdown).not.toContain("\u001b[")
    expect(breakdown).not.toContain("█")
  })

  test("on a TTY, there are bars and colour", async () => {
    const rich = await run(
      runGenerate(yml(), {
        dryRun: true,
        style: { rich: true, barWidth: 20, maxInputs: 10 }
      })
    )
    expect(rich.breakdown).toContain("█")
    expect(rich.breakdown).toContain("\u001b[36m")
    // Same numbers either way.
    expect(rich.breakdown.replace(/\u001b\[\d+m/g, "").replace(/[█▏-▟]/g, ""))
      .toContain("total unique")
  })
})

describe("limits", () => {
  test("warn_above adds a warning without failing", async () => {
    const path = await variant("warn.yml", [[/warn_above: \d+/, "warn_above: 10"]])
    const report = await run(runGenerate(path, { dryRun: true }))
    expect(report.warning).toMatch(/exceeds 'limits.warn_above' \(10\)/)
  })

  test("max_payloads stops with a clear message and the breakdown so far", async () => {
    const path = await variant("cap.yml", [[/max_payloads: \d+/, "max_payloads: 100"]])
    const error = await failure(runGenerate(path, { dryRun: true }))
    expect(error.message).toMatch(/more than 100 unique payloads/)
    expect(error.message).toMatch(/'limits.max_payloads'/)
    expect(error.message).toMatch(/Breakdown up to the stop point/)
  })

  test("max_payloads also stops a real run before anything is written", async () => {
    const path = await variant("cap-write.yml", [
      [/max_payloads: \d+/, "max_payloads: 100"],
      ["output_file: ./wordlist/pt_wordlist.txt", "output_file: ./wordlist/capped.txt"]
    ])
    const error = await failure(runGenerate(path, { dryRun: false }))
    expect(error.message).toMatch(/more than 100 unique payloads/)
    // Neither the output nor the partial file survives a stopped run.
    await expect(
      NodeFs.stat(NodePath.join(dir, "wordlist", "capped.txt"))
    ).rejects.toThrow()
    await expect(
      NodeFs.stat(NodePath.join(dir, "wordlist", "capped.txt.part"))
    ).rejects.toThrow()
  })
})

describe("per-strategy slot overrides end to end", () => {
  test("padding uses its own target slot and repeat ladder", async () => {
    const path = NodePath.join(dir, "padding.yml")
    await NodeFs.writeFile(
      path,
      `slots:
  - name: traversal
    files: [./templates/linux/traversal.txt]
    optional: true
    repeat: [3, 6]
  - name: target
    files: [./templates/linux/target.txt]
strategies:
  - "padding:4 | target=./templates/target-padding.txt, traversal.repeat=3"
output_file: ./wordlist/padding.txt
overwrite_output_file: true
`
    )
    const report = await run(runGenerate(path, { dryRun: false }))
    const lines = (await NodeFs.readFile(report.outputFile, "utf8"))
      .split("\n")
      .slice(0, -1)
    // target-padding.txt holds 3 targets; linux/target.txt's others must not appear.
    expect(lines.some((line) => line.includes("etc/passwd"))).toBe(true)
    expect(lines.some((line) => line.includes("id_ed25519"))).toBe(false)
    // repeat 3 only, never 6.
    expect(lines).toContain("././././../../../etc/passwd")
    expect(lines.some((line) => line.includes("../../../../../../etc"))).toBe(false)
  })

  test("a slot named by nothing but a strategy override is still a declared slot", async () => {
    const path = NodePath.join(dir, "two-traversals.yml")
    await NodeFs.writeFile(
      path,
      `slots:
  - { name: traversal_posix, files: [./posix.txt], optional: true, repeat: [3] }
  - { name: traversal_win32, files: [./win32.txt], optional: true, repeat: [2] }
  - { name: target, files: [./templates/linux/target.txt] }
strategies:
  - plain
output_file: ./wordlist/two.txt
overwrite_output_file: true
`
    )
    await NodeFs.writeFile(NodePath.join(dir, "posix.txt"), "../\n")
    await NodeFs.writeFile(NodePath.join(dir, "win32.txt"), "..\\\n")
    const report = await run(runGenerate(path, { dryRun: false }))
    const lines = (await NodeFs.readFile(report.outputFile, "utf8")).split("\n")
    // Two traversal slots at once -- v1 could not express this at all.
    expect(lines).toContain("../../../..\\..\\/etc/passwd")
  })
})

// §2: the per-line '!' escape, end to end.
describe("the per-line '!' escape", () => {
  test("protects one line of an otherwise transformable slot", async () => {
    const path = NodePath.join(dir, "escape.yml")
    await NodeFs.writeFile(NodePath.join(dir, "escape-target.txt"), "/etc/passwd\n!/pre%2fencoded\n")
    await NodeFs.writeFile(
      path,
      `slots:
  - { name: target, files: [./escape-target.txt] }
strategies:
  - url_encode:1
output_file: ./wordlist/escape.txt
overwrite_output_file: true
`
    )
    const report = await run(runGenerate(path, { dryRun: false }))
    const lines = (await NodeFs.readFile(report.outputFile, "utf8")).split("\n")
    expect(lines).toContain("%2fetc%2fpasswd")
    expect(lines).toContain("/pre%2fencoded")
  })
})

describe("missing input files fail loudly", () => {
  test("a slot file that does not exist", async () => {
    const path = NodePath.join(dir, "missing.yml")
    await NodeFs.writeFile(
      path,
      `slots:
  - { name: prefix, files: [./templates/nope.txt], optional: true }
  - { name: target, files: [./templates/linux/target.txt] }
output_file: ./out/missing.txt
`
    )
    const error = await failure(runGenerate(path, { dryRun: false }))
    expect(error.message).toMatch(/cannot read slot 'prefix'/)
  })

  test("a strategy override file that does not exist", async () => {
    const path = NodePath.join(dir, "missing-override.yml")
    await NodeFs.writeFile(
      path,
      `slots:
  - { name: target, files: [./templates/linux/target.txt] }
strategies:
  - "plain | target=./templates/nope.txt"
output_file: ./out/missing2.txt
`
    )
    const error = await failure(runGenerate(path, { dryRun: false }))
    expect(error.message).toMatch(/slot 'target' override for strategy 'plain'/)
  })

  test("a required slot whose file contains only comments", async () => {
    const path = NodePath.join(dir, "empty-target.yml")
    await NodeFs.writeFile(NodePath.join(dir, "empty.txt"), "# nothing here\n")
    await NodeFs.writeFile(
      path,
      `slots:
  - { name: target, files: [./empty.txt] }
output_file: ./out/empty.txt
`
    )
    const error = await failure(runGenerate(path, { dryRun: false }))
    expect(error.message).toMatch(/slot 'target' is required but loaded no members/)
  })
})

// The `pt add` surface.
describe("pt add", () => {
  let addDir: string
  const addYml = () => NodePath.join(addDir, "pt.yml")
  const read = (relative: string) =>
    NodeFs.readFile(NodePath.join(addDir, relative), "utf8")

  beforeAll(async () => {
    addDir = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "pt-add-"))
    await run(runScaffold(addYml()))
  })

  afterAll(async () => {
    await NodeFs.rm(addDir, { recursive: true, force: true })
  })

  const add = (request: Partial<Parameters<typeof runAdd>[1]>) =>
    run(runAdd(addYml(), { slots: [], raw: [], decompose: [], ...request }))

  test("--slot/--value appends to that slot's file", async () => {
    const before = await read("templates/linux/traversal.txt")
    const report = await add({ slots: [{ slot: "traversal", value: "..%c0%af/" }] })
    expect(report.actions).toHaveLength(1)
    expect(report.actions[0]!.outcome).toBe("added")
    expect(report.actions[0]!.target).toBe("traversal")
    expect(report.actions[0]!.file).toBe(
      NodePath.join(addDir, "templates", "linux", "traversal.txt")
    )
    const after = await read("templates/linux/traversal.txt")
    expect(after).toBe(`${before}..%c0%af/\n`)
  })

  test("is idempotent: a value already present is reported and not rewritten", async () => {
    const before = await read("templates/linux/traversal.txt")
    const report = await add({ slots: [{ slot: "traversal", value: "..%c0%af/" }] })
    expect(report.actions[0]!.outcome).toBe("already-present")
    expect(await read("templates/linux/traversal.txt")).toBe(before)
  })

  test("a value the scaffold already shipped is a no-op too", async () => {
    const before = await read("templates/linux/target.txt")
    const report = await add({ slots: [{ slot: "target", value: "/etc/passwd" }] })
    expect(report.actions[0]!.outcome).toBe("already-present")
    expect(await read("templates/linux/target.txt")).toBe(before)
  })

  test("several --slot/--value pairs in one call", async () => {
    const report = await add({
      slots: [
        { slot: "target", value: "/etc/krb5.keytab" },
        { slot: "suffix", value: "%00.gif" }
      ]
    })
    expect(report.actions.map((a) => a.outcome)).toEqual(["added", "added"])
    expect(await read("templates/linux/target.txt")).toContain("/etc/krb5.keytab")
    expect(await read("templates/language/suffix.txt")).toContain("%00.gif")
  })

  test("--raw appends verbatim", async () => {
    const report = await add({ raw: ["..%25%5c..%25%5c..%255cboot.ini"] })
    expect(report.actions[0]!.target).toBe("raw_file")
    expect(await read("templates/linux/raw.txt")).toContain("..%25%5c..%25%5c..%255cboot.ini")
  })

  test("--decompose splits a payload across slots", async () => {
    const report = await add({
      decompose: ["/var/www/html/../../../etc/shadow%00.png"]
    })
    expect(report.actions.map((a) => [a.target, a.value])).toEqual([
      ["prefix", "/var/www/html/"],
      ["traversal", "../"],
      ["target", "/etc/shadow"],
      ["suffix", "%00.png"]
    ])
    // Every part was already in the scaffold except the target.
    expect(await read("templates/linux/target.txt")).toContain("/etc/shadow")
  })

  test("--decompose routes an ungeneratable payload to raw_file and says why", async () => {
    const report = await add({ decompose: ["..%25%5c..%25%5c..%255cwin.ini"] })
    expect(report.actions).toHaveLength(1)
    expect(report.actions[0]!.outcome).toBe("routed-to-raw")
    expect(report.actions[0]!.target).toBe("raw_file")
    expect(report.actions[0]!.why).toMatch(/breaks at the last step/)
    expect(await read("templates/linux/raw.txt")).toContain("..%25%5c..%25%5c..%255cwin.ini")
  })

  test("--decompose keeps a '\\\\' traversal's target separator, as assemble does", async () => {
    const report = await add({ decompose: ["..\\..\\..\\/etc/group"] })
    expect(report.actions.map((a) => [a.target, a.value])).toEqual([
      ["traversal", "..\\"],
      ["target", "/etc/group"]
    ])
  })

  test("the comment header and the existing lines are never touched", async () => {
    const contents = await read("templates/linux/target.txt")
    expect(
      contents.startsWith("# Linux and UNIX targets: the files worth reading")
    ).toBe(true)
    const lines = contents.split("\n").filter((l) => l.length > 0 && !l.startsWith("#"))
    // The scaffold's first payload is still the first payload.
    expect(lines[0]).toBe("/etc/passwd")
  })

  test("everything added is generated on the next run", async () => {
    const report = await run(runGenerate(addYml(), { dryRun: false }))
    const lines = new Set(
      (await NodeFs.readFile(report.outputFile, "utf8")).split("\n")
    )
    expect(lines.has("/etc/krb5.keytab")).toBe(true)
    expect(lines.has("..%c0%af/..%c0%af/..%c0%af/etc/shadow%00.gif")).toBe(true)
    expect(lines.has("..%25%5c..%25%5c..%255cwin.ini")).toBe(true)
  })

  test("an unknown slot name is an error that lists the real ones", async () => {
    const error = await failure(
      runAdd(addYml(), {
        slots: [{ slot: "traversals", value: "x" }],
        raw: [],
        decompose: []
      })
    )
    expect(error.message).toMatch(/no slot named 'traversals'/)
    expect(error.message).toMatch(/prefix, traversal, target, suffix/)
  })

  test("a config with no raw_file says so rather than inventing one", async () => {
    const path = NodePath.join(addDir, "no-raw.yml")
    await NodeFs.writeFile(
      path,
      `slots:
  - { name: target, files: [./templates/target.txt] }
output_file: ./out.txt
`
    )
    const error = await failure(
      runAdd(path, { slots: [], raw: ["whatever"], decompose: [] })
    )
    expect(error.message).toMatch(/has no 'raw_file'/)
  })
})

describe("scaffold is non-destructive", () => {
  test("an existing template is kept, not overwritten by the seed", async () => {
    // Regression: a clone of the repo holds a harvested corpus at the same paths
    // the seed writes. Scaffolding there used to replace linux/target.txt's 8,505
    // lines with the seed's 15, destroying work the user never asked us to touch.
    const home = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "pt-keep-"))
    const corpus = NodePath.join(home, "templates", "linux", "target.txt")
    await NodeFs.mkdir(NodePath.dirname(corpus), { recursive: true })
    const mine = "# my corpus\n/etc/passwd\n/etc/shadow\n/srv/secret\n"
    await NodeFs.writeFile(corpus, mine)

    const report = await run(runScaffold(NodePath.join(home, "pt.yml")))

    expect(await NodeFs.readFile(corpus, "utf8")).toBe(mine)
    expect(report.skipped).toContain(corpus)
    expect(report.written).not.toContain(corpus)
    // Everything else still gets scaffolded.
    expect(report.written.length).toBeGreaterThan(5)
    await NodeFs.rm(home, { recursive: true, force: true })
  })
})
