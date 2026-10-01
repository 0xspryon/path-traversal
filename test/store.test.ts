import { describe, expect, test } from "bun:test"
import { collectingStore, fingerprint, fingerprintStore } from "../src/core/index.ts"

// §7: the generator needs a MEMBERSHIP TEST, not the list.
describe("fingerprintStore", () => {
  test("offer returns an insertion index and whether it was fresh", () => {
    const store = fingerprintStore()
    expect(store.offer("a")).toEqual({ index: 0, fresh: true })
    expect(store.offer("b")).toEqual({ index: 1, fresh: true })
    expect(store.offer("a")).toEqual({ index: 0, fresh: false })
    expect(store.size()).toBe(2)
  })

  test("it does not retain payloads, which is the whole point", () => {
    expect(fingerprintStore().payloads).toBeUndefined()
    expect(collectingStore().payloads).toBeDefined()
  })

  test("every fresh payload reaches the callback exactly once, in order", () => {
    const seen: Array<string> = []
    const store = fingerprintStore((payload) => seen.push(payload))
    for (const payload of ["a", "b", "a", "c", "b"]) store.offer(payload)
    expect(seen).toEqual(["a", "b", "c"])
  })

  test("it agrees with an exact Set over a large, adversarial corpus", () => {
    // Shapes a path-traversal wordlist actually contains: long near-identical
    // strings differing in one escape, which is where a weak hash collides.
    const payloads: Array<string> = []
    for (const sep of ["/", "%2f", "%252f", "\\", "%5c", "%c0%af"]) {
      for (let depth = 1; depth <= 24; depth++) {
        for (const target of ["/etc/passwd", "/etc/shadow", "/windows/win.ini"]) {
          for (const suffix of ["", "%00.png", "?.png", ";.png"]) {
            payloads.push(`..${sep}`.repeat(depth) + target.slice(1) + suffix)
          }
        }
      }
    }
    // Plus every one of them uppercased, which differs only in case.
    payloads.push(...payloads.map((p) => p.toUpperCase()))

    const exact = new Set(payloads)
    const store = fingerprintStore()
    for (const payload of payloads) store.offer(payload)
    expect(payloads.length).toBeGreaterThan(3_000)
    expect(store.size()).toBe(exact.size)
  })

  test("it grows past its initial capacity without losing or duplicating anything", () => {
    const store = fingerprintStore(undefined, 16)
    for (let index = 0; index < 50_000; index++) store.offer(`payload-${index}`)
    expect(store.size()).toBe(50_000)
    expect(store.offer("payload-0")).toEqual({ index: 0, fresh: false })
    expect(store.offer("payload-49999").fresh).toBe(false)
  })

  test("the empty string and non-ASCII payloads are handled", () => {
    const store = fingerprintStore()
    expect(store.offer("").fresh).toBe(true)
    expect(store.offer("").fresh).toBe(false)
    expect(store.offer("／etc／passwd").fresh).toBe(true)
    expect(store.offer("／etc／passwd").fresh).toBe(false)
  })
})

describe("fingerprint", () => {
  const of = (text: string) => {
    const out = new Int32Array(4)
    fingerprint(text, out)
    return Array.from(out)
  }

  test("is deterministic", () => {
    expect(of("../../../etc/passwd")).toEqual(of("../../../etc/passwd"))
  })

  test("distinguishes strings a weaker hash would fold together", () => {
    const pairs: ReadonlyArray<readonly [string, string]> = [
      ["../../../etc/passwd", "../../../etc/passwb"],
      ["..%2f..%2fetc/passwd", "..%2F..%2Fetc/passwd"],
      ["a".repeat(64), "a".repeat(65)],
      ["", "\u0000"],
      ["ab", "ba"]
    ]
    for (const [left, right] of pairs) {
      expect(of(left)).not.toEqual(of(right))
    }
  })

  test("length is part of the digest, so a prefix never collides", () => {
    expect(of("/etc/passwd")).not.toEqual(of("/etc/passwd\u0000"))
  })
})

describe("collectingStore", () => {
  test("keeps insertion order and dedupes first-wins", () => {
    const store = collectingStore()
    for (const payload of ["b", "a", "b", "c"]) store.offer(payload)
    expect(store.payloads!()).toEqual(["b", "a", "c"])
  })
})
