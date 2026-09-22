import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { expect } from 'vitest'

export const httpMcpSecrets = {
  provider: 'synthetic-provider-only-7Kj9',
  bearer: 'synthetic-mcp-bearer-4Yp8',
  header: 'synthetic-mcp-header-3Qw6',
} as const
export const httpMcpKinds = ['bearer', 'headers', 'none'] as const
export type HttpMcpKind = (typeof httpMcpKinds)[number]
export const httpMcpLiteral = 'literal $HOME {{unknown}} ; value'

/** Stateful local MCP peer: JSON and SSE responses on the same Streamable HTTP endpoint. */
export function httpMcpFixture() {
  const sessions = new Map<string, HttpMcpKind>()
  const methods: { kind: HttpMcpKind; method: string }[] = []
  const calls: { kind: HttpMcpKind; behavior: string }[] = []
  const errors: unknown[] = []
  const requests: { kind: HttpMcpKind; verb: string; rejected: boolean }[] = []
  let failure: 'none' | 'unauthorized' | 'list-error' = 'none'
  const handler = async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const kind = request.url?.slice('/mcp/'.length) as HttpMcpKind
      expect(httpMcpKinds).toContain(kind)
      expect(JSON.stringify(request.headers)).not.toContain(httpMcpSecrets.provider)
      expect(request.headers['x-literal']).toBe(httpMcpLiteral)
      expect(request.headers.authorization).toBe(
        kind === 'bearer' ? `Bearer ${httpMcpSecrets.bearer}` : undefined,
      )
      expect(request.headers['x-private']).toBe(kind === 'none' ? undefined : httpMcpSecrets.header)
      requests.push({ kind, verb: request.method!, rejected: failure === 'unauthorized' })
      if (failure === 'unauthorized') {
        response.writeHead(401, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: 'Fixture authentication required' }))
        return
      }
      let body = ''
      for await (const part of request) {
        body += String(part)
        if (body.length > 1_048_576) throw new Error('MCP fixture request limit')
      }
      const message = body ? JSON.parse(body) : null
      let session = request.headers['mcp-session-id'] as string | undefined
      if (request.method === 'POST' && message?.method === 'initialize') {
        expect(session).toBeUndefined()
        expect(message.params.protocolVersion).toBeTruthy()
        session = randomUUID()
        sessions.set(session, kind)
      } else {
        expect(session && sessions.get(session)).toBe(kind)
        expect(request.headers['mcp-protocol-version']).toBe('2025-06-18')
      }
      if (request.method === 'GET' || request.method === 'DELETE') {
        response.writeHead(405, { Allow: 'POST' }).end()
        return
      }
      expect(request.method).toBe('POST')
      expect(request.headers.accept).toContain('application/json')
      expect(request.headers.accept).toContain('text/event-stream')
      expect(request.headers['content-type']).toContain('application/json')
      expect(message.jsonrpc).toBe('2.0')
      methods.push({ kind, method: message.method })
      if (message.id === undefined) {
        expect(['notifications/initialized', 'notifications/cancelled']).toContain(message.method)
        response.writeHead(202).end()
        return
      }
      let result: unknown
      let error: { code: number; message: string } | undefined
      switch (message.method) {
        case 'initialize':
          result = {
            protocolVersion: '2025-06-18',
            serverInfo: { name: 'AgentMatrix local HTTP fixture', version: '1.0.0' },
            capabilities: { tools: {} },
          }
          break
        case 'tools/list':
          if (failure === 'list-error') {
            error = { code: -32603, message: 'HTTP_MCP_LIST_ERROR' }
            break
          }
          result = {
            tools: [
              {
                name: `http_${kind}`,
                description: `AgentMatrix ${kind} HTTP fixture`,
                inputSchema: {
                  type: 'object',
                  properties: { behavior: { type: 'string' } },
                  required: ['behavior'],
                },
              },
            ],
          }
          break
        case 'tools/call': {
          expect(message.params.name).toBe(`http_${kind}`)
          const behavior = message.params.arguments.behavior
          expect(['success', 'tool-error', 'rpc-error']).toContain(behavior)
          calls.push({ kind, behavior })
          if (behavior === 'rpc-error')
            error = { code: -32603, message: `HTTP_MCP_RPC_ERROR ${httpMcpSecrets.header}` }
          else
            result = {
              content: [
                {
                  type: 'text',
                  text:
                    behavior === 'tool-error'
                      ? `HTTP_MCP_TOOL_ERROR ${httpMcpSecrets.header}`
                      : `HTTP_MCP_RESULT_${kind}`,
                },
              ],
              isError: behavior === 'tool-error',
            }
          break
        }
        default:
          error = { code: -32601, message: 'Method not found' }
      }
      const reply = JSON.stringify({ jsonrpc: '2.0', id: message.id, result, error })
      response.writeHead(200, {
        'Mcp-Session-Id': session!,
        'Content-Type': kind === 'headers' ? 'text/event-stream' : 'application/json',
      })
      response.end(kind === 'headers' ? `event: message\ndata: ${reply}\n\n` : reply)
    } catch (error) {
      errors.push(error)
      if (!response.headersSent) response.writeHead(500)
      response.end()
    }
  }
  return {
    handler,
    methods,
    calls,
    errors,
    requests,
    fail(value: typeof failure) {
      failure = value
    },
  }
}
