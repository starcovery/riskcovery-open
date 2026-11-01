import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'

import { Result, Schema } from 'effect'
import { GenericContainer, Network, Wait } from 'testcontainers'
import type { StartedNetwork, StartedTestContainer } from 'testcontainers'

import {
  agentEnv,
  buildBoxImage,
  callsOf,
  findingsOf,
  prepareBox,
  readTranscripts,
  runAgent,
  startBox,
  startRelay,
} from './box.ts'
import type { AgentCalls, AgentDay } from './box.ts'
import { RUN_MODES, isRunMode, readCore } from './core.ts'

const root = path.join(import.meta.dirname, '..')

const CORE_FILE = path.join(root, 'core', 'marmot', '.env')

const PRACTICE_SITE = 'larkspur-outdoor.test'

const PRACTICE_DIR = path.join(root, 'practice-site')

const PRACTICE_IMAGE =
  'caddy:2.11.7-alpine@sha256:e70b164da81ef698b3ad19af799ea6086ce6d9e48ed4079eb9fe26f6fbf14ee5'

const ACCESS_LOG = '/data/access.log'

const ROUND_MS = 5 * 60 * 1000

const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS'])

const SITE_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/u

const usage = `Usage: npm run review -- (--site <host> | --practice) [--mode fast|premium] [--minutes <n>] [--out <folder>]

  --site <host>     review your own website, such as example.com
  --practice        review the bundled practice site instead, which runs on your machine
  --mode            fast (the default) or premium, which picks the core's model
  --minutes         how long the review runs, 15 by default
  --out             where the report is written, reports by default

OPENROUTER_API_KEY must hold an OpenRouter API key.`

const AccessLine = Schema.Struct({
  request: Schema.Struct({ method: Schema.String }),
})

const decodeAccess = Schema.decodeUnknownResult(
  Schema.fromJsonString(AccessLine)
)

const writesIn = (log: string): number =>
  log.split('\n').filter((line) => {
    const decoded = decodeAccess(line)

    return (
      Result.isSuccess(decoded) &&
      !READ_METHODS.has(decoded.success.request.method.toUpperCase())
    )
  }).length

const hostOf = (subject: string): string =>
  subject
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//u, '')
    .replace(/\/$/u, '')

const startPracticeSite = async (
  network: StartedNetwork
): Promise<StartedTestContainer> =>
  await new GenericContainer(PRACTICE_IMAGE)
    .withNetwork(network)
    .withNetworkAliases(PRACTICE_SITE)
    .withExposedPorts(80)
    .withCopyDirectoriesToContainer([
      { source: path.join(PRACTICE_DIR, 'srv'), target: '/srv' },
    ])
    .withCopyFilesToContainer([
      {
        source: path.join(PRACTICE_DIR, 'Caddyfile'),
        target: '/etc/caddy/Caddyfile',
      },
    ])
    .withWaitStrategy(Wait.forHttp('/', 80))
    .start()

const usageOf = async (apiKey: string): Promise<number | null> => {
  const KeyAnswer = Schema.Struct({
    data: Schema.Struct({ usage: Schema.Number }),
  })

  const answer = await fetch('https://openrouter.ai/api/v1/key', {
    headers: { Authorization: `Bearer ${apiKey}` },
  })

  if (!answer.ok) {
    return null
  }

  const decoded = Schema.decodeUnknownResult(KeyAnswer)(await answer.json())

  return Result.isSuccess(decoded) ? decoded.success.data.usage : null
}

const failuresOf = ({
  calls,
  day,
  model,
  site,
  writes,
}: {
  calls: AgentCalls
  day: AgentDay
  model: string
  site: string
  writes: number
}): string[] => {
  const relayed = 'document' in day.document ? day.document.document : null

  return [
    ...('refusal' in day.document
      ? [`no report: ${day.document.refusal}`]
      : []),
    ...(relayed !== null && hostOf(relayed.subject) !== hostOf(site)
      ? [`the report's subject is ${relayed.subject}, not ${site}`]
      : []),
    ...(relayed !== null && findingsOf(relayed).length === 0
      ? ['the report holds no finding']
      : []),
    ...(writes > 0
      ? [`the agent sent ${String(writes)} requests that write to the site`]
      : []),
    ...(calls.models.length === 0 ? ['the agent made no model call'] : []),
    ...calls.models
      .filter((called) => called !== model)
      .map((called) => `a model call ran on ${called}, not ${model}`),
    ...(day.end === 'failed' ? ['the agent failed three turns in a row'] : []),
  ]
}

