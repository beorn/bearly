// src/validate.ts
import { existsSync } from "node:fs";
import { join } from "node:path";
function validateGlossary(entities, siteConfig) {
  const broken = [];
  let withLinks = 0;
  let tooltipOnly = 0;
  let external = 0;
  for (const entity of entities) {
    if (!entity.href) {
      tooltipOnly++;
      continue;
    }
    if (entity.external || entity.href.startsWith("http")) {
      external++;
      withLinks++;
      continue;
    }
    withLinks++;
    const cleanHref = entity.href.replace(/^\//, "").replace(/\/$/, "");
    const candidates = [`${cleanHref}.html`, `${cleanHref}/index.html`, `${cleanHref}.md`];
    const exists = candidates.some((c) => {
      const fullPath = join(siteConfig.outDir, c);
      return existsSync(fullPath);
    });
    const pageExists = siteConfig.pages.some((p) => {
      const cleanPage = p.replace(/\.md$/, "").replace(/\/index$/, "");
      return cleanPage === cleanHref || cleanPage === `${cleanHref}/index`;
    });
    if (!exists && !pageExists) {
      broken.push(`"${entity.term}" → ${entity.href}`);
    }
  }
  const result = {
    totalTerms: entities.length,
    withLinks,
    tooltipOnly,
    external,
    broken,
    pagesWithLinks: 0,
    totalPages: siteConfig.pages.length
  };
  const prefix = "[glossary]";
  console.log(`${prefix} ${entities.length} terms (${withLinks} linked, ${tooltipOnly} tooltip-only, ${external} external)`);
  if (broken.length > 0) {
    console.warn(`${prefix} ⚠ ${broken.length} broken internal links:`);
    for (const b of broken) {
      console.warn(`${prefix}   ${b}`);
    }
  } else {
    console.log(`${prefix} ✓ All internal links valid`);
  }
  return result;
}
export {
  validateGlossary
};
