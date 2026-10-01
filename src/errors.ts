/**
 * The single error type the CLI surfaces to the user. Every failure mode -- bad
 * YAML, schema violation, missing input file, typo in `do_not_transform`, an
 * output file that already exists -- is reported through this, so the shell can
 * print one clean line instead of an Effect cause dump.
 */
export class PtError extends Error {
  readonly _tag = "PtError"
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options)
    this.name = "PtError"
  }
}

export const isPtError = (u: unknown): u is PtError => u instanceof PtError

/** Best-effort single-line rendering of any thrown/failed value. */
export const formatError = (error: unknown): string => {
  if (isPtError(error)) return error.message
  if (error instanceof Error) {
    return error.message.length > 0 ? error.message : error.name
  }
  return String(error)
}
