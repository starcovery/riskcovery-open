import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { Result, Schema } from 'effect'
import { GenericContainer, Wait } from 'testcontainers'
import type { StartedNetwork, StartedTestContainer } from 'testcontainers'

import { promptOf } from './core.ts'
import type { Core, PromptKey } from './core.ts'
import { outputDocumentSchema } from './document.ts'
import type { OutputDocument } from './document.ts'
import { jsonSchemaOf } from './json-schema.ts'

const BOX_HOME = '/home/user'

const BOX_RUN_DIR = `${BOX_HOME}/review`

const BOX_DOCUMENT_FILE = `${BOX_RUN_DIR}/document.json`

const BOX_SCHEMA_FILE = `${BOX_RUN_DIR}/document.schema.json`

const BOX_TRANSCRIPTS_DIR = `${BOX_HOME}/.claude/projects`

const inOrder = async <Item, Output>(
  items: readonly Item[],
  run: (item: Item) => Promise<Output>
): Promise<Output[]> => {
  const [first, ...rest] = items

  if (first === undefined) {
    return []
  }

  const result = await run(first)

  return [result, ...(await inOrder(rest, run))]
}

const BOX_IMAGE = 'riskcovery-open-box:local'

const BOX_USER = 'user'

const SHORT_TURN_MS = 10_000

const FAILED_TURNS = 3

const KILL_AFTER_SECONDS = 15

const SYNTHETIC_MODEL = '<synthetic>'

const RELAY_ALIAS = 'model-relay'

const RELAY_PORT = 8080

const RELAY_SCRIPT = '/opt/model-relay.mts'

const RELAY_TOKEN = 'held-by-the-relay'

const RELAY_URL = `http://${RELAY_ALIAS}:${String(RELAY_PORT)}`

export const DOCUMENT_SCHEMA = JSON.stringify(
  jsonSchemaOf(outputDocumentSchema),
  null,
  2
)

export const prepareCommand = (apt: readonly string[]): string => {
  const folder = `mkdir -p ${BOX_RUN_DIR}`

  if (apt.length === 0) {
    return folder
  }

  const quiet = 'sudo DEBIAN_FRONTEND=noninteractive apt-get'

  return [
    folder,
    '&&',
    quiet,
    'update',
    '-qq',
    '&&',
    quiet,
    'install',
    '-y',
    '-qq',
    '--no-install-recommends',
    ...apt,
  ].join(' ')
}

export const agentEnv = (model: string) => ({
  ANTHROPIC_API_KEY: '',
  ANTHROPIC_AUTH_TOKEN: RELAY_TOKEN,
  ANTHROPIC_BASE_URL: RELAY_URL,
  ANTHROPIC_DEFAULT_FABLE_MODEL: model,
  ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
  ANTHROPIC_DEFAULT_OPUS_MODEL: model,
  ANTHROPIC_DEFAULT_SONNET_MODEL: model,
  ANTHROPIC_MODEL: model,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_SUBAGENT_MODEL: model,
})

export interface Turn {
  readonly fresh: boolean
  readonly keys: readonly PromptKey[]
}

export const turnOf = ({
  round,
  turn,
}: {
  round: number
  turn: number
}): Turn => {
  if (turn > 0) {
    return { fresh: false, keys: ['on_stop'] }
  }

  return {
    fresh: true,
    keys: round === 0 ? ['on_start'] : ['on_start', 'on_stop'],
  }
}

export const buildBoxImage = async (): Promise<string> => {
  await GenericContainer.fromDockerfile(
    path.join(import.meta.dirname, '..', 'box')
  ).build(BOX_IMAGE, { deleteOnExit: false })

  return BOX_IMAGE
}

export const startBox = async ({
  image,
  network,
}: {
  image: string
  network: StartedNetwork
}): Promise<StartedTestContainer> =>
  await new GenericContainer(image)
    .withNetwork(network)
    .withCommand(['sleep', 'infinity'])
    .start()

