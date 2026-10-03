# @bearly/sqlite

Validate SQL text before passing it to native Database.run, exec, prepare or query.

```typescript
import { assertSingleStatement } from "@bearly/sqlite"

db.prepare(assertSingleStatement(`SELECT * FROM ${validatedTableName}`)).all()
```

The function returns the original text. It refuses semicolons except an exact
final terminator and semicolons inside a whole CREATE TRIGGER BEGIN … END body.
A newline or space after a terminator is refused. Quoted and commented semicolons
are deliberately refused outside triggers; this boundary does not parse SQL.
The trigger boundary skips SQLite strings, quoted identifiers and comments, and
counts nested CASE expressions. It refuses unterminated lexical forms, misplaced
BEGIN/END and any token after the trigger closes. Trailing comments without a
terminator are skipped; a terminator must remain the exact final character.

SQLite still checks syntax, identifiers and bindings. This assertion does not
sanitize identifiers or values; use parameter binding for values.

The package has no runtime dependencies or I/O. It ships its TypeScript source
and works independently of the monorepo in a TypeScript-capable runtime.

## Error registry

`sqlite-single-statement-required`: SQL violates the one-statement boundary.
The function throws TypeError with this code and the first semicolon position.
Pass one complete statement, remove text after its terminator, or pass a whole
trigger. It never splits SQL or supplies a default value.
