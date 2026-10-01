export {
  assemble,
  STRIP_RULES,
  stripLeading,
  type AssemblySlot,
  type StripRule
} from "./assemble.ts"
export {
  anchorSlotOf,
  generate,
  type GenerateResult,
  type GeneratorOptions,
  type InputReport,
  type Slot,
  type SlotOverride,
  type Strategy,
  type StrategyReport
} from "./generate.ts"
export {
  isCommentLine,
  parseLines,
  readEscape,
  toSegments,
  type SourceLine
} from "./lines.ts"
export {
  canonicalTarget,
  classesOf,
  decompose,
  featureClasses,
  primaryClass,
  reassemble,
  rejectReason,
  resolveClamped,
  toLiteral,
  tryBase64,
  ALL_CLASSES,
  FEATURE_CLASSES,
  PRIMARY_CLASSES,
  type Decomposition,
  type DecomposeResult,
  type FeatureClass,
  type PayloadClass,
  type PrimaryClass,
  type Rejection
} from "./payloads.ts"
export {
  base64Text,
  DEFAULT_URL_ENCODE_CHARSET,
  emptySegment,
  hexCaseText,
  joinSegments,
  leadingSeparator,
  percentEncodeChar,
  replaceChars,
  SEPARATOR_SPELLINGS,
  SEPARATORS,
  syntheticSegment,
  SYNTHETIC,
  trailingSeparator,
  urlEncodeText,
  type Origin,
  type Segment,
  type SeparatorKind
} from "./segment.ts"
export {
  collectingStore,
  fingerprint,
  fingerprintStore,
  type PayloadStore
} from "./store.ts"
export {
  applyStages,
  parsePipeline,
  PipelineError,
  STRATEGY_CATALOG,
  subsumes,
  tokenize,
  type Kind,
  type ParsedPipeline,
  type Stage,
  type StageArg,
  type StageContext,
  type StageKind,
  type StageSignature,
  type Token
} from "./strategy.ts"
