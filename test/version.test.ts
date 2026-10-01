import { expect, test } from "bun:test"
import pkg from "../package.json" with { type: "json" }
import { VERSION } from "../src/version.ts"

test("VERSION matches package.json (the bundled CLI cannot read it at runtime)", () => {
  expect(VERSION).toBe(pkg.version)
})

test("the binary is named pt", () => {
  expect(pkg.bin).toEqual({ pt: "./dist/pt.js" })
})
