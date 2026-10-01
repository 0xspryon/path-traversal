#!/usr/bin/env bun
/**
 * Verify the thing npm would actually publish.
 *
 * Packs the tarball, installs it globally into a throwaway prefix with plain
 * npm/node (no Bun in the loop), and drives the installed `pt` binary through a
 * real scaffold + generate.
 */
import { $ } from "bun"
import * as NodeFs from "node:fs/promises"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"

const root = NodePath.resolve(import.meta.dir, "..")
const expectations: Array<[string, boolean]> = []

const check = (label: string, ok: boolean) => {
  expectations.push([label, ok])
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`)
}

const temp = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "pt-pack-"))
const prefix = NodePath.join(temp, "prefix")
const sandbox = NodePath.join(temp, "sandbox")
await NodeFs.mkdir(prefix, { recursive: true })
await NodeFs.mkdir(sandbox, { recursive: true })

try {
  console.log("# building")
  await $`bun run build`.cwd(root)

  console.log("\n# npm pack")
  const packed = await $`npm pack --pack-destination ${temp}`.cwd(root).text()
  const tarball = NodePath.join(temp, packed.trim().split("\n").at(-1)!)
  console.log(`tarball: ${tarball}`)

  console.log("\n# tarball contents")
  const listing = await $`tar -tzf ${tarball}`.text()
  console.log(listing)
  check("tarball ships dist/pt.js", listing.includes("package/dist/pt.js"))
  check("tarball ships README.md", listing.includes("package/README.md"))
  check("tarball ships NOTES.md", listing.includes("package/NOTES.md"))
  check("tarball ships LICENSE", listing.includes("package/LICENSE"))
  check(
    "tarball ships the agent skill",
    listing.includes("package/skills/path-traversal/SKILL.md")
  )
  check(
    "tarball ships no sources or tests",
    !listing.includes("package/src/") && !listing.includes("package/test/")
  )

  console.log("\n# global install into a throwaway prefix")
  await $`npm install --global --prefix ${prefix} ${tarball}`.quiet()
  const pt = NodePath.join(prefix, "bin", "pt")
  check("installed a 'pt' binary", await NodeFs.stat(pt).then(() => true, () => false))

  console.log("\n# pt --version")
  const version = (await $`${pt} --version`.text()).trim()
  console.log(version)
  const expected = JSON.parse(
    await NodeFs.readFile(NodePath.join(root, "package.json"), "utf8")
  ).version
  check(`--version reports v${expected}`, version === `pt v${expected}`)

  console.log("\n# pt --generate-basic-config ./pt.yml")
  await $`${pt} --generate-basic-config ./pt.yml`.cwd(sandbox)

  console.log("\n# pt --config ./pt.yml --dry-run")
  // pt reports to stderr; the wordlist is the only thing that goes to a file.
  const dry = (await $`${pt} --config ./pt.yml --dry-run`.cwd(sandbox).quiet())
    .stderr.toString()
  console.log(dry.trim())
  const dryTotal = Number(
    /total unique\s+([\d,]+)/.exec(dry)?.[1]?.replaceAll(",", "") ?? "0"
  )
  check("--dry-run prints a per-strategy breakdown", dry.includes("plain"))
  check(
    "--dry-run has the order-independent 'unique' column",
    /payloads\s+new\s+unique/.test(dry)
  )
  check(
    "--dry-run attributes contribution to input LINES",
    /traversal\.txt:\d+/.test(dry) && dry.includes("inputs -- what each line")
  )
  check("--dry-run prints the raw ratio as a headline", /raw ratio\s+[\d.]+%/.test(dry))
  check(
    "piped, the report is plain text with no ANSI and no bars",
    !dry.includes("\u001b[") && !dry.includes("\u2588")
  )
  check(
    "--dry-run wrote nothing",
    !(await NodeFs.stat(NodePath.join(sandbox, "wordlist")).then(() => true, () => false))
  )

  console.log("\n# pt --config ./pt.yml")
  await $`${pt} --config ./pt.yml`.cwd(sandbox)

  const wordlist = await NodeFs.readFile(
    NodePath.join(sandbox, "wordlist", "pt_wordlist.txt"),
    "utf8"
  )
  const lines = wordlist.split("\n").slice(0, -1)
  console.log(`\n${lines.length} payloads generated`)
  console.log(`first 5:\n${lines.slice(0, 5).map((l) => `  ${l}`).join("\n")}`)

  check("generated a non-trivial wordlist", lines.length > 10_000)
  check("--dry-run total matched the real run", dryTotal === lines.length)
  check("deduped", new Set(lines).size === lines.length)
  check(
    "bare absolute target keeps its leading slash",
    lines.includes("/etc/passwd")
  )
  check(
    "protected suffix stayed literal while the traversal was encoded",
    lines.includes("%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd%00.png")
  )
  check("the '#.png' suffix was not eaten as a comment", lines.includes("/etc/passwd#.png"))
  for (
    const [label, payload] of [
      ["dot_noise", ".././.././.././etc/./passwd"],
      ["url_encode:1 > hex_case_upper", "%2E%2E%2F%2E%2E%2F%2E%2E%2Fetc%2Fpasswd"],
      ["url_encode:2", "%252e%252e%252f%252e%252e%252f%252e%252e%252fetc%252fpasswd"],
      ["overlong_utf8", "..%c0%af..%c0%af..%c0%afetc%c0%afpasswd"],
      ["selective_last", "../../../etc%2fpasswd"],
      ["base64", "Li4vLi4vLi4vZXRjL3Bhc3N3ZA=="],
      ["base64 > url_encode:1(charset=\"+/=\")", "Li4vLi4vLi4vZXRjL3Bhc3N3ZA%3d%3d"]
    ] as const
  ) {
    check(`strategy '${label}' is present`, lines.includes(payload))
  }

  check(
    "a '/' traversal still strips it, encoded or not",
    lines.includes("..%2f..%2f..%2fetc/passwd") &&
      !lines.includes("..%2f..%2f..%2f/etc/passwd")
  )

  // The five template folders, in the shipped artifact. The scaffolded config
  // reads linux + language + devops; windows and macos ship and are not read.
  check(
    "the scaffold wrote all five category folders",
    (await Promise.all(
      ["windows", "macos", "linux", "language", "devops"].map(async (category) =>
        (await NodeFs.readdir(NodePath.join(sandbox, "templates", category))).length > 0
      )
    )).every(Boolean)
  )
  check(
    "the default config reached a linux target",
    lines.includes("/etc/shadow")
  )
  check(
    "the default config reached a language target",
    lines.includes("/wp-config.php")
  )
  check(
    "the default config reached a devops target",
    lines.includes("/run/secrets/kubernetes.io/serviceaccount/token")
  )
  check(
    "windows and macos templates are NOT in the default output",
    !lines.includes("C:\\boot.ini") && !lines.includes("/Users/Shared/.DS_Store")
  )

  // The separator-identity rule, in the shipped artifact. The '\'-class
  // primitives live in templates/windows/traversal.txt now, so this exercises the
  // documented Windows switch at the same time.
  console.log("\n# pt --config ./windows.yml   (the documented Windows switch)")
  const windowsConfig = (await NodeFs.readFile(NodePath.join(sandbox, "pt.yml"), "utf8"))
    .replace(
      "files: [./templates/linux/traversal.txt]",
      "files: [./templates/windows/traversal.txt]"
    )
    .replace("output_file: ./wordlist/pt_wordlist.txt", "output_file: ./wordlist/win.txt")
  await NodeFs.writeFile(NodePath.join(sandbox, "windows.yml"), windowsConfig)
  await $`${pt} --config ./windows.yml`.cwd(sandbox).quiet()
  const winLines = new Set(
    (await NodeFs.readFile(NodePath.join(sandbox, "wordlist", "win.txt"), "utf8"))
      .split("\n")
  )
  check(
    "a '\\' traversal keeps the target's '/'",
    winLines.has("..\\..\\..\\/etc/passwd")
  )

  console.log("\n# pt add --config ./pt.yml --slot target --value /etc/krb5.keytab")
  const added = (await $`${pt} add --config ./pt.yml --slot target --value /etc/krb5.keytab`
    .cwd(sandbox)
    .quiet()).stderr.toString()
  console.log(added.trim())
  check("pt add reports what it wrote", /added\s+target/.test(added))
  check(
    "pt add appended to the slot file",
    (await NodeFs.readFile(
      NodePath.join(sandbox, "templates", "linux", "target.txt"),
      "utf8"
    )).includes("/etc/krb5.keytab")
  )

  console.log("\n# pt add (again -- idempotent)")
  const again = (await $`${pt} add --config ./pt.yml --slot target --value /etc/krb5.keytab`
    .cwd(sandbox)
    .quiet()).stderr.toString()
  console.log(again.trim())
  check("pt add is idempotent", again.includes("already present"))

  console.log("\n# pt add --decompose")
  const decomposed = (await $`${pt} add --config ./pt.yml --decompose ..%2f..%2f..%2fetc/krb5.conf`
    .cwd(sandbox)
    .quiet()).stderr.toString()
  console.log(decomposed.trim())
  check(
    "pt add --decompose splits across slots",
    /traversal\s+"\.\.%2f"/.test(decomposed) && /added\s+target/.test(decomposed)
  )

  console.log("\n# pt --help (installed)")
  console.log((await $`${pt} --help`.text()).trim())

  console.log("\n# pt --completions bash (installed, first 3 lines)")
  const completions = await $`${pt} --completions bash`.text()
  console.log(completions.split("\n").slice(0, 3).join("\n"))
  check("--completions bash emits a script", completions.length > 100)
} finally {
  await NodeFs.rm(temp, { recursive: true, force: true })
}

const failed = expectations.filter(([, ok]) => !ok)
console.log(
  `\n${expectations.length - failed.length}/${expectations.length} package checks passed`
)
if (failed.length > 0) {
  process.exitCode = 1
}