const { values } = parseArgs({
  options: {
    help: { type: 'boolean' },
    minutes: { default: '15', type: 'string' },
    mode: { default: 'fast', type: 'string' },
    out: { default: path.join(root, 'reports'), type: 'string' },
    practice: { type: 'boolean' },
    site: { type: 'string' },
  },
})

if (values.help === true) {
  console.log(usage)
  process.exit(0)
}

const apiKey = process.env.OPENROUTER_API_KEY ?? ''
const minutes = Number(values.minutes)
const site = values.practice === true ? PRACTICE_SITE : hostOf(values.site ?? '')

if (apiKey === '') {
  console.error(`OPENROUTER_API_KEY is unset.\n\n${usage}`)
  process.exit(2)
}

if ((values.practice === true) === (values.site !== undefined)) {
  console.error(`Name one of --site and --practice.\n\n${usage}`)
  process.exit(2)
}

if (values.practice !== true && !SITE_NAME.test(site)) {
  console.error(`--site takes a host name, such as example.com.\n\n${usage}`)
  process.exit(2)
}

if (!isRunMode(values.mode)) {
  console.error(`--mode takes ${RUN_MODES.join(' or ')}.\n\n${usage}`)
  process.exit(2)
}

if (!Number.isFinite(minutes) || minutes <= 0) {
  console.error(`--minutes takes a positive number.\n\n${usage}`)
  process.exit(2)
}

const core = readCore(CORE_FILE)
const model = core.model[values.mode]

console.log(
  `Reviewing ${site} for ${String(minutes)} minutes in ${values.mode} mode on ${model}.`
)

const [usedBefore, image, network] = await Promise.all([
  usageOf(apiKey),
  buildBoxImage(),
  new Network().start(),
])

const [practice, box, relay] = await Promise.all([
  values.practice === true ? startPracticeSite(network) : null,
  startBox({ image, network }),
  startRelay({ apiKey, image, model, network }),
])

try {
  await prepareBox({ box, core })

  const day = await runAgent({
    box,
    core,
    env: agentEnv(model),
    model,
    roundMs: ROUND_MS,
    site,
    until: Date.now() + minutes * 60 * 1000,
  })

  const [transcripts, log, usedAfter] = await Promise.all([
    readTranscripts(box),
    practice === null ? null : practice.exec(['cat', ACCESS_LOG]),
    usageOf(apiKey),
  ])

  const calls = callsOf(transcripts)
  const writes = log === null ? 0 : writesIn(log.stdout)
  const failures = failuresOf({ calls, day, model, site, writes })

  mkdirSync(values.out, { recursive: true })

  const report = path.join(
    values.out,
    `${site}-${new Date().toISOString().replaceAll(':', '-')}.json`
  )

  if ('document' in day.document) {
    writeFileSync(report, `${JSON.stringify(day.document.document, null, 2)}\n`)
  }

  const findings =
    'document' in day.document
      ? findingsOf(day.document.document).map((finding) => finding.title)
      : []

  console.log(
    [
      '',
      'document' in day.document
        ? `Report: ${report}`
        : 'The agent wrote no report that matches the schema.',
      `Findings: ${String(findings.length)}`,
      ...findings.map((title) => `  - ${title}`),
      `Model calls: ${String(calls.calls)} on ${calls.models.join(', ') || 'no model'}`,
      `OpenRouter spend: ${usedBefore === null || usedAfter === null ? 'unknown' : `$${(usedAfter - usedBefore).toFixed(4)}`}`,
      ...(practice === null
        ? []
        : [`Requests that write to the site: ${String(writes)}`]),
      failures.length === 0
        ? 'Result: pass'
        : `Result: fail\n${failures.map((failure) => `  - ${failure}`).join('\n')}`,
    ].join('\n')
  )

  process.exitCode = failures.length === 0 ? 0 : 1
} finally {
  await Promise.all([box.stop(), relay.stop(), practice?.stop()])
  await network.stop()
}
