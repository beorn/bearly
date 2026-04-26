import { describe, expect, it } from "vitest"
import {
  isNotification,
  isRequest,
  isResponse,
  makeError,
  makeNotification,
  makeRequest,
  makeResponse,
} from "../src/rpc.ts"

describe("JSON-RPC framers", () => {
  it("makeRequest produces line-terminated JSON-RPC 2.0 request", () => {
    const s = makeRequest(7, "ping", { foo: 1 })
    expect(s.endsWith("\n")).toBe(true)
    const parsed = JSON.parse(s)
    expect(parsed).toEqual({ jsonrpc: "2.0", id: 7, method: "ping", params: { foo: 1 } })
  })

  it("makeResponse / makeError produce mutually exclusive payloads", () => {
    const ok = JSON.parse(makeResponse(7, { value: 1 }))
    expect(ok).toEqual({ jsonrpc: "2.0", id: 7, result: { value: 1 } })
    const err = JSON.parse(makeError(7, -32601, "Method not found"))
    expect(err.error).toEqual({ code: -32601, message: "Method not found", data: undefined })
    expect(err).not.toHaveProperty("result")
  })

  it("makeNotification omits the id", () => {
    const parsed = JSON.parse(makeNotification("event", { a: 1 }))
    expect(parsed).toEqual({ jsonrpc: "2.0", method: "event", params: { a: 1 } })
    expect(parsed).not.toHaveProperty("id")
  })
})

describe("JSON-RPC type guards", () => {
  it("isRequest matches messages with both id and method", () => {
    expect(isRequest({ jsonrpc: "2.0", id: 1, method: "a" })).toBe(true)
    expect(isRequest({ jsonrpc: "2.0", id: 1, result: 1 })).toBe(false)
    expect(isRequest({ jsonrpc: "2.0", method: "a" })).toBe(false)
  })

  it("isResponse matches messages with id but no method", () => {
    expect(isResponse({ jsonrpc: "2.0", id: 1, result: 1 })).toBe(true)
    expect(isResponse({ jsonrpc: "2.0", id: 1, method: "a" })).toBe(false)
  })

  it("isNotification matches messages with method but no id", () => {
    expect(isNotification({ jsonrpc: "2.0", method: "a" })).toBe(true)
    expect(isNotification({ jsonrpc: "2.0", id: 1, method: "a" })).toBe(false)
  })
})
