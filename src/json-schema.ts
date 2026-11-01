import { JsonSchema, Schema } from 'effect'

export const jsonSchemaOf = (
  schema: Schema.Top,
  options: Schema.ToJsonSchemaOptions = {}
): JsonSchema.JsonSchema => {
  const document = Schema.toJsonSchemaDocument(schema, options)

  const root = {
    $schema: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12,
    ...document.schema,
  }

  return Object.keys(document.definitions).length === 0
    ? root
    : { ...root, $defs: document.definitions }
}
