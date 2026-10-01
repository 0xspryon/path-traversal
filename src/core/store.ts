/**
 * Payload membership, without keeping the payloads.
 *
 * ## Why this exists
 *
 * Nothing in the generator ever reads a payload back after adding it. Output is
 * written in insertion order and dedupe is first-wins, so the only question the
 * generator ever asks of the accumulated set is *"have I seen this one?"*. That
 * is a MEMBERSHIP TEST, not a list -- and holding the list cost 351 MB of RSS for
 * the 185,106 payloads the default config produces, because a JS `Set<string>`
 * retains every payload, `Array.from` copies them all, and `join("\n")` then
 * builds one more copy of the whole file as a single string.
 *
 * So the default store keeps a 128-bit fingerprint per payload in a flat
 * `Uint32Array` and hands each freshly-seen payload straight to a callback, which
 * the CLI points at the output file. 185,106 payloads cost 16 bytes of
 * fingerprint plus 4 bytes of index each, at a load factor below 0.7.
 *
 * The generator's shape does not change at all: it still walks slots inside
 * strategies and calls `offer` once per candidate.
 *
 * ## Why 128 bits
 *
 * A fingerprint set trades exactness for memory, and the trade has to be
 * quantified rather than hand-waved. At 128 bits the chance of any collision
 * across 185,106 payloads is about 5e-29 -- twenty orders of magnitude below the
 * chance of the machine silently flipping a bit while doing the exact comparison
 * instead. `collectingStore` keeps the exact strings for the tests and for
 * callers that want the list anyway.
 */

/** What the generator needs from an accumulated payload set. */
export interface PayloadStore {
  /**
   * Record a candidate payload.
   *
   * `index` is its position in insertion order -- the same for a payload offered
   * twice, which is what lets per-input attribution work without a second pass.
   */
  readonly offer: (payload: string) => { readonly index: number; readonly fresh: boolean }
  readonly size: () => number
  /** The payloads themselves, when this store retains them. */
  readonly payloads?: () => ReadonlyArray<string>
}

// ---------------------------------------------------------------------------
// MurmurHash3 x86 128
// ---------------------------------------------------------------------------

const rotl = (value: number, shift: number): number =>
  (value << shift) | (value >>> (32 - shift))

/** 32x32 multiply that stays exact in a double. */
const mul32 = (a: number, b: number): number => {
  const high = ((a >>> 16) * b) << 16
  const low = (a & 0xffff) * b
  return (high + low) | 0
}

const C1 = 0x239b961b
const C2 = 0xab0e9789
const C3 = 0x38b34ae5
const C4 = 0xa1e38b93

