import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer, request as httpRequest } from 'node:http'
import type { IncomingHttpHeaders, IncomingMessage, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, expect, test } from 'vitest'

const MODEL = 'open-model'

const RELAY_KEY = 'key-only-the-relay-holds'

const AGENT_TOKEN = 'held-by-the-relay'

interface Received {
  readonly body: string
  readonly headers: IncomingHttpHeaders
  readonly path: string
}

interface Answer {
  readonly body: string
  readonly headers: IncomingHttpHeaders
  readonly status: number
}

const received: Received[] = []

const openRouter = createServer((request, response) => {
  const chunks: Buffer[] = []

  request.on('data', (chunk: Buffer) => chunks.push(chunk))
  request.on('end', () => {
    received.push({
      body: Buffer.concat(chunks).toString('utf8'),
      headers: request.headers,
      path: request.url ?? '',
    })
    response.writeHead(200, {
      'content-type': 'application/json',
      'request-id': `gen-${String(received.length)}`,
      'set-cookie': 'openrouter-session=1; Path=/; HttpOnly',
    })
    response.end(JSON.stringify({ model: MODEL, type: 'message' }))
  })
})

const portOf = (server: Server): number => (server.address() as AddressInfo).port

const listening = async (server: Server): Promise<number> => {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')

  return portOf(server)
}

const vacatedPort = async (): Promise<number> => {
  const probe = createServer()
  const port = await listening(probe)

  probe.close()
  await once(probe, 'close')

  return port
}

let relayPort = 0

let stopRelay = (): void => {}

