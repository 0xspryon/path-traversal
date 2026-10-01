#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, Effect, Option } from "effect"
import { Command, Flag } from "effect/cli"
import { formatError, PtError } from "./errors.ts"
import { runAdd, runGenerate, runScaffold } from "./program.ts"
import { styleFor } from "./report.ts"
import { VERSION } from "./version.ts"

/**
 * The report is written to stderr and payloads to stdout / the output file, so
 * `pt --config x --dry-run | less` and `2>report.txt` both have to come out as
 * plain aligned text. Bars and colour therefore need BOTH streams to be a
 * terminal.
 */
const reportStyle = () =>
  styleFor({
    stdoutIsTty: process.stdout.isTTY,
    stderrIsTty: process.stderr.isTTY,
    columns: process.stderr.columns ?? process.stdout.columns
  })

const config = Flag.Path("config", {
  pathType: "file",
  typeName: "CONFIG_FILE"
}).pipe(
  Flag.withAlias("c"),
  Flag.withDescription("Generate the wordlist described by this YAML config"),
  Flag.optional
)

const generateBasicConfig = Flag.Path("generate-basic-config", {
  pathType: "file",
  typeName: "CONFIG_FILE"
}).pipe(
  Flag.withAlias("g"),
  Flag.withDescription(
    "Write a starter config here and scaffold ./templates/<category>/ next to it"
  ),
  Flag.optional
)

const dryRun = Flag.Boolean("dry-run").pipe(
  Flag.withAlias("n"),
  Flag.withDescription(
    "Report what each strategy and each input LINE contributes, plus the raw ratio; write nothing"
  ),
  Flag.withDefault(false)
)

// ---------------------------------------------------------------------------
// pt add
// ---------------------------------------------------------------------------

const addConfig = Flag.Path("config", {
  pathType: "file",
  typeName: "CONFIG_FILE"
}).pipe(
  Flag.withAlias("c"),
  Flag.withDescription("The config whose slot files are appended to")
)

const addSlot = Flag.String("slot").pipe(
  Flag.withDescription(
    "Slot to append to. Pair with --value; repeat the pair to add to several slots"
  ),
  Flag.atLeast(0)
)

const addValue = Flag.String("value").pipe(
  Flag.withDescription("The line to append to the matching --slot"),
  Flag.atLeast(0)
)

const addRaw = Flag.String("raw").pipe(
  Flag.withDescription("Append this payload verbatim to the raw_file"),
  Flag.atLeast(0)
)

const addDecompose = Flag.String("decompose").pipe(
  Flag.withDescription(
    "Split a whole payload into slots and append each part; falls back to raw_file"
  ),
  Flag.atLeast(0)
)

const add = Command.make(
  "add",
  {
    config: addConfig,
    slot: addSlot,
    value: addValue,
    raw: addRaw,
    decompose: addDecompose
  },
  Effect.fn(function* ({ config, decompose, raw, slot, value }) {
    if (slot.length !== value.length) {
      return yield* Effect.fail(
        new PtError(
          `--slot and --value come in pairs: got ${slot.length} --slot and ${value.length} --value.`
        )
      )
    }
    if (slot.length === 0 && raw.length === 0 && decompose.length === 0) {
      return yield* Effect.fail(
        new PtError(
          "nothing to add: pass --slot NAME --value TEXT, --raw PAYLOAD, or --decompose PAYLOAD."
        )
      )
    }

    const report = yield* runAdd(config, {
      slots: slot.map((name, index) => ({ slot: name, value: value[index]! })),
      raw,
      decompose
    })

    for (const note of report.notes) {
      yield* Console.error(`note: ${note}`)
    }
    for (const action of report.actions) {
      const where = `${action.file}:${action.line}`
      if (action.outcome === "already-present") {
        yield* Console.error(
          `already present in ${action.target}  ${JSON.stringify(action.value)}  (${action.file})`
        )
        continue
      }
      yield* Console.error(
        `${action.outcome === "routed-to-raw" ? "raw      " : "added    "} ${
          action.target.padEnd(10)
        } ${JSON.stringify(action.value)}  -> ${where}`
      )
      if (action.why !== undefined) {
        yield* Console.error(`           because ${action.why}`)
      }
    }
    const written = report.actions.filter((a) => a.outcome !== "already-present").length
    yield* Console.error(
      written === 0
        ? `nothing written: every value was already present.`
        : `${written} line${written === 1 ? "" : "s"} appended. Re-run 'pt --config ${config} --dry-run' to see what they earn.`
    )
  })
).pipe(
  Command.withDescription(
    "Append new payloads to a config's slot files, idempotently and append-only."
  ),
  Command.withExamples([
    {
      command: "pt add --config ./pt.yml --slot traversal --value '..%c0%af'",
      description: "Append one traversal primitive to that slot's first file"
    },
    {
      command:
        "pt add --config ./pt.yml --slot target --value /etc/krb5.keytab --slot suffix --value '%00.gif'",
      description: "Add to two slots in one call"
    },
    {
      command: "pt add --config ./pt.yml --raw '..%25%5c..%255cboot.ini'",
      description: "Append a payload that cannot be generated, verbatim"
    },
    {
      command: "pt add --config ./pt.yml --decompose '/var/www/../../../etc/shadow%00.png'",
      description: "Split a found payload into slots; falls back to raw_file"
    }
  ])
)

