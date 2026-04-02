// src/terminal-glossary.ts
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
var TERMINFO_HOST = "https://terminfo.dev";
function parseGlossary(raw) {
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
}
function loadTerminalGlossary(glossaryPath) {
  const candidates = glossaryPath ? [glossaryPath] : [
    join(dirname(import.meta.dirname ?? ""), "..", "..", "..", "terminfo.dev", "content", "glossary.json")
  ];
  for (const path of candidates) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8"));
      return parseGlossary(raw);
    } catch {
      continue;
    }
  }
  try {
    const bundledPath = join(dirname(import.meta.dirname ?? ""), "terminal-glossary-data.json");
    const raw = JSON.parse(readFileSync(bundledPath, "utf-8"));
    return parseGlossary(raw);
  } catch {
    return [];
  }
}
export {
  loadTerminalGlossary
};
