# TTY Skill

Interactive terminal app testing - MCP server with Termless (PTY + xterm.js).

**Configure in your project's `.mcp.json`:**

```json
{
  "mcpServers": {
    "tty": {
      "command": "bun",
      "args": ["vendor/bearly/tools/playwright-tty-mcp.ts"]
    }
  }
}
```

## When to Use

- Testing TUI applications visually
- Capturing terminal screenshots
- Verifying terminal rendering
- Interactive debugging of terminal apps

**Prefer headless tests** (`testEnv()`/`board.press()`) over TTY for testing logic. TTY is only for visual verification.

## Architecture

```
MCP Server → Termless (PTY + xterm.js backend) → target process
                └→ Playwright (lazy, screenshots only)
```

- **Termless** spawns the target process via Bun PTY and emulates the terminal with xterm.js
- **Playwright** is only launched lazily for `screenshot` (renders SVG to PNG)
- No ttyd, no port allocation, no external processes

## Tools

| Tool                   | Description                                         |
| ---------------------- | --------------------------------------------------- |
| `mcp__tty__start`      | Start PTY session with xterm.js terminal emulator   |
| `mcp__tty__stop`       | Close PTY session and kill process                  |
| `mcp__tty__press`      | Press keyboard key(s)                               |
| `mcp__tty__type`       | Type text into terminal                             |
| `mcp__tty__screenshot` | Capture screenshot (launches browser for rendering) |
| `mcp__tty__text`       | Get terminal text content                           |
| `mcp__tty__wait`       | Wait for text to appear or terminal stability       |
| `mcp__tty__list`       | List active sessions                                |

## Workflow

```
1. mcp__tty__start({ command: ["bun", "km", "view", "/path"] })
   -> { sessionId: "abc123" }

2. mcp__tty__wait({ sessionId: "abc123", for: "BOARD VIEW" })
   -> { success: true }

3. mcp__tty__press({ sessionId: "abc123", key: "j" })
   -> { success: true }

4. mcp__tty__screenshot({ sessionId: "abc123" })
   -> Returns PNG image

5. mcp__tty__stop({ sessionId: "abc123" })
   -> { success: true }
```

## Key Formats

Use Playwright key formats for `mcp__tty__press`:

| Key           | Format                                             |
| ------------- | -------------------------------------------------- |
| Enter         | `Enter`                                            |
| Escape        | `Escape`                                           |
| Arrow keys    | `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`  |
| Tab           | `Tab`                                              |
| Backspace     | `Backspace`                                        |
| Single char   | `j`, `k`, `q`, etc.                                |
| With modifier | `Control+c`, `Control+d`, `Shift+Tab`, `Alt+Enter` |

## Tool Parameters

### start

```typescript
{
  command: string[]              // Required: ["bun", "km", "view", "/path"]
  env?: Record<string, string>   // Optional: { DEBUG: "silvery:*" }
  cols?: number                  // Terminal columns (default: 120)
  rows?: number                  // Terminal rows (default: 40)
  cwd?: string                   // Working directory
  waitFor?: "content" | "stable" | string  // Wait condition
  timeout?: number               // Wait timeout in ms (default: 5000)
}
```

### screenshot

```typescript
{
  sessionId: string              // Required
  outputPath?: string            // Optional: save to file instead of base64
}
```

### wait

```typescript
{
  sessionId: string              // Required
  for?: string                   // Wait for specific text
  stable?: number                // Wait for terminal stability (ms)
  timeout?: number               // Default: 30000ms
}
```

## CLI Entry Point

For one-shot operations without the MCP server:

```bash
# Text + screenshot
bun tools/tty.ts capture --command "bun km view /path" --keys "j,j,Enter" --screenshot /tmp/out.png --text

# Text-only (no Chromium needed)
bun tools/tty.ts capture --command "bun km view /path" --wait-for "BOARD" --text
```

## Examples

### Basic Screenshot

```
mcp__tty__start({ command: ["bun", "km", "view", "/tmp/test"] })
mcp__tty__wait({ sessionId, for: "Ready" })
mcp__tty__screenshot({ sessionId })
mcp__tty__stop({ sessionId })
```

### Navigation Test

```
mcp__tty__start({ command: ["bun", "km", "view", "/path"] })
mcp__tty__wait({ sessionId, for: "BOARD VIEW" })

# Navigate down
mcp__tty__press({ sessionId, key: "j" })
mcp__tty__press({ sessionId, key: "j" })

# Check result
mcp__tty__text({ sessionId })
# -> { content: "... Item 3 selected ..." }

mcp__tty__stop({ sessionId })
```

### Multiple Sessions

```
# Start two sessions in parallel
mcp__tty__start({ command: ["app1"] })  -> session1
mcp__tty__start({ command: ["app2"] })  -> session2

# Interact with each
mcp__tty__press({ sessionId: session1, key: "q" })
mcp__tty__press({ sessionId: session2, key: "Enter" })

# Clean up
mcp__tty__stop({ sessionId: session1 })
mcp__tty__stop({ sessionId: session2 })
```

## First-Time Setup

On first `mcp__tty__screenshot`, Chromium is automatically installed to a local cache:

- Location: `vendor/tools/tools/.playwright-cache/`
- One-time installation, reused for all future sessions
- Text and key operations do NOT require Chromium

## Trigger Phrases

- "test this terminal app"
- "take a TTY screenshot"
- "interact with the terminal"
- "check if the TUI renders correctly"
- "debug the terminal output"
- "capture what the terminal shows"
