import { describe, expect, it, vi } from "vitest"
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
    // Parser logs a warning for invalid JSON via loggily — silence it so
    // the test-harness console-quiet check doesn't flag it. The behavior
    // we're verifying is that the parser doesn't throw and still emits
    // the valid line that follows the bad one.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const out: JsonRpcMessage[] = []
      const parse = createLineParser((m) => out.push(m))
      parse(Buffer.from('not-json\n{"jsonrpc":"2.0","id":1,"method":"a"}\n'))
      expect(out).toHaveLength(1)
      expect((out[0] as { method: string }).method).toBe("a")
      // Sanity-check the warning fired with the bad input — we want the
      // log behavior covered, not just suppressed.
      expect(warnSpy).toHaveBeenCalled()
      const firstCall = warnSpy.mock.calls[0]?.join(" ") ?? ""
      expect(firstCall).toContain("not-json")
    } finally {
      warnSpy.mockRestore()
    }
  })
})
