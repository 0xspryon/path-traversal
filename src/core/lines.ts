import type { Segment } from "./segment.ts"

/**
 * Is this line a comment?
 *
 * A comment is `#` followed by whitespace, by another `#`, or by nothing. The
 * extra condition matters: `#.png` is a legitimate suffix payload (it truncates
 * the URL at a fragment), and a naive "starts with #" rule would silently eat it.
 */
export const isCommentLine = (line: string): boolean => {
  if (!line.startsWith("#")) return false
  const next = line[1]
  return next === undefined || next === "#" || next === " " || next === "\t"
}

/** One usable line of an input file, with the line number it came from. */
export interface SourceLine {
  readonly text: string
  /** 1-based, counting the comments and blanks that were skipped. */
  readonly line: number
}

/**
 * Turn raw file contents into usable lines: trim, drop blanks, drop comments,
 * and remember which line of the file each survivor was.
 *
 * The line number is provenance, and provenance is what lets `--dry-run` say
 * `traversal.txt:3  ..%252f  contributes 0 unique` instead of leaving the user to
 * delete lines and diff counts.
 */
export const parseLines = (contents: string): Array<SourceLine> => {
  const out: Array<SourceLine> = []
  let number = 0
  for (const rawLine of contents.split(/\r?\n/)) {
    number += 1
    const text = rawLine.trim()
    if (text.length === 0) continue
    if (isCommentLine(text)) continue
    out.push({ text, line: number })
  }
  return out
}

/**
 * Read a line's `!` escape.
 *
 * A leading `!` FLIPS the slot's `transform` setting for that one line, which is
 * the per-line exception that replaces v1's file-level `do_not_transform` list.
 * It reads as a sentence next to the content it protects, instead of living in
 * another file keyed by path:
 *
 *     # a slot with transform: true
 *     /etc/passwd          <- rewritten by every strategy
 *     !/etc/pre%2fencoded  <- left literal, this line only
 *
 *     # a slot with transform: false
 *     %00.png              <- left literal
 *     !?.png               <- rewritten, this line only
 *
 * `!!` is a literal leading `!` with the slot's own setting, so a payload that
 * genuinely starts with `!` is still expressible.
 */
export const readEscape = (
  text: string,
  slotTransform: boolean
): { readonly text: string; readonly transform: boolean } => {
  if (text.startsWith("!!")) return { text: text.slice(1), transform: slotTransform }
  if (text.startsWith("!")) return { text: text.slice(1), transform: !slotTransform }
  return { text, transform: slotTransform }
}

/**
 * Tag a file's lines with their slot name, their transform flag and their origin.
 */
export const toSegments = (
  lines: ReadonlyArray<SourceLine>,
  slot: string,
  slotTransform: boolean,
  file: string
): Array<Segment> =>
  lines.flatMap((source) => {
    const { text, transform } = readEscape(source.text, slotTransform)
    if (text.length === 0) return []
    return [{ text, transform, slot, origin: { file, line: source.line } }]
  })
