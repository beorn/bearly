/**
 * @failure Native SQLite receives unsafe tails, silently hides errors, or drops subsequent statements.
 * @level l0
 * @consumer SQLite callers validating dynamic SQL through the public assertion.
 * @testonly none
 * The guard CLI owns static call-site enforcement; this suite owns runtime SQL validation.
 */
import { describe, expect, test } from "vitest"
import { Database } from "bun:sqlite"
import { assertSingleStatement } from "../src/index.ts"

describe("assertSingleStatement", () => {
  test.each([
    "SELECT 1",
    "SELECT 1;",
    "\nSELECT 1\n",
    "CREATE TRIGGER changed AFTER INSERT ON t BEGIN SELECT 1; END",
    "CREATE TEMP TRIGGER changed AFTER INSERT ON t BEGIN SELECT 1; SELECT 2; END;",
    "CREATE TRIGGER changed AFTER INSERT ON t BEGIN SELECT CASE WHEN 1 THEN 2 ELSE 3 END; END;",
  ])("preserves allowed SQL text: %s", (sql) => {
    expect(assertSingleStatement(sql)).toBe(sql)
  })

  test.each([
    "\nINSERT INTO t VALUES (1);\n",
    "SELECT 1; SELECT 2",
    "SELECT 1; SELECT 2;",
    "SELECT 1; ",
    "SELECT ';'",
    "CREATE TRIGGER changed AFTER INSERT ON t BEGIN SELECT 1; END;\n",
    "CREATE TRIGGER changed AFTER INSERT ON t BEGIN SELECT 1; END; SELECT 2",
    "CREATE TRIGGER changed AFTER INSERT ON t BEGIN SELECT 1; END; SELECT 2; END;",
  ])("rejects unsafe SQL text: %s", (sql) => {
    expect(() => assertSingleStatement(sql)).toThrow(/SQL:.*sqlite-single-statement-required/)
  })

  test("keeps native constraint failures loud after runtime validation", () => {
    const db = new Database(":memory:")
    try {
      db.run("CREATE TABLE t (x INTEGER PRIMARY KEY)")
      db.run("INSERT INTO t VALUES (1)")
      expect(() => db.prepare(assertSingleStatement("INSERT INTO t VALUES (?)")).run(1)).toThrow(/UNIQUE/)
      expect(db.query("SELECT count(*) AS count FROM t").get()).toEqual({ count: 1 })
    } finally {
      db.close()
    }
  })
})
