// The bug, unrouted: once the stdout stream is used, a large console.log loses its tail on a slow pipe (hh 27071).
process.stdout.write("")
console.log("x".repeat(300_000))
process.exitCode = 4
