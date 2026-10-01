#!/usr/bin/env bun
/**
 * Does pt's output semantically cover the public LFI wordlists?
 *
 *   bun run scripts/coverage-check.ts [--config pt-full.yml] [--strict]
 *
 * Reads the reference corpus (written by `harvest-wordlists.ts`) and a generated
 * wordlist, reduces both to canonical keys, and reports which keys the reference
 * has that pt does not produce.
 *
 * ## The canonical key is a PAIR: (resolved target, technique class)
 *
 * **Depth collapses into the target.** `cd ..` from `/` is `/` on POSIX, and
 * Windows clamps identically, so `../../../../../../etc/passwd` and
 * `../../../etc/passwd` are the same request. Overshooting is free, so any depth
 * covers any shallower one, and depth must not appear in the key.
 *
 * **Encoding completeness does NOT collapse, and this is the whole point.** A
 * checker that fully decodes each payload maps every variant onto `/etc/passwd`
 * and then "proves" total coverage while hiding every real gap. Partial and full
 * encoding are SIBLINGS, not a subset relation -- they trip different filter
 * signatures:
 *
 * ```
 * payload                               literal..  %2e  %2e%2e  %2f   len
 * ../../../etc/passwd                   MATCH      -    -       -      19
 * ../../../etc%2fpasswd  (partial sep)  MATCH      -    -       MATCH  25
 * %2e%2e/%2e%2e/etc/passwd (part dots)  -          YES  YES     -      31
 * %2e%2e%2f%2e%2e%2fetc%2fpasswd (full) -          YES  YES     MATCH  39
 * ```
 *
 * Full encoding trips every signature; each partial form trips a strict subset.
 * So "pt emits the fully-encoded form" does NOT cover "the reference list has a
 * partially-encoded form". Classes therefore come from `primaryClass()` and
 * `featureClasses()`, which inspect literal bytes and never decode.
 */
import * as fs from "node:fs/promises"
import * as path from "node:path"
import {
  ALL_CLASSES,
  canonicalTarget,
  classesOf,
  FEATURE_CLASSES,
  PRIMARY_CLASSES,
  rejectReason,
  type PayloadClass
} from "../src/core/index.ts"

const SEP = "\u0000"
const key = (klass: PayloadClass, target: string): string => `${klass}${SEP}${target}`

interface Index {
  /** class -> set of resolved targets seen with that class. */
  readonly byClass: Map<PayloadClass, Set<string>>
  readonly pairs: Set<string>
  /** One worked example per pair, for the gap report. */
  readonly example: Map<string, string>
  lines: number
}

const emptyIndex = (): Index => ({
  byClass: new Map(),
  pairs: new Set(),
  example: new Map(),
  lines: 0
})

const index = (payloads: Iterable<string>, skipCorrupt: boolean): Index => {
  const out = emptyIndex()
  for (const payload of payloads) {
    if (payload.length === 0) continue
    if (skipCorrupt && rejectReason(payload) !== undefined) continue
    out.lines += 1
    const target = canonicalTarget(payload)
    for (const klass of classesOf(payload)) {
      const k = key(klass, target)
      out.pairs.add(k)
      if (!out.example.has(k)) out.example.set(k, payload)
      let bucket = out.byClass.get(klass)
      if (bucket === undefined) {
        bucket = new Set()
        out.byClass.set(klass, bucket)
      }
      bucket.add(target)
    }
  }
  return out
}

const readLines = async (file: string): Promise<Array<string>> =>
  (await fs.readFile(file, "utf8"))
    .split(/\r?\n/)
    .map((line) => line.replace(/\r/g, ""))
    .filter((line) => line.length > 0)

/** Input-file lines, minus pt's comment convention. */
const readTemplate = async (file: string): Promise<Array<string>> =>
  (await readLines(file)).filter((line) => {
    const trimmed = line.trim()
    if (trimmed.length === 0 || !trimmed.startsWith("#")) return true
    const next = trimmed[1]
    return !(next === undefined || next === "#" || next === " " || next === "\t")
  })

const bar = (covered: number, total: number, width = 18): string => {
  if (total === 0) return " ".repeat(width)
  const filled = Math.round((covered / total) * width)
  return "#".repeat(filled) + "-".repeat(width - filled)
}

