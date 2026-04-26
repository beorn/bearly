/**
 * Line-delimited JSON parser — accepts arbitrary chunk boundaries and emits
 * one message per complete `\n`-terminated JSON line. Incomplete trailing
 * lines are buffered until the next chunk completes them.
 */

import { createLogger } from "loggily"
import type { JsonRpcMessage } from "./rpc.ts"

const log = createLogger("daemon-spine:parser")

export function createLineParser(onMessage: (msg: JsonRpcMessage) => void): (chunk: Buffer) => void {
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
      } catch {
        log.warn?.(`Invalid JSON: ${trimmed.slice(0, 100)}`)
      }
    }
  }
}
