/**
 * The one runtime boundary for SQL-taking Database methods.
 * The static guard validates literals through this same assertion.
 */
const SINGLE_STATEMENT = /^[^;]*;?$/u
const REQUIRED = "sqlite-single-statement-required"

interface Token {
  kind: "word" | "quoted" | "punctuation"
  text: string
  start: number
  end: number
}

function refuse(reason: string): never {
  throw Object.assign(new TypeError(`SQL: ${REQUIRED}; ${reason}`), { code: REQUIRED })
}

/** SQLite lexical forms only: no statement grammar, AST or splitting. */
function* tokens(sql: string): Generator<Token, undefined, unknown> {
  let at = 0
  while (at < sql.length) {
    const start = at
    const char = sql.charAt(at)
    if (/\s/u.test(char)) {
      at++
      continue
    }
    if (sql.startsWith("--", at)) {
      const newline = sql.indexOf("\n", at + 2)
      at = newline < 0 ? sql.length : newline + 1
      continue
    }
    if (sql.startsWith("/*", at)) {
      const end = sql.indexOf("*/", at + 2)
      if (end < 0) refuse(`unterminated block comment at ${start}`)
      at = end + 2
      continue
    }
    if (char === "'" || char === '"' || char === "`" || char === "[") {
      const close = char === "[" ? "]" : char
      at++
      let closed = false
      while (at < sql.length) {
        if (sql[at++] !== close) continue
        if (char !== "[" && sql[at] === close) {
          at++
          continue
        }
        closed = true
        break
      }
      if (!closed) refuse(`unterminated ${char === "'" ? "string" : "quoted identifier"} at ${start}`)
      yield { kind: "quoted", text: sql.slice(start, at), start, end: at }
      continue
    }
    const word = sql.slice(at).match(/^[\p{L}\p{N}\p{M}_$]+/u)?.[0]
    if (word !== undefined) {
      at += word.length
      // SQLite keywords fold ASCII only; Unicode identifiers are not keywords.
      const text = /^[A-Za-z]+$/u.test(word) ? word.toUpperCase() : word
      yield { kind: "word", text, start, end: at }
    } else {
      at++
      yield { kind: "punctuation", text: char, start, end: at }
    }
  }
}

/**
 * Return the original SQL when it satisfies the single-statement boundary.
 * A terminator must be the final character; trigger-body semicolons are allowed.
 * SQL syntax and parameter binding remain SQLite's responsibility.
 */
export function assertSingleStatement(sql: string): string {
  if (typeof sql !== "string") refuse("expected SQL text")
  const walk = tokens(sql)
  const first = walk.next().value
  let next = first?.kind === "word" && first.text === "CREATE" ? walk.next().value : undefined
  if (next?.kind === "word" && (next.text === "TEMP" || next.text === "TEMPORARY")) next = walk.next().value
  if (next?.kind !== "word" || next.text !== "TRIGGER") {
    if (SINGLE_STATEMENT.test(sql)) return sql
    refuse(`semicolon at ${sql.indexOf(";")} is not the sole exact final terminator`)
  }

  let body = false
  let cases = 0
  for (const token of walk) {
    if (!body && token.kind === "punctuation" && token.text === ";") refuse("semicolon before trigger BEGIN")
    if (token.kind !== "word") continue
    if (token.text === "CASE") {
      cases++
    } else if (token.text === "BEGIN") {
      if (body || cases !== 0) refuse(`cannot place BEGIN at ${token.start}`)
      body = true
    } else if (token.text === "END") {
      if (cases > 0) {
        cases--
        continue
      }
      if (!body) refuse(`END without trigger BEGIN at ${token.start}`)
      const suffix = walk.next().value
      if (suffix === undefined) return sql
      if (suffix.text === ";" && suffix.end === sql.length) return sql
      if (suffix.text === ";") {
        const after = walk.next().value
        refuse(
          `after trigger END: ${after?.text ?? JSON.stringify(sql.slice(suffix.end))} at ${after?.start ?? suffix.end}`,
        )
      }
      refuse(`after trigger END: ${suffix.text} at ${suffix.start}`)
    }
  }
  if (!body) refuse("trigger has no BEGIN")
  refuse(`trigger has no closing END; CASE depth ${cases}`)
}
