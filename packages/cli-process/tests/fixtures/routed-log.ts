// The same output through the package: routed console, drained exit, the real exit code.
import { routeConsoleToStreams, runCliProcess } from "../../src/index.ts"

routeConsoleToStreams()
await runCliProcess("fixture", () => {
  process.stdout.write("")
  console.log("x".repeat(300_000))
  return 4
})