const pct = (covered: number, total: number): string =>
  total === 0 ? "   -  " : `${((covered / total) * 100).toFixed(1).padStart(5)}%`

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2)
  const strict = argv.includes("--strict")
  const repoRoot = path.resolve(import.meta.dirname, "..")
  const flag = (name: string, fallback: string): string => {
    const at = argv.indexOf(`--${name}`)
    return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1]! : fallback
  }
  const referenceFile = path.resolve(repoRoot, flag("reference", ".cache/wordlists/reference-corpus.txt"))
  const wordlistFile = path.resolve(repoRoot, flag("wordlist", "wordlist/pt_full_wordlist.txt"))
  // The verbatim passthrough, split by separator family like every other
  // dimension. `--raw` may be repeated to point the checker somewhere else.
  const rawFiles = argv.reduce<Array<string>>((files, arg, at) => {
    if (arg === "--raw" && argv[at + 1] !== undefined) files.push(argv[at + 1]!)
    return files
  }, [])
  const rawPaths = (rawFiles.length > 0
    ? rawFiles
    : ["templates/windows/raw.txt", "templates/linux/raw.txt"]).map((file) =>
      path.resolve(repoRoot, file)
    )

  const referenceLines = await readLines(referenceFile)
  const wordlistLines = await readLines(wordlistFile)
  const rawLines = new Set(
    (await Promise.all(rawPaths.map(readTemplate))).flat()
  )

  // Corrupt reference lines are excluded: '..2f..2f..2fetc2fpasswd' is a
  // filename containing the characters '2f', not a traversal in any encoding, and
  // holding pt responsible for reproducing a published typo would be noise.
  const reference = index(referenceLines, true)
  const pt = index(wordlistLines, false)
  // The same index minus the verbatim passthrough, which is what answers "how
  // much does the GENERATOR cover" as opposed to "what is in the file".
  const generated = index(
    wordlistLines.filter((line) => !rawLines.has(line)),
    false
  )

  const line = (text = "") => process.stdout.write(`${text}\n`)
  const H = "".padEnd(96, "=")

  line(H)
  line("pt coverage against the public LFI corpus")
  line(H)
  line(`reference corpus   ${referenceFile}`)
  line(`                   ${referenceLines.length} lines, ${reference.lines} usable (corrupt lines skipped)`)
  line(`pt wordlist        ${wordlistFile}`)
  line(`                   ${pt.lines} payloads, of which ${pt.lines - generated.lines} verbatim from raw_file`)
  line()
  line(`canonical key      (resolved target, technique class)`)
  line(`                   depth COLLAPSES into the target -- '..' at '/' is '/'`)
  line(`                   encoding does NOT collapse -- partial and full are siblings`)
  line()
  line(`reference pairs     ${reference.pairs.size}`)
  line(`pt pairs            ${pt.pairs.size}`)
  line()

  // ------------------------------------------------------------------ table
  line(H)
  line("COVERAGE BY TECHNIQUE CLASS")
  line(H)
  line(
    `${"class".padEnd(22)}${"ref".padStart(7)}${"covered".padStart(9)}${"gap".padStart(6)}  ${
      "".padEnd(18)
    }  pct`
  )
  line("".padEnd(96, "-"))

  interface Row {
    readonly klass: PayloadClass
    readonly demanded: number
    readonly covered: number
    readonly gaps: Array<string>
  }
  const rows: Array<Row> = []
  for (const klass of ALL_CLASSES) {
    const demanded = reference.byClass.get(klass) ?? new Set<string>()
    const gaps: Array<string> = []
    let covered = 0
    for (const target of demanded) {
      if (pt.pairs.has(key(klass, target))) covered += 1
      else gaps.push(target)
    }
    rows.push({ klass, demanded: demanded.size, covered, gaps })
  }

  const section = (title: string, which: ReadonlyArray<PayloadClass>) => {
    line(`-- ${title} ${"".padEnd(Math.max(0, 92 - title.length), "-")}`)
    for (const row of rows.filter((r) => which.includes(r.klass))) {
      line(
        `${row.klass.padEnd(22)}${String(row.demanded).padStart(7)}${
          String(row.covered).padStart(9)
        }${String(row.gaps.length).padStart(6)}  ${bar(row.covered, row.demanded)}  ${
          pct(row.covered, row.demanded)
        }`
      )
    }
  }
  section("primary spelling (mutually exclusive)", PRIMARY_CLASSES)
  section("orthogonal features", FEATURE_CLASSES)

  const totalDemanded = rows.reduce((sum, row) => sum + row.demanded, 0)
  const totalCovered = rows.reduce((sum, row) => sum + row.covered, 0)
  line("".padEnd(96, "-"))
  line(
    `${"TOTAL".padEnd(22)}${String(totalDemanded).padStart(7)}${
      String(totalCovered).padStart(9)
    }${String(totalDemanded - totalCovered).padStart(6)}  ${
      bar(totalCovered, totalDemanded)
    }  ${pct(totalCovered, totalDemanded)}`
  )
  line()

  // ------------------------------------------------------------------- gaps
  line(H)
  line("GAPS -- reference (target, class) pairs pt does not produce")
  line(H)
  const withGaps = rows.filter((row) => row.gaps.length > 0)
  if (withGaps.length === 0) {
    line("none.")
  }
  for (const row of withGaps.sort((a, b) => b.gaps.length - a.gaps.length)) {
    line(`\n${row.klass}  (${row.gaps.length} of ${row.demanded} targets uncovered)`)
    for (const target of row.gaps.slice(0, 12)) {
      const example = reference.example.get(key(row.klass, target))
      line(`    ${target}`)
      line(`        reference: ${example}`)
    }
    if (row.gaps.length > 12) line(`    ... and ${row.gaps.length - 12} more`)
  }
  line()

  // ------------------------------------------------- what the generator adds
  line(H)
  line("INVERSE -- classes pt produces that the reference corpus does not")
  line(H)
  line(`${"class".padEnd(22)}${"pt".padStart(8)}${"ref".padStart(8)}   verdict`)
  line("".padEnd(96, "-"))
  for (const klass of ALL_CLASSES) {
    const mine = pt.byClass.get(klass)?.size ?? 0
    const theirs = reference.byClass.get(klass)?.size ?? 0
    if (mine === 0) continue
    const verdict = theirs === 0
      ? "NEW -- no reference list contains this technique"
      : mine > theirs
      ? `wider: ${mine - theirs} more targets than the corpus reaches`
      : "within corpus"
    line(`${klass.padEnd(22)}${String(mine).padStart(8)}${String(theirs).padStart(8)}   ${verdict}`)
  }
  line()

  // --------------------------------------------- raw_file: model incompleteness
  line(H)
  line("raw_file -- how much of the corpus the GENERATIVE model does not reach")
  line(H)
  let rawCoveredByGenerator = 0
  const rawUncovered: Array<string> = []
  for (const entry of rawLines) {
    const target = canonicalTarget(entry)
    const covered = classesOf(entry).every((klass) =>
      generated.pairs.has(key(klass, target))
    )
    if (covered) rawCoveredByGenerator += 1
    else rawUncovered.push(entry)
  }
  line(`raw_file entries                                    ${rawLines.size}`)
  line(
    `  whose (target, class) pairs the GENERATOR also makes  ${rawCoveredByGenerator}  ${
      pct(rawCoveredByGenerator, rawLines.size)
    }`
  )
  line(`  genuinely only reachable verbatim                   ${rawUncovered.length}`)
  line()
  line("A raw entry counts as 'also generated' when every class it belongs to is")
  line("produced for the same resolved target WITHOUT the passthrough. Those lines")
  line("are shapes the strategy layer reaches even though no traversal x depth does")
  line("-- noise:dot and selective:first, mostly. So the passthrough is an upper bound")
  line("on what the model misses, and this number is how loose that bound is.")
  for (const entry of rawUncovered.slice(0, 8)) line(`    ${entry}`)
  if (rawUncovered.length > 8) line(`    ... and ${rawUncovered.length - 8} more`)
  line()

  if (strict && totalCovered < totalDemanded) {
    process.stderr.write(
      `coverage-check: ${totalDemanded - totalCovered} uncovered pairs (--strict)\n`
    )
    process.exit(1)
  }
}

await main()
