/**
 * The one runtime boundary for SQL-taking Database methods.
 * The static guard validates literals through this same assertion.
 */
const SINGLE_STATEMENT = /^[^;]*;?$/u
// A bounded trigger exception, not a SQL parser. CASE expressions are admitted as
// one non-nested unit; an unrelated END cannot absorb a second statement's tail.
const TRIGGER_STATEMENT =
  /^\s*CREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b[^;]*?\bBEGIN\b(?:(?:\bCASE\b(?:(?!\b(?:CASE|END)\b)[\s\S])*\bEND\b)|(?!(?:\bCASE\b|\bEND\b))[\s\S])*\bEND;?$/iu
const REQUIRED = "sqlite-single-statement-required"

/**
 * Return the original SQL when it satisfies the single-statement boundary.
 * A terminator must be the final character; trigger-body semicolons are allowed.
 * SQL syntax and parameter binding remain SQLite's responsibility.
 */
export function assertSingleStatement(sql: string): string {
  if (typeof sql === "string" && (SINGLE_STATEMENT.test(sql) || TRIGGER_STATEMENT.test(sql))) return sql
  const position = typeof sql === "string" ? sql.indexOf(";") : -1
  throw Object.assign(
    new TypeError(
      `SQL: ${REQUIRED}; expected one statement with no semicolon except an exact final terminator or a CREATE TRIGGER body; first semicolon at ${position}`,
    ),
    { code: REQUIRED },
  )
}
