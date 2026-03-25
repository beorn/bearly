# tty

Headless terminal testing for Claude Code. Spawn PTY sessions, send keystrokes, capture screenshots and text — all via MCP tools.

Built on [Termless](https://github.com/beorn/termless) (Bun PTY + xterm.js) with lazy Playwright for screenshot rendering.

## Install

```bash
claude plugin install tty@beorn-tools
```

## Architecture

```
MCP Server → Termless (PTY + xterm.js) → target process
           → Playwright (lazy, screenshots only)
```

- **Termless** spawns the target process via Bun PTY and emulates the terminal with xterm.js
- **Playwright** only launches for `screenshot` (renders terminal to PNG)
- Text and keystroke operations never touch a browser

## Tools

| Tool                   | What                                     |
| ---------------------- | ---------------------------------------- |
| `mcp__tty__start`      | Start PTY session with terminal emulator |
| `mcp__tty__stop`       | Close session and kill process           |
| `mcp__tty__press`      | Press keyboard key(s)                    |
| `mcp__tty__type`       | Type text into terminal                  |
| `mcp__tty__screenshot` | Capture screenshot (PNG)                 |
| `mcp__tty__text`       | Get terminal text content                |
| `mcp__tty__wait`       | Wait for text or terminal stability      |
| `mcp__tty__list`       | List active sessions                     |

## Example

```
mcp__tty__start({ command: ["vim", "test.txt"] })
mcp__tty__wait({ sessionId, for: "test.txt" })
mcp__tty__type({ sessionId, text: "iHello, world!" })
mcp__tty__press({ sessionId, key: "Escape" })
mcp__tty__screenshot({ sessionId })
mcp__tty__stop({ sessionId })
```

## License

MIT