// ---------------------------------------------------------------------------
// pt
// ---------------------------------------------------------------------------

const pt = Command.make(
  "pt",
  { config, generateBasicConfig, dryRun },
  Effect.fn(function* ({ config, generateBasicConfig, dryRun }) {
    if (Option.isSome(config) && Option.isSome(generateBasicConfig)) {
      return yield* Effect.fail(
        new PtError(
          "--config and --generate-basic-config are mutually exclusive; run them one at a time."
        )
      )
    }

    if (Option.isSome(generateBasicConfig)) {
      if (dryRun) {
        return yield* Effect.fail(
          new PtError("--dry-run applies to --config, not --generate-basic-config.")
        )
      }
      const report = yield* runScaffold(generateBasicConfig.value)
      for (const path of report.written) {
        yield* Console.error(`wrote ${path}`)
      }
      if (report.skipped.length > 0) {
        yield* Console.error(
          `\nkept ${report.skipped.length} existing template${
            report.skipped.length === 1 ? "" : "s"
          } (not overwritten):`
        )
        for (const path of report.skipped) {
          yield* Console.error(`  ${path}`)
        }
      }
      yield* Console.error(
        `\nNext: pt --config ${generateBasicConfig.value} --dry-run`
      )
      return
    }

    if (Option.isSome(config)) {
      const report = yield* runGenerate(config.value, {
        dryRun,
        style: reportStyle()
      })
      if (report.dryRun || report.warning !== undefined) {
        yield* Console.error(report.breakdown)
      }
      if (report.warning !== undefined) {
        yield* Console.error(report.warning)
      }
      yield* Console.error(
        report.dryRun
          ? `\ndry run: ${report.count} unique payloads, nothing written (would write ${report.outputFile})`
          : `${report.count} unique payloads -> ${report.outputFile}`
      )
      return
    }

    return yield* Effect.fail(
      new PtError(
        "nothing to do: pass --config <file> to generate, --generate-basic-config <file> to scaffold one, or 'pt add' to grow a corpus. See --help."
      )
    )
  })
).pipe(
  Command.withDescription(
    [
      "Generate path-traversal payload wordlists: ordered slots choose which path you ask for, strategies choose how it is spelled on the wire.",
      "",
      "  Recon the stack first, then read only the template folders that match it:",
      "  windows, macos, linux, language, devops.",
      "    templates  https://github.com/0xspryon/path-traversal/tree/main/templates",
      "    workflow   https://github.com/0xspryon/path-traversal/blob/main/skills/path-traversal/SKILL.md",
      "",
      "  Authorised testing, CTFs and security research only."
    ].join("\n")
  ),
  Command.withExamples([
    {
      command: "pt --generate-basic-config ./pt.yml",
      description:
        "Write a starter config and seed ./templates/{linux,language,devops,windows,macos}"
    },
    {
      command: "pt --config ./pt.yml --dry-run",
      description: "Report what every strategy and every input line contributes"
    },
    {
      command: "pt --config ./pt.yml",
      description: "Generate the wordlist described by ./pt.yml"
    },
    {
      command: "pt add --config ./pt.yml --slot traversal --value '..%c0%af'",
      description: "Append a newly found primitive to the corpus"
    }
  ]),
  Command.withSubcommands([add])
)

/**
 * Report failures as one clean stderr line and a non-zero exit status, rather
 * than letting an Effect cause dump reach the user.
 */
const reportAndFail = (error: unknown) =>
  Effect.gen(function* () {
    yield* Console.error(`pt: ${formatError(error)}`)
    yield* Effect.sync(() => {
      process.exitCode = 1
    })
  })

Command.run(pt, { version: VERSION }).pipe(
  // Only our own errors: CLI parse errors and --help/--version are already
  // rendered by Command.run and must not be printed a second time.
  Effect.catchTag("PtError", reportAndFail),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain
)
