// src/terminal-glossary.ts
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
var TERMINFO_HOST = "https://terminfo.dev";
function loadTerminalGlossary(glossaryPath) {
  const candidates = glossaryPath ? [glossaryPath] : [
    join(dirname(import.meta.dirname ?? ""), "..", "..", "..", "terminfo.dev", "content", "glossary.json"),
    join(dirname(import.meta.dirname ?? ""), "..", "..", "terminfo.dev", "content", "glossary.json")
  ];
  for (const path of candidates) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8"));
      const entities = [];
      for (const [term, entry] of Object.entries(raw)) {
        const href = entry.link ? `${TERMINFO_HOST}${entry.link}` : undefined;
        entities.push({
          term,
          href,
          tooltip: `${entry.expansion} — ${entry.description}`,
          external: true
        });
      }
      return entities;
    } catch {
      continue;
    }
  }
  return [];
}
export {
  loadTerminalGlossary
};
