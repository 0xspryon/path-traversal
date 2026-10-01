import {
  applyStages,
  assemble,
  DEFAULT_URL_ENCODE_CHARSET,
  joinSegments,
  parsePipeline,
  type AssemblySlot,
  type Segment,
  type StripRule
} from "../src/core/index.ts"

export const seg = (
  text: string,
  slot = "target",
  transform = true
): Segment => ({ text, slot, transform })

export const protectedSeg = (text: string, slot = "suffix"): Segment =>
  seg(text, slot, false)

/** A slot's contribution, with the default strip rule unless told otherwise. */
export const slotOf = (
  segment: Segment,
  repeat = 1,
  strip: StripRule = "when_same_separator"
): AssemblySlot => ({ segment, repeat, strip })

/**
 * The canonical fixture: no prefix, `../` x 3, `/etc/passwd`, and a `%00.png`
 * suffix the suffix slot declares `transform: false`.
 *
 * Plain, this joins to `../../../etc/passwd%00.png`.
 */
export const fixture = (
  overrides: Partial<{
    prefix: Segment
    traversal: Segment
    depth: number
    target: Segment
    suffix: Segment
  }> = {}
): Array<Segment> => {
  const parts = {
    prefix: seg("", "prefix", false),
    traversal: seg("../", "traversal"),
    depth: 3,
    target: seg("/etc/passwd", "target"),
    suffix: protectedSeg("%00.png"),
    ...overrides
  }
  return assemble([
    slotOf(parts.prefix),
    slotOf(parts.traversal, parts.depth),
    slotOf(parts.target),
    slotOf(parts.suffix)
  ])
}

/** Run a pipeline over a segment list and join the result. */
export const applyPipeline = (
  pipeline: string,
  segments: ReadonlyArray<Segment> = fixture(),
  charset: string = DEFAULT_URL_ENCODE_CHARSET
): string =>
  joinSegments(
    applyStages(segments, parsePipeline(pipeline, charset).stages, {
      anchorSlot: "target"
    })
  )
