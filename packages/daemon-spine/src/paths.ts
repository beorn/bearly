/**
 * Socket path discovery — XDG-aware resolution for daemon and peer sockets.
 *
 * Priority for the main daemon socket: explicit arg > TRIBE_SOCKET env >
 * `$XDG_RUNTIME_DIR/tribe.sock` > `$HOME/.local/share/tribe/tribe.sock`.
 *
 * Peer sockets (direct proxy-to-proxy) are derived from a session id and
 * always live in the same XDG runtime / share dir as the main socket.
 */

import { resolve } from "node:path"

/** Resolve daemon socket path. Priority: flag > env > user-level (default) */
export function resolveSocketPath(socketArg?: string): string {
  if (socketArg) return socketArg
  if (process.env.TRIBE_SOCKET) return process.env.TRIBE_SOCKET

  const xdg = process.env.XDG_RUNTIME_DIR
  return xdg ? resolve(xdg, "tribe.sock") : resolve(process.env.HOME ?? "/tmp", ".local/share/tribe/tribe.sock")
}

/** Resolve peer socket path for direct proxy-to-proxy connections */
export function resolvePeerSocketPath(sessionId: string): string {
  const xdg = process.env.XDG_RUNTIME_DIR
  const dir = xdg ?? resolve(process.env.HOME ?? "/tmp", ".local/share/tribe")
  return resolve(dir, `s-${sessionId.slice(0, 12)}.sock`)
}
