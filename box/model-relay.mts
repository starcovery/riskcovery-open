import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const TARGET = 'https://openrouter.ai/api'

const PATHS: ReadonlySet<string> = new Set([
  '/v1/messages',
  '/v1/messages/count_tokens',
])

const DROPPED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  'accept-encoding',
  'authorization',
  'connection',
  'content-length',
  'host',
  'x-api-key',
])

const DROPPED_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  'connection',
  'content-encoding',
  'content-length',
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

const modelOf = (body: Buffer): unknown => {
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'))

    return typeof parsed === 'object' && parsed !== null && 'model' in parsed
      ? parsed.model
      : undefined
  } catch {
    return undefined
  }
}

const headersOf = (request: IncomingMessage): Headers => {
  const headers = new Headers()

  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined && !DROPPED_REQUEST_HEADERS.has(name)) {
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

  if (modelOf(body) !== model) {
    refuse(response, 403, `the relay forwards only calls on ${model}`)
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
