// src/ecosystem-glossary.ts
var ECOSYSTEM_PROJECTS = [
  {
    terms: ["Silvery"],
    href: "https://silvery.dev",
    tooltip: "React-based TUI framework for building terminal applications. Reconciler, components, and theme system.",
    hostname: "silvery.dev"
  },
  {
    terms: ["Termless"],
    href: "https://termless.dev",
    tooltip: "Headless terminal testing and recording. Test ANSI output, capture screenshots, record asciicast animations.",
    hostname: "termless.dev"
  },
  {
    terms: ["Flexily"],
    href: "https://beorn.codes/flexily",
    tooltip: "High-performance flexbox layout engine. Yoga-compatible with zero allocations and composable plugins.",
    hostname: "beorn.codes/flexily"
  },
  {
    terms: ["Loggily"],
    href: "https://beorn.codes/loggily",
    tooltip: "Structured logging with namespace filtering, spans, and zero-overhead conditional logging.",
    hostname: "beorn.codes/loggily"
  },
  {
    terms: ["terminfo.dev"],
    href: "https://terminfo.dev",
    tooltip: "Comprehensive terminal feature database. 148 features across 10+ terminals with probe-based testing.",
    hostname: "terminfo.dev"
  },
  {
    terms: ["mdtest"],
    href: "https://github.com/beorn/mdtest",
    tooltip: "Markdown-driven test specifications. Write tests as documentation.",
    hostname: "github.com/beorn/mdtest"
  },
  {
    terms: ["Vimonkey"],
    href: "https://github.com/beorn/vimonkey",
    tooltip: "Vitest monkey-patching utilities for test isolation and mocking.",
    hostname: "github.com/beorn/vimonkey"
  }
];
function loadEcosystemGlossary(options) {
  const exclude = new Set(options?.exclude ?? []);
  const entities = [];
  for (const project of ECOSYSTEM_PROJECTS) {
    if (exclude.has(project.hostname))
      continue;
    for (const term of project.terms) {
      entities.push({
        term,
        href: project.href,
        tooltip: project.tooltip,
        external: true
      });
    }
  }
  return entities;
}
export {
  loadEcosystemGlossary
};
