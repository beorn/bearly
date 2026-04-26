import { describe, expect, it } from "vitest"
import { createLineParser } from "../src/parser.ts"
import type { JsonRpcMessage } from "../src/rpc.ts"

describe("createLineParser", () => {
  it("emits one message per complete \\n-terminated JSON line", () => {
    const out: JsonRpcMessage[] = []
    const parse = createLineParser((m) => out.push(m))
    parse(Buffer.from('{"jsonrpc":"2.0","id":1,"method":"a"}\n{"jsonrpc":"2.0","id":2,"method":"b"}\n'))
    expect(out).toHaveLength(2)
    expect((out[0] as { method: string }).method).toBe("a")
    expect((out[1] as { method: string }).method).toBe("b")
  })

  it("buffers incomplete trailing lines until completed by a later chunk", () => {
    const out: JsonRpcMessage[] = []
    const parse = createLineParser((m) => out.push(m))
    parse(Buffer.from('{"jsonrpc":"2.0","id":1,"meth'))
    expect(out).toHaveLength(0)
    parse(Buffer.from('od":"a"}\n{"jsonrpc":"2.0","id":2,'))
    expect(out).toHaveLength(1)
    parse(Buffer.from('"method":"b"}\n'))
    expect(out).toHaveLength(2)
    expect((out[1] as { id: number }).id).toBe(2)
  })

  it("skips invalid JSON without throwing", () => {
    const out: JsonRpcMessage[] = []
    const parse = createLineParser((m) => out.push(m))
    parse(Buffer.from('not-json\n{"jsonrpc":"2.0","id":1,"method":"a"}\n'))
    expect(out).toHaveLength(1)
    expect((out[0] as { method: string }).method).toBe("a")
  })
})