export const startRelay = async ({
  apiKey,
  image,
  model,
  network,
}: {
  apiKey: string
  image: string
  model: string
  network: StartedNetwork
}): Promise<StartedTestContainer> =>
  await new GenericContainer(image)
    .withNetwork(network)
    .withNetworkAliases(RELAY_ALIAS)
    .withEnvironment({
      OPENROUTER_API_KEY: apiKey,
      RELAY_MODEL: model,
      RELAY_PORT: String(RELAY_PORT),
    })
    .withCommand(['node', RELAY_SCRIPT])
    .withWaitStrategy(Wait.forLogMessage('model relay listening'))
    .start()

const inBox = async (
  box: StartedTestContainer,
  command: readonly string[],
  env: Readonly<Record<string, string>> = {}
) =>
  await box.exec([...command], {
    env: { ...env },
    user: BOX_USER,
    workingDir: BOX_HOME,
  })

export const prepareBox = async ({
  box,
  core,
}: {
  box: StartedTestContainer
  core: Pick<Core, 'prerequisites'>
}): Promise<void> => {
  const prepared = await inBox(box, [
    'bash',
    '-c',
    prepareCommand(core.prerequisites.apt),
  ])

  if (prepared.exitCode !== 0) {
    throw new Error(
      `the box's prerequisites did not install: exit ${String(prepared.exitCode)}\n${prepared.output}`
    )
  }

  await box.copyContentToContainer([
    { content: DOCUMENT_SCHEMA, mode: 0o644, target: BOX_SCHEMA_FILE },
  ])
}

export interface AgentRun {
  readonly box: StartedTestContainer
  readonly core: Pick<Core, 'prompt'>
  readonly env: Readonly<Record<string, string>>
  readonly model: string
  readonly roundMs: number
  readonly site: string
  readonly until: number
}

export type AgentEnd = 'day' | 'failed'

const turnPrompt = (run: AgentRun, keys: readonly PromptKey[]): string =>
  keys
    .map((key) =>
      promptOf({
        core: run.core,
        document: BOX_DOCUMENT_FILE,
        key,
        schema: BOX_SCHEMA_FILE,
        site: run.site,
      })
    )
    .join('\n\n')

const runTurn = async (
  run: AgentRun,
  turn: Turn,
  until: number
): Promise<boolean> => {
  const started = Date.now()
  const seconds = Math.max(1, Math.ceil((until - started) / 1000))

  const { exitCode } = await inBox(
    run.box,
    [
      'timeout',
      `--kill-after=${String(KILL_AFTER_SECONDS)}`,
      String(seconds),
      'claude',
      '--print',
      '--model',
      run.model,
      '--dangerously-skip-permissions',
      '--output-format',
      'json',
      ...(turn.fresh ? [] : ['--continue']),
      turnPrompt(run, turn.keys),
    ],
    run.env
  )

  const took = Date.now() - started

  if (took < SHORT_TURN_MS) {
    await sleep(Math.min(SHORT_TURN_MS - took, Math.max(0, until - Date.now())))
  }

  return exitCode !== 0 && took < SHORT_TURN_MS
}

const runTurns = async ({
  failures,
  round,
  roundEnd,
  run,
  turn,
}: {
  failures: number
  round: number
  roundEnd: number
  run: AgentRun
  turn: number
}): Promise<number | null> => {
  if (Date.now() >= roundEnd) {
    return failures
  }

  const failed = await runTurn(run, turnOf({ round, turn }), roundEnd)
  const next = failed ? failures + 1 : 0

  if (next >= FAILED_TURNS) {
    return null
  }

  return await runTurns({
    failures: next,
    round,
    roundEnd,
    run,
    turn: turn + 1,
  })
}

type Block = OutputDocument['sections'][number]['blocks'][number]

type Finding = Extract<Block, { readonly kind: 'findings' }>['items'][number]

const artifactKeys = (block: Block): readonly string[] => {
  if (block.kind === 'artifacts') {
    return block.items.map((item) => item.key)
  }

  return block.kind === 'findings'
    ? block.items.flatMap((finding) => finding.blocks.flatMap(artifactKeys))
    : []
}

