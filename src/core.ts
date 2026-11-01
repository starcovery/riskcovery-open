import { readFileSync } from 'node:fs'

import { parse } from 'dotenv'
import { Schema, SchemaTransformation } from 'effect'

export const RUN_MODES = ['fast', 'premium'] as const

export type RunMode = (typeof RUN_MODES)[number]

export const isRunMode = Schema.is(Schema.Literals(RUN_MODES))

const PROMPT_SLOTS = {
  document: '{document}',
  schema: '{schema}',
  site: '{site}',
} as const

const REQUIRED_SLOTS = [PROMPT_SLOTS.document, PROMPT_SLOTS.site] as const

const modelSchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u)
)

const aptPackageSchema = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9.+-]{0,127}$/u)
)

const promptSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(20_000),
  Schema.makeFilter(
    (prompt) =>
      REQUIRED_SLOTS.every((slot) => prompt.includes(slot)) ||
      `a prompt that names ${REQUIRED_SLOTS.join(' and ')}`
  )
)

const aptListSchema = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Array(aptPackageSchema),
    SchemaTransformation.transform<readonly string[], string>({
      decode: (list) => list.split(/\s+/u).filter((name) => name !== ''),
      encode: (names) => names.join(' '),
    })
  )
)

const entriesSchema = Schema.Struct({
  MODEL__FAST: modelSchema,
  MODEL__PREMIUM: modelSchema,
  PREREQUISITES__APT: aptListSchema,
  PROMPT__ON_START: promptSchema,
  PROMPT__ON_STOP: promptSchema,
})

const decodeEntries = Schema.decodeUnknownSync(entriesSchema, {
  onExcessProperty: 'error',
})

export interface Core {
  readonly model: Readonly<Record<RunMode, string>>
  readonly prerequisites: { readonly apt: readonly string[] }
  readonly prompt: { readonly on_start: string; readonly on_stop: string }
}

export type PromptKey = keyof Core['prompt']

export const coreOf = (source: string): Core => {
  const entries = decodeEntries(parse(source))

  return {
    model: { fast: entries.MODEL__FAST, premium: entries.MODEL__PREMIUM },
    prerequisites: { apt: entries.PREREQUISITES__APT },
    prompt: {
      on_start: entries.PROMPT__ON_START,
      on_stop: entries.PROMPT__ON_STOP,
    },
  }
}

export const readCore = (file: string): Core =>
  coreOf(readFileSync(file, 'utf-8'))

export const promptOf = ({
  core,
  document,
  key,
  schema,
  site,
}: {
  core: Pick<Core, 'prompt'>
  document: string
  key: PromptKey
  schema: string
  site: string
}): string =>
  core.prompt[key]
    .trim()
    .replaceAll(PROMPT_SLOTS.document, document)
    .replaceAll(PROMPT_SLOTS.schema, schema)
    .replaceAll(PROMPT_SLOTS.site, site)
