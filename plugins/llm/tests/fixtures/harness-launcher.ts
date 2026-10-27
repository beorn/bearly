/** @testonly Fixture launcher for the configured module boundary. */
import { vi } from "vitest"

export const nativeRunner = vi.fn(async () => ({ exitCode: 0, timedOut: false, ms: 5, stdout: "harness opinion" }))
export const agCodeRunner = vi.fn(() => nativeRunner)
export const harnessLegLaunch = vi.fn(
  (input: {
    harness: "claude" | "codex"
    account: string
    model: string
    prompt: string
    env?: NodeJS.ProcessEnv
  }) => ({
    argv: ["fixture-launch", input.harness, input.account, input.model, input.prompt],
    env: { FIXTURE_LAUNCH: input.harness },
    notes: input.harness === "codex" ? ["fixture codex launch"] : [],
  }),
)