export const findingsOf = (document: OutputDocument): readonly Finding[] =>
  document.sections.flatMap((section) =>
    section.blocks.flatMap((block) =>
      block.kind === 'findings' ? block.items : []
    )
  )

const decodeDocument = Schema.decodeUnknownResult(
  Schema.fromJsonString(outputDocumentSchema)
)

export type DocumentCheck = 'artifacts' | 'decodes' | 'written'

export type BoxDocument =
  | { readonly document: OutputDocument }
  | { readonly failed: DocumentCheck; readonly refusal: string }

const UNWRITTEN: BoxDocument = {
  failed: 'written',
  refusal: `${BOX_DOCUMENT_FILE} is missing`,
}

export const readBoxDocument = async (
  box: StartedTestContainer
): Promise<BoxDocument> => {
  const read = await inBox(box, ['cat', BOX_DOCUMENT_FILE])

  if (read.exitCode !== 0) {
    return UNWRITTEN
  }

  const decoded = decodeDocument(read.stdout)

  if (Result.isFailure(decoded)) {
    return { failed: 'decodes', refusal: decoded.failure.message }
  }

  const keys = [
    ...new Set(
      decoded.success.sections.flatMap((section) =>
        section.blocks.flatMap(artifactKeys)
      )
    ),
  ]

  const lacking = await inOrder(keys, async (key) => {
    const found = await inBox(box, ['test', '-f', `${BOX_RUN_DIR}/${key}`])

    return found.exitCode === 0 ? [] : [key]
  })

  const missing = lacking.flat()

  return missing.length > 0
    ? {
        failed: 'artifacts',
        refusal: `the document names files the box lacks: ${missing.join(', ')}`,
      }
    : { document: decoded.success }
}

export interface AgentDay {
  readonly document: BoxDocument
  readonly end: AgentEnd
}

export const relayedOf = (kept: BoxDocument, read: BoxDocument): BoxDocument =>
  'document' in kept && !('document' in read) ? kept : read

export const runAgent = async (
  run: AgentRun,
  round = 0,
  failures = 0,
  kept: BoxDocument = UNWRITTEN
): Promise<AgentDay> => {
  const start = Date.now()

  if (start >= run.until) {
    return { document: kept, end: 'day' }
  }

  const left = await runTurns({
    failures,
    round,
    roundEnd: Math.min(start + run.roundMs, run.until),
    run,
    turn: 0,
  })

  const document = relayedOf(kept, await readBoxDocument(run.box))

  return left === null
    ? { document, end: 'failed' }
    : await runAgent(run, round + 1, left, document)
}

const TranscriptLine = Schema.Struct({
  message: Schema.optional(
    Schema.Struct({
      id: Schema.optional(Schema.String),
      model: Schema.optional(Schema.String),
    })
  ),
  type: Schema.String,
})

const decodeLine = Schema.decodeUnknownResult(
  Schema.fromJsonString(TranscriptLine)
)

export interface AgentCalls {
  readonly calls: number
  readonly models: readonly string[]
}

export const callsOf = (transcripts: string): AgentCalls => {
  const calls = new Map<string, string>()

  for (const line of transcripts.split('\n')) {
    const decoded = decodeLine(line)

    const message =
      Result.isSuccess(decoded) && decoded.success.type === 'assistant'
        ? decoded.success.message
        : undefined

    const model = message?.model

    if (
      message?.id !== undefined &&
      model !== undefined &&
      model !== SYNTHETIC_MODEL
    ) {
      calls.set(message.id, model)
    }
  }

  return {
    calls: calls.size,
    models: [...new Set(calls.values())].toSorted(),
  }
}

export const readTranscripts = async (
  box: StartedTestContainer
): Promise<string> => {
  const read = await inBox(box, [
    'find',
    BOX_TRANSCRIPTS_DIR,
    '-name',
    '*.jsonl',
    '-type',
    'f',
    '-exec',
    'cat',
    '{}',
    '+',
  ])

  return read.exitCode === 0 ? read.stdout : ''
}
