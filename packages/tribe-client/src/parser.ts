/**
 * Line-delimited JSON parser — accepts arbitrary chunk boundaries and emits
 * one message per complete `\n`-terminated JSON line. Incomplete trailing
 * lines are buffered until the next chunk completes them.
 */

import { createLogger } from "loggily"
import type { JsonRpcMessage } from "./rpc.ts"

const log = createLogger("tribe-client:parser")

export function createLineParser(
  onMessage: (msg: JsonRpcMessage) => void,
  // Optional seam for invalid lines. Always warned via loggily; `onInvalid` lets
  // callers (and tests) observe the bad input explicitly without depending on the
  // logger's sink wiring (see tribe-client parser.test.ts / km 19471).
  onInvalid?: (line: string, error: unknown) => void,
): (chunk: Buffer) => void {
  let buffer = ""
  return (chunk: Buffer) => {
    buffer += chunk.toString()
    const lines = buffer.split("\n")
    buffer = lines.pop()! // Keep incomplete line in buffer
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        onMessage(JSON.parse(trimmed) as JsonRpcMessage)
      } catch (error) {
        log.warn?.(`Invalid JSON: ${trimmed.slice(0, 100)}`)
        onInvalid?.(trimmed, error)
      }
    }
  }
}
