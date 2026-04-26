/**
 * JSON-RPC 2.0 wire protocol — types, guards, and message constructors.
 *
 * All messages are line-delimited JSON: each `make*` returns a string ending
 * in "\n" so the writer can `socket.write(makeRequest(...))` directly.
 */

export type JsonRpcRequest = {
  jsonrpc: "2.0"
  id: number | string
  method: string
  params?: Record<string, unknown>
}

export type JsonRpcResponse = {
  jsonrpc: "2.0"
  id: number | string
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export type JsonRpcNotification = {
  jsonrpc: "2.0"
  method: string
  params?: Record<string, unknown>
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification

export function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return "method" in msg && "id" in msg
}

export function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return "id" in msg && !("method" in msg)
}

export function isNotification(msg: JsonRpcMessage): msg is JsonRpcNotification {
  return "method" in msg && !("id" in msg)
}

export function makeRequest(id: number | string, method: string, params?: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"
}

export function makeResponse(id: number | string, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"
}

export function makeError(id: number | string, code: number, message: string, data?: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message, data } }) + "\n"
}

export function makeNotification(method: string, params?: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"
}