const fmix = (value: number): number => {
  let h = value
  h ^= h >>> 16
  h = mul32(h, 0x85ebca6b)
  h ^= h >>> 13
  h = mul32(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h
}

/**
 * Hash a string to four 32-bit words, written into `out`.
 *
 * Two UTF-16 code units are packed per 32-bit word. That is injective on
 * JavaScript strings -- two different strings differ in some code unit, and the
 * code-unit count goes into the final mix -- so no encoding step and no byte
 * array is allocated per payload.
 */
export const fingerprint = (text: string, out: Int32Array): void => {
  const units = text.length
  const blocks = Math.floor(units / 8)

  let h1 = 0
  let h2 = 0
  let h3 = 0
  let h4 = 0

  const word = (at: number): number =>
    (text.charCodeAt(at) | (text.charCodeAt(at + 1) << 16)) | 0

  for (let block = 0; block < blocks; block++) {
    const at = block * 8
    let k1 = word(at)
    let k2 = word(at + 2)
    let k3 = word(at + 4)
    let k4 = word(at + 6)

    k1 = mul32(rotl(mul32(k1, C1), 15), C2)
    h1 ^= k1
    h1 = rotl(h1, 19)
    h1 = (h1 + h2) | 0
    h1 = (mul32(h1, 5) + 0x561ccd1b) | 0

    k2 = mul32(rotl(mul32(k2, C2), 16), C3)
    h2 ^= k2
    h2 = rotl(h2, 17)
    h2 = (h2 + h3) | 0
    h2 = (mul32(h2, 5) + 0x0bcaa747) | 0

    k3 = mul32(rotl(mul32(k3, C3), 17), C4)
    h3 ^= k3
    h3 = rotl(h3, 15)
    h3 = (h3 + h4) | 0
    h3 = (mul32(h3, 5) + 0x96cd1c35) | 0

    k4 = mul32(rotl(mul32(k4, C4), 18), C1)
    h4 ^= k4
    h4 = rotl(h4, 13)
    h4 = (h4 + h1) | 0
    h4 = (mul32(h4, 5) + 0x32ac3b17) | 0
  }

  // Tail: whatever did not fill a 4-word block.
  let k1 = 0
  let k2 = 0
  let k3 = 0
  let k4 = 0
  const tail = blocks * 8
  for (let at = units - 1; at >= tail; at--) {
    const unit = text.charCodeAt(at)
    const slot = at - tail
    const shift = (slot % 2) * 16
    switch (Math.floor(slot / 2)) {
      case 0:
        k1 ^= unit << shift
        break
      case 1:
        k2 ^= unit << shift
        break
      case 2:
        k3 ^= unit << shift
        break
      default:
        k4 ^= unit << shift
        break
    }
  }
  if (k4 !== 0) h4 ^= mul32(rotl(mul32(k4, C4), 18), C1)
  if (k3 !== 0) h3 ^= mul32(rotl(mul32(k3, C3), 17), C4)
  if (k2 !== 0) h2 ^= mul32(rotl(mul32(k2, C2), 16), C3)
  if (k1 !== 0) h1 ^= mul32(rotl(mul32(k1, C1), 15), C2)

  h1 ^= units
  h2 ^= units
  h3 ^= units
  h4 ^= units

  h1 = (h1 + h2) | 0
  h1 = (h1 + h3) | 0
  h1 = (h1 + h4) | 0
  h2 = (h2 + h1) | 0
  h3 = (h3 + h1) | 0
  h4 = (h4 + h1) | 0

  h1 = fmix(h1)
  h2 = fmix(h2)
  h3 = fmix(h3)
  h4 = fmix(h4)

  h1 = (h1 + h2) | 0
  h1 = (h1 + h3) | 0
  h1 = (h1 + h4) | 0
  h2 = (h2 + h1) | 0
  h3 = (h3 + h1) | 0
  h4 = (h4 + h1) | 0

  out[0] = h1
  out[1] = h2
  out[2] = h3
  out[3] = h4
}

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

const EMPTY = -1
/** Five 32-bit words per slot: four of fingerprint, one of insertion index. */
const STRIDE = 5

/**
 * A bounded, open-addressed fingerprint set.
 *
 * `onFresh` is called once per newly-seen payload, in insertion order, and is
 * the only place a payload string is visible after `offer` returns. Point it at a
 * file writer and the generator streams.
 */
export const fingerprintStore = (
  onFresh?: (payload: string, index: number) => void,
  initialCapacity = 1 << 14
): PayloadStore => {
  let capacityBits = Math.max(10, Math.ceil(Math.log2(initialCapacity)))
  let capacity = 1 << capacityBits
  let table = new Int32Array(capacity * STRIDE).fill(EMPTY)
  let count = 0
  const digest = new Int32Array(4)

  const slotOf = (h0: number, mask: number): number => h0 & mask

  const insert = (
    into: Int32Array,
    mask: number,
    h0: number,
    h1: number,
    h2: number,
    h3: number,
    index: number
  ): void => {
    let slot = slotOf(h0, mask)
    for (;;) {
      const base = slot * STRIDE
      if (into[base + 4] === EMPTY) {
        into[base] = h0
        into[base + 1] = h1
        into[base + 2] = h2
        into[base + 3] = h3
        into[base + 4] = index
        return
      }
      slot = (slot + 1) & mask
    }
  }

  const grow = (): void => {
    const old = table
    const oldCapacity = capacity
    capacityBits += 1
    capacity = 1 << capacityBits
    const next = new Int32Array(capacity * STRIDE).fill(EMPTY)
    const mask = capacity - 1
    for (let slot = 0; slot < oldCapacity; slot++) {
      const base = slot * STRIDE
      const index = old[base + 4]!
      if (index === EMPTY) continue
      insert(next, mask, old[base]!, old[base + 1]!, old[base + 2]!, old[base + 3]!, index)
    }
    table = next
  }

  return {
    offer: (payload) => {
      fingerprint(payload, digest)
      const h0 = digest[0]!
      const h1 = digest[1]!
      const h2 = digest[2]!
      const h3 = digest[3]!
      const mask = capacity - 1
      let slot = slotOf(h0, mask)
      for (;;) {
        const base = slot * STRIDE
        const index = table[base + 4]!
        if (index === EMPTY) break
        if (
          table[base] === h0 &&
          table[base + 1] === h1 &&
          table[base + 2] === h2 &&
          table[base + 3] === h3
        ) {
          return { index, fresh: false }
        }
        slot = (slot + 1) & mask
      }
      const index = count
      table[slot * STRIDE] = h0
      table[slot * STRIDE + 1] = h1
      table[slot * STRIDE + 2] = h2
      table[slot * STRIDE + 3] = h3
      table[slot * STRIDE + 4] = index
      count += 1
      onFresh?.(payload, index)
      if (count * 10 >= capacity * 7) grow()
      return { index, fresh: true }
    },
    size: () => count
  }
}

/**
 * An exact store that retains every payload.
 *
 * Used by the tests, which want to assert on the payloads themselves, and
 * available to any caller that genuinely needs the list. Costs what v1 cost.
 */
export const collectingStore = (
  onFresh?: (payload: string, index: number) => void
): PayloadStore => {
  const indices = new Map<string, number>()
  const kept: Array<string> = []
  return {
    offer: (payload) => {
      const existing = indices.get(payload)
      if (existing !== undefined) return { index: existing, fresh: false }
      const index = kept.length
      indices.set(payload, index)
      kept.push(payload)
      onFresh?.(payload, index)
      return { index, fresh: true }
    },
    size: () => kept.length,
    payloads: () => kept
  }
}
