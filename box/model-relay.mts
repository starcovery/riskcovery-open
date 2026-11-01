import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const TARGET = process.env.RELAY_UPSTREAM ?? 'https://openrouter.ai/api'

const PATHS: ReadonlySet<string> = new Set([
  '/v1/messages',
  '/v1/messages/count_tokens',
])

const REFUSED_FIELDS: readonly string[] = [
  'container',
  'deferred_tools',
  'fallbacks',
  'max_tool_calls',
  'mcp_servers',
  'models',
  'plugins',
  'preset',
  'provider',
  'route',
  'safeguards',
  'stop_server_tools_when',
  'transforms',
  'web_search_options',
]

const STANDARD_VALUES: ReadonlyMap<string, ReadonlySet<unknown>> = new Map([
  ['inference_geo', new Set(['global'])],
  ['service_tier', new Set(['default', 'standard', 'standard_only'])],
  ['speed', new Set(['standard'])],
])

const DROPPED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  'accept-encoding',
  'authorization',
  'cdn-loop',
  'connection',
  'content-length',
  'cookie',
  'expect',
  'forwarded',
  'host',
  'keep-alive',
  'proxy-connection',
  'te',
  'transfer-encoding',
  'true-client-ip',
  'upgrade',
  'x-api-key',
  'x-real-ip',
])

const DROPPED_REQUEST_PREFIXES: readonly string[] = [
  'cf-',
  'x-forwarded-',
  'x-vercel-',
]

const DROPPED_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'set-cookie',
  'transfer-encoding',
])

const apiKey = process.env.OPENROUTER_API_KEY ?? ''

const model = process.env.RELAY_MODEL ?? ''

const port = Number(process.env.RELAY_PORT)

const refuse = (
  response: ServerResponse,
  status: number,
  message: string
): void => {
  if (response.headersSent) {
    response.destroy()
    return
  }

  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(
    JSON.stringify({ error: { message, type: 'permission_error' }, type: 'error' })
  )
}

const bodyOf = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = []

  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk))
  }

  return Buffer.concat(chunks)
}

const callOf = (body: Buffer): ReadonlyMap<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'))

    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? new Map(Object.entries(parsed))
      : null
  } catch {
    return null
  }
}

const entriesOf = (value: unknown): ReadonlyMap<string, unknown> => {
  const entries: [string, unknown][] = Object.entries(value ?? {})

  return new Map(entries)
}

const isClientTool = (tool: unknown): boolean => {
  const fields = entriesOf(tool)

  return !fields.has('type') || fields.get('type') === 'custom'
}

const raisesItsPrice = (call: ReadonlyMap<string, unknown>): boolean =>
  [...STANDARD_VALUES].some(
    ([field, values]) => call.has(field) && !values.has(call.get(field))
  )

const offersOnlyClientTools = (call: ReadonlyMap<string, unknown>): boolean => {
  const tools = call.get('tools')

  return !call.has('tools') || (Array.isArray(tools) && tools.every(isClientTool))
}

const isDropped = (name: string): boolean =>
  DROPPED_REQUEST_HEADERS.has(name) ||
  DROPPED_REQUEST_PREFIXES.some((prefix) => name.startsWith(prefix))

const headersOf = (request: IncomingMessage): Headers => {
  const headers = new Headers()

  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined && !isDropped(name)) {
      headers.set(name, Array.isArray(value) ? value.join(', ') : value)
    }
  }

  headers.set('authorization', `Bearer ${apiKey}`)

  return headers
}

const relay = async (
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> => {
  const url = new URL(request.url ?? '/', 'http://relay')

  if (request.method !== 'POST' || !PATHS.has(url.pathname)) {
    refuse(response, 404, `the relay forwards only POST ${[...PATHS].join(' and ')}`)
    return
  }

  const body = await bodyOf(request)
  const call = callOf(body)

  if (call === null || call.get('model') !== model) {
    refuse(response, 403, `the relay forwards only calls on ${model}`)
    return
  }

  if (REFUSED_FIELDS.some((field) => call.has(field)) || raisesItsPrice(call)) {
    refuse(
      response,
      403,
      `the relay forwards no call that names ${REFUSED_FIELDS.join(', ')}, or that sets ${[...STANDARD_VALUES.keys()].join(', ')} to anything but the standard price, since each can move the call to another model or add a paid step`
    )
    return
  }

  if (!offersOnlyClientTools(call)) {
    refuse(
      response,
      403,
      "the relay forwards only a list of the agent's own tools, with no type or the custom type, since a server tool adds a paid step"
    )
    return
  }

  const answer = await fetch(`${TARGET}${url.pathname}${url.search}`, {
    body,
    headers: headersOf(request),
    method: 'POST',
  })

  response.writeHead(
    answer.status,
    Object.fromEntries(
      [...answer.headers].filter(([name]) => !DROPPED_RESPONSE_HEADERS.has(name))
    )
  )

  if (answer.body === null) {
    response.end()
    return
  }

  await pipeline(Readable.fromWeb(answer.body), response)
}

createServer((request, response) => {
  relay(request, response).catch((error: unknown) => {
    refuse(response, 502, error instanceof Error ? error.message : 'the relay failed')
  })
}).listen(port, () => {
  console.log(`model relay listening on ${String(port)}`)
})