beforeAll(async () => {
  const [openRouterPort, port] = await Promise.all([
    listening(openRouter),
    vacatedPort(),
  ])

  relayPort = port

  const relay = spawn(
    process.execPath,
    [fileURLToPath(new URL('model-relay.mts', import.meta.url))],
    {
      env: {
        OPENROUTER_API_KEY: RELAY_KEY,
        PATH: process.env.PATH,
        RELAY_MODEL: MODEL,
        RELAY_PORT: String(relayPort),
        RELAY_UPSTREAM: `http://127.0.0.1:${String(openRouterPort)}`,
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    }
  )

  stopRelay = () => {
    relay.kill()
  }

  const started = Promise.withResolvers<void>()

  relay.stdout.on('data', (chunk: Buffer) => {
    if (chunk.toString('utf8').includes('model relay listening')) {
      started.resolve()
    }
  })
  relay.once('exit', (code) => {
    started.reject(new Error(`the relay exited with ${String(code)}`))
  })

  await started.promise
})

afterAll(() => {
  stopRelay()
  openRouter.close()
})

const send = async ({
  headers = {},
  parts,
}: {
  headers?: Readonly<Record<string, string>>
  parts: readonly string[]
}): Promise<Answer> => {
  const request = httpRequest({
    headers: {
      authorization: `Bearer ${AGENT_TOKEN}`,
      'content-type': 'application/json',
      ...headers,
    },
    host: '127.0.0.1',
    method: 'POST',
    path: '/v1/messages?beta=true',
    port: relayPort,
  })

  for (const part of parts.slice(0, -1)) {
    request.write(part)
  }

  request.end(parts.at(-1))

  const [response] = (await once(request, 'response')) as [IncomingMessage]
  const chunks: Buffer[] = []

  for await (const chunk of response) {
    chunks.push(Buffer.from(chunk))
  }

  return {
    body: Buffer.concat(chunks).toString('utf8'),
    headers: response.headers,
    status: response.statusCode ?? 0,
  }
}

const callOn = (fields: Readonly<Record<string, unknown>>): string =>
  JSON.stringify({
    max_tokens: 64,
    messages: [{ content: 'Read the home page.', role: 'user' }],
    model: MODEL,
    ...fields,
  })

test("a call on the relay's model that arrives in chunks with hop-by-hop headers reaches OpenRouter on the relay's key alone, without those headers", async () => {
  const before = received.length
  const body = callOn({})

  const answer = await send({
    headers: {
      'anthropic-version': '2023-06-01',
      'keep-alive': 'timeout=5',
      'proxy-connection': 'keep-alive',
      te: 'trailers',
      'x-api-key': AGENT_TOKEN,
    },
    parts: [body.slice(0, 20), body.slice(20)],
  })

  expect(answer.status).toBe(200)
  expect(answer.headers['request-id']).toBe(`gen-${String(before + 1)}`)
  expect(received.slice(before)).toEqual([
    {
      body,
      headers: expect.objectContaining({
        'anthropic-version': '2023-06-01',
        authorization: `Bearer ${RELAY_KEY}`,
      }),
      path: '/v1/messages?beta=true',
    },
  ])

  const [call] = received.slice(before)

  for (const name of [
    'keep-alive',
    'proxy-connection',
    'te',
    'transfer-encoding',
    'x-api-key',
  ]) {
    expect(call?.headers, `${name} reached OpenRouter`).not.toHaveProperty(name)
  }
})

test.each([
  { name: 'cookie', value: 'session=agent' },
  { name: 'cdn-loop', value: 'cloudflare' },
  { name: 'forwarded', value: 'for=203.0.113.9' },
  { name: 'true-client-ip', value: '203.0.113.9' },
  { name: 'x-real-ip', value: '203.0.113.9' },
  { name: 'cf-connecting-ip', value: '203.0.113.9' },
  { name: 'cf-ray', value: '0123456789abcdef-IAD' },
  { name: 'x-forwarded-for', value: '203.0.113.9' },
  { name: 'x-forwarded-host', value: 'relay.test' },
  { name: 'x-vercel-id', value: 'iad1::0123' },
])(
  "a call on the relay's model that carries the $name header reaches OpenRouter without it, and with the agent's protocol headers",
  async ({ name, value }) => {
    const before = received.length

    const answer = await send({
      headers: { 'anthropic-version': '2023-06-01', [name]: value },
      parts: [callOn({})],
    })

    expect(answer.status).toBe(200)

    const [call, ...more] = received.slice(before)

    expect(more).toEqual([])
    expect(call?.headers['anthropic-version']).toBe('2023-06-01')
    expect(call?.headers).not.toHaveProperty(name)
  }
)

test("OpenRouter's answer reaches the agent with its request id but without the cookie OpenRouter set", async () => {
  const before = received.length

  const answer = await send({ parts: [callOn({})] })

  expect(answer.status).toBe(200)
  expect(answer.headers['request-id']).toBe(`gen-${String(before + 1)}`)
  expect(answer.headers).not.toHaveProperty('set-cookie')
})

const isRefused = async (body: string): Promise<void> => {
  const before = received.length

  const answer = await send({ parts: [body] })

  expect(answer.status).toBe(403)
  expect(JSON.parse(answer.body).error.type).toBe('permission_error')
  expect(received.slice(before)).toEqual([])
}

test.each([
  { model: 'another-model', what: 'another model' },
  { model: `${MODEL}:nitro`, what: "the relay's model on pricier endpoints" },
  { model: undefined, what: 'no model' },
])(
  'the relay refuses a call on $what, and it never reaches OpenRouter',
  async ({ model }) => {
    await isRefused(callOn({ model }))
  }
)

test.each([
  { fields: { models: [MODEL, 'another-model'] }, what: 'other models to try' },
  {
    fields: { fallbacks: [{ model: 'another-model' }] },
    what: 'fallback models',
  },
  { fields: { preset: 'another-preset' }, what: 'a preset' },
  { fields: { route: 'fallback' }, what: 'a route' },
  { fields: { provider: { order: ['another-provider'] } }, what: 'a provider' },
  { fields: { plugins: [{ id: 'web' }] }, what: 'a plugin' },
  { fields: { transforms: ['middle-out'] }, what: 'a transform' },
  {
    fields: { web_search_options: { search_context_size: 'high' } },
    what: 'web search options',
  },
  {
    fields: { deferred_tools: { protocol: 'v1' } },
    what: "OpenRouter's deferred tools",
  },
  {
    fields: {
      stop_server_tools_when: [{ step_count: 5, type: 'step_count_is' }],
    },
    what: 'a server tool loop',
  },
  { fields: { max_tool_calls: 8 }, what: 'a server tool call budget' },
  {
    fields: {
      mcp_servers: [{ name: 'remote', type: 'url', url: 'https://mcp.test' }],
    },
    what: 'remote MCP servers',
  },
  { fields: { container: 'container-1' }, what: 'a code container' },
  {
    fields: { safeguards: [{ type: 'dangerous_tool_use' }] },
    what: 'a server-side safeguard',
  },
  { fields: { speed: 'fast' }, what: 'fast speed' },
  { fields: { service_tier: 'priority' }, what: 'the priority tier' },
  { fields: { service_tier: 'flex' }, what: 'the flex tier' },
  { fields: { service_tier: 'auto' }, what: 'priority capacity when free' },
  { fields: { inference_geo: 'us' }, what: 'US-only inference' },
])(
  'the relay refuses a call on its own model that asks for $what, and it never reaches OpenRouter',
  async ({ fields }) => {
    await isRefused(callOn(fields))
  }
)

const AGENT_TOOL = {
  description: 'Run a shell command.',
  input_schema: { properties: { command: { type: 'string' } }, type: 'object' },
  name: 'Bash',
}

test.each([
  {
    tools: [AGENT_TOOL, { name: 'web_search', type: 'openrouter:web_search' }],
    what: "OpenRouter's web search beside the agent's tool",
  },
  {
    tools: [AGENT_TOOL, { name: 'web_fetch', type: 'openrouter:web_fetch' }],
    what: "OpenRouter's web fetch beside the agent's tool",
  },
  {
    tools: [AGENT_TOOL, { name: 'web_search', type: 'web_search_20250305' }],
    what: "Anthropic's web search beside the agent's tool",
  },
  {
    tools: [
      AGENT_TOOL,
      { model: 'another-model', name: 'advisor', type: 'advisor_20260301' },
    ],
    what: "an advisor on another model beside the agent's tool",
  },
  {
    tools: { type: 'openrouter:web_search' },
    what: 'a server tool given as an object instead of a list',
  },
])(
  'the relay refuses a call whose tools hold $what, and it never reaches OpenRouter',
  async ({ tools }) => {
    await isRefused(callOn({ tools }))
  }
)

test("a call shaped as the box's Claude Code sends it, with its own tools and the standard speed, tier, and region spelled out, reaches OpenRouter unchanged", async () => {
  const before = received.length
  const body = callOn({
    context_management: { edits: [{ type: 'clear_thinking_20251015' }] },
    inference_geo: 'global',
    metadata: { user_id: 'agent-session' },
    output_config: { effort: 'medium' },
    service_tier: 'standard',
    speed: 'standard',
    stream: true,
    system: [{ text: 'You review a website.', type: 'text' }],
    thinking: { type: 'adaptive' },
    tools: [
      AGENT_TOOL,
      { ...AGENT_TOOL, defer_loading: true, name: 'DeferredTool' },
      { ...AGENT_TOOL, name: 'CustomTool', type: 'custom' },
    ],
  })

  const answer = await send({ parts: [body] })

  expect(answer.status).toBe(200)
  expect(received.slice(before).map((call) => call.body)).toEqual([body])
})
