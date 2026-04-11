# vitest-silvery-dots

Streaming dot reporter for Vitest, built with Silvery React terminal UI.

Renders test results as colored dots with a live progress bar, slow test breakdown, and console output capture — all through silvery components. Zero manual ANSI.

## Install

```bash
npm install vitest-silvery-dots
```

## Usage

In your `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    reporters: ["vitest-silvery-dots"],
  },
})
```

## What It Shows

- **Dot stream** — one dot per test: `·` pass, `x` fail, `-` skip, `*` pending, `!` noisy (console output)
- **Slow test dots** — pass dots scale from `·` to `•` to `●` based on duration relative to threshold
- **Live progress** — file count, pass/fail/skip tallies, elapsed time
- **Slow test report** — top 20 slowest tests with durations (when `--showSlow`)
- **Console capture** — test console output shown inline, noisy tests flagged
- **Performance JSON** — optional `--perfOutput` writes per-test timing data

## Options

```ts
reporters: [["vitest-silvery-dots", {
  slowThreshold: 500,      // ms — tests slower than this get bigger dots (default: 500)
  showSlow: true,          // show slow test breakdown at end
  perfOutput: "perf.json", // write per-test timing data
  symbols: ["·", "•", "●"], // dot characters for fast → slow
}]]
```

## Peer Dependencies

- `vitest` >= 4.0.0
- `react` >= 19.0.0
- `@silvery/ag-react` >= 0.1.0
- `@silvery/test` >= 0.1.0

## License

MIT
