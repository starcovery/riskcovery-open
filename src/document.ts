import { Schema } from 'effect'

const Line = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(300)
)

const Prose = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(20_000)
)

const Key = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9._:-]{0,127}$/u)
)

export const toneSchema = Schema.Literals([
  'accent',
  'error',
  'info',
  'neutral',
  'success',
  'warning',
])

export const metricSchema = Schema.Struct({
  display: Line,
  id: Key,
  label: Line,
  max: Schema.NullOr(Schema.Number),
  tone: Schema.NullOr(toneSchema),
  value: Schema.NullOr(Schema.Number),
})

export const labelSchema = Schema.Struct({ text: Line, tone: toneSchema })

const HOST_NAME = String.raw`(?:[A-Za-z0-9_-]+\.)*[A-Za-z][A-Za-z0-9_-]*\.?`

const OCTET = '(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])'

const PORT =
  '(?:[0-9]{1,4}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])'

const WEB_URL = new RegExp(
  String.raw`^[Hh][Tt][Tt][Pp][Ss]?://(?:${HOST_NAME}|(?:${OCTET}\.){3}${OCTET})(?::${PORT})?(?:[/?#][^\x00-\x20\x7f]*)?$`,
  'u'
)

const WebUrl = Schema.String.check(
  Schema.makeFilter((url) => URL.canParse(url) || 'an http or https URL'),
  Schema.isPattern(WEB_URL, { expected: 'an http or https URL' })
).annotate({
  description:
    'An absolute http or https URL whose host is an ASCII host name, with any non-ASCII label in its punycode (xn--) form, or an IPv4 address, such as https://example.com/pricing',
})

export const artifactKeySchema = Schema.String.check(
  Schema.isMaxLength(256),
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/u)
).annotate({
  description:
    'A file written in the folder that holds this document, by its path relative to that folder',
})

const linkSchema = Schema.Struct({ label: Line, url: WebUrl })

const artifactSchema = Schema.Struct({
  key: artifactKeySchema,
  kind: Schema.Literals(['html', 'image', 'text']),
  label: Line,
})

const cellSchema = Schema.Union([Schema.String, Schema.Number, Schema.Null])

const leafBlocks = [
  Schema.Struct({ kind: Schema.Literal('paragraph'), text: Prose }),
  Schema.Struct({
    items: Schema.Array(Prose),
    kind: Schema.Literal('list'),
    ordered: Schema.Boolean,
  }),
  Schema.Struct({
    items: Schema.Array(metricSchema),
    kind: Schema.Literal('metrics'),
  }),
  Schema.Struct({
    columns: Schema.Array(Line),
    kind: Schema.Literal('table'),
    rows: Schema.Array(Schema.Array(cellSchema)),
  }),
  Schema.Struct({
    items: Schema.Array(
      Schema.Struct({ source: Schema.NullOr(WebUrl), text: Prose })
    ),
    kind: Schema.Literal('quotes'),
  }),
  Schema.Struct({
    items: Schema.Array(linkSchema),
    kind: Schema.Literal('links'),
  }),
  Schema.Struct({
    items: Schema.Array(artifactSchema),
    kind: Schema.Literal('artifacts'),
  }),
  Schema.Struct({
    kind: Schema.Literal('code'),
    language: Schema.NullOr(Line),
    text: Prose,
  }),
] as const

export const leafBlockSchema = Schema.Union(leafBlocks)

export const findingSchema = Schema.Struct({
  blocks: Schema.Array(leafBlockSchema),
  group: Schema.NullOr(Line),
  id: Key,
  label: Schema.NullOr(labelSchema),
  tags: Schema.Array(Line),
  title: Line,
})

export const blockSchema = Schema.Union([
  ...leafBlocks,
  Schema.Struct({
    items: Schema.Array(findingSchema),
    kind: Schema.Literal('findings'),
  }),
])

export const sectionSchema = Schema.Struct({
  blocks: Schema.Array(blockSchema),
  id: Key,
  lede: Schema.NullOr(Prose),
  title: Line,
})

export const outputDocumentSchema = Schema.Struct({
  sections: Schema.Array(sectionSchema),
  status: labelSchema,
  subject: Line,
  summary: Schema.Struct({
    lede: Prose,
    metrics: Schema.Array(metricSchema),
  }),
  title: Line,
  version: Schema.Literal(1),
})

export type OutputDocument = typeof outputDocumentSchema.Type
