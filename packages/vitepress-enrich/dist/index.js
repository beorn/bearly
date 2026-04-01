// src/entity-engine.ts
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function escapeAttr(s) {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function compileEntities(entities) {
  const compiled = [];
  const seen = new Set;
  for (const e of entities) {
    if (seen.has(e.term))
      continue;
    seen.add(e.term);
    compiled.push({
      term: e.term,
      pattern: new RegExp(`\\b${escapeRegex(e.term)}\\b`, "g"),
      href: e.href ?? "",
      tooltip: e.tooltip ?? "",
      tooltipOnly: !e.href,
      external: e.external ?? false
    });
  }
  compiled.sort((a, b) => b.term.length - a.term.length);
  return compiled;
}
function renderEntity(original, entity) {
  const tooltip = entity.tooltip ? ` data-tooltip="${escapeAttr(entity.tooltip)}"` : "";
  if (entity.href) {
    const target = entity.external ? ' target="_blank" rel="noopener"' : "";
    return `<a href="${entity.href}" class="hover-link"${tooltip}${target}>${original}</a>`;
  }
  return `<span class="glossary-hint"${tooltip}>${original}</span>`;
}
function replaceEntities(text, entities, linkedTerms) {
  const matches = [];
  const occupied = new Set;
  for (const entity of entities) {
    if (linkedTerms?.has(entity.term))
      continue;
    entity.pattern.lastIndex = 0;
    let m;
    let matched = false;
    while ((m = entity.pattern.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      let overlap = false;
      for (let p = start;p < end; p++) {
        if (occupied.has(p)) {
          overlap = true;
          break;
        }
      }
      if (overlap)
        continue;
      if (matched)
        continue;
      matched = true;
      for (let p = start;p < end; p++)
        occupied.add(p);
      matches.push({ start, end, entity });
    }
  }
  if (matches.length === 0)
    return text;
  if (linkedTerms) {
    for (const { entity } of matches)
      linkedTerms.add(entity.term);
  }
  matches.sort((a, b) => b.start - a.start);
  let result = text;
  for (const { start, end, entity } of matches) {
    result = result.slice(0, start) + renderEntity(result.slice(start, end), entity) + result.slice(end);
  }
  return result;
}
function replaceInHtml(html, entities, linkedTerms) {
  const skipTags = /^<(a|code|h[1-6]|script|style|pre)\b/i;
  const skipClose = /^<\/(a|code|h[1-6]|script|style|pre)>/i;
  const textRegions = [];
  let i = 0;
  let skipDepth = 0;
  while (i < html.length) {
    if (html[i] === "<") {
      const tagEnd = html.indexOf(">", i);
      if (tagEnd === -1)
        break;
      const tag = html.slice(i, tagEnd + 1);
      if (skipClose.test(tag)) {
        skipDepth = Math.max(0, skipDepth - 1);
      } else if (skipTags.test(tag)) {
        skipDepth++;
      }
      i = tagEnd + 1;
    } else {
      if (skipDepth === 0) {
        const nextTag = html.indexOf("<", i);
        const end = nextTag === -1 ? html.length : nextTag;
        if (end > i)
          textRegions.push({ start: i, end });
        i = end;
      } else {
        const nextTag = html.indexOf("<", i);
        i = nextTag === -1 ? html.length : nextTag;
      }
    }
  }
  const matches = [];
  const occupied = new Set;
  for (const entity of entities) {
    if (linkedTerms?.has(entity.term))
      continue;
    let matched = false;
    for (const region of textRegions) {
      if (matched)
        break;
      const segment = html.slice(region.start, region.end);
      entity.pattern.lastIndex = 0;
      let m;
      while ((m = entity.pattern.exec(segment)) !== null) {
        const absStart = region.start + m.index;
        const absEnd = absStart + m[0].length;
        let overlap = false;
        for (let p = absStart;p < absEnd; p++) {
          if (occupied.has(p)) {
            overlap = true;
            break;
          }
        }
        if (overlap)
          continue;
        if (matched)
          continue;
        matched = true;
        for (let p = absStart;p < absEnd; p++)
          occupied.add(p);
        matches.push({ start: absStart, end: absEnd, entity });
      }
    }
  }
  if (matches.length === 0)
    return html;
  if (linkedTerms) {
    for (const { entity } of matches)
      linkedTerms.add(entity.term);
  }
  matches.sort((a, b) => b.start - a.start);
  let result = html;
  for (const { start, end, entity } of matches) {
    result = result.slice(0, start) + renderEntity(result.slice(start, end), entity) + result.slice(end);
  }
  return result;
}

// src/glossary.ts
function glossaryPlugin(md, options) {
  const entities = compileEntities(options.entities);
  md.core.ruler.push("glossary_links", (state) => {
    const linkedTerms = new Set;
    for (const blockToken of state.tokens) {
      if (blockToken.type === "html_block" && blockToken.content) {
        blockToken.content = replaceInHtml(blockToken.content, entities, linkedTerms);
        continue;
      }
      if (blockToken.type !== "inline" || !blockToken.children)
        continue;
      const blockIdx = state.tokens.indexOf(blockToken);
      let inHeading = false;
      for (let i = blockIdx - 1;i >= 0; i--) {
        if (state.tokens[i].type === "heading_open") {
          inHeading = true;
          break;
        }
        if (state.tokens[i].type === "heading_close")
          break;
      }
      if (inHeading)
        continue;
      const children = blockToken.children;
      const newChildren = [];
      let insideLink = false;
      for (const child of children) {
        if (child.type === "link_open") {
          insideLink = true;
          newChildren.push(child);
          continue;
        }
        if (child.type === "link_close") {
          insideLink = false;
          newChildren.push(child);
          continue;
        }
        if (child.type === "code_inline" || insideLink) {
          newChildren.push(child);
          continue;
        }
        if (child.type !== "text") {
          newChildren.push(child);
          continue;
        }
        const replaced = replaceEntities(child.content, entities, linkedTerms);
        if (replaced === child.content) {
          newChildren.push(child);
          continue;
        }
        const htmlToken = new state.Token("html_inline", "", 0);
        htmlToken.content = replaced;
        newChildren.push(htmlToken);
      }
      blockToken.children = newChildren;
    }
  });
}

// src/linkify.ts
function escapeAttr2(s) {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function createLinkifier(entities) {
  const compiled = compileEntities(entities);
  return function linkifyContent(text) {
    if (!text)
      return text;
    const textRegions = [];
    let i = 0;
    while (i < text.length) {
      if (text[i] === "<") {
        const tagEnd = text.indexOf(">", i);
        if (tagEnd === -1)
          break;
        const tag = text.slice(i, tagEnd + 1);
        if (tag.startsWith("<a ") || tag === "<a>") {
          const closeA = text.indexOf("</a>", tagEnd);
          i = closeA !== -1 ? closeA + 4 : tagEnd + 1;
        } else {
          i = tagEnd + 1;
        }
      } else {
        const nextTag = text.indexOf("<", i);
        const end = nextTag === -1 ? text.length : nextTag;
        if (end > i)
          textRegions.push({ start: i, end });
        i = end;
      }
    }
    const matches = [];
    const occupied = new Set;
    for (const entity of compiled) {
      for (const region of textRegions) {
        const segment = text.slice(region.start, region.end);
        entity.pattern.lastIndex = 0;
        let m;
        while ((m = entity.pattern.exec(segment)) !== null) {
          const absStart = region.start + m.index;
          const absEnd = absStart + m[0].length;
          let overlap = false;
          for (let p = absStart;p < absEnd; p++) {
            if (occupied.has(p)) {
              overlap = true;
              break;
            }
          }
          if (overlap)
            continue;
          for (let p = absStart;p < absEnd; p++)
            occupied.add(p);
          matches.push({ start: absStart, end: absEnd, entity });
        }
      }
    }
    matches.sort((a, b) => b.start - a.start);
    let result = text;
    for (const { start, end, entity } of matches) {
      const original = result.slice(start, end);
      const tooltip = entity.tooltip ? ` data-tooltip="${escapeAttr2(entity.tooltip)}"` : "";
      const target = entity.external ? ' target="_blank" rel="noopener"' : "";
      const replacement = entity.href ? `<a href="${entity.href}" class="hover-link"${tooltip}${target}>${original}</a>` : `<span class="glossary-hint"${tooltip}>${original}</span>`;
      result = result.slice(0, start) + replacement + result.slice(end);
    }
    return result;
  };
}

// src/seo.ts
function seoHead(options) {
  const head = [
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:site_name", content: options.siteName }],
    ["meta", { name: "twitter:card", content: "summary" }]
  ];
  if (options.ogImage) {
    head.push(["meta", { property: "og:image", content: options.ogImage }]);
  }
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: options.siteName,
    url: options.hostname,
    description: options.description ?? "",
    ...options.jsonLd
  };
  head.push(["script", { type: "application/ld+json" }, JSON.stringify(jsonLd)]);
  return head;
}
function seoTransformPageData(options) {
  const { hostname, siteName, description: defaultDesc } = options;
  const authorName = typeof options.author === "string" ? options.author : options.author?.name;
  const apiPathPrefix = options.apiPathPrefix ?? "/api/";
  return function transformPageData(pageData) {
    const title = pageData.title || siteName;
    const description = pageData.description || defaultDesc || "";
    const cleanPath = pageData.relativePath.replace(/\.md$/, ".html").replace(/index\.html$/, "");
    const canonicalUrl = `${hostname}/${cleanPath}`;
    pageData.frontmatter.head ??= [];
    pageData.frontmatter.head.push(["meta", { property: "og:title", content: title }], ["meta", { property: "og:description", content: description }], ["meta", { property: "og:url", content: canonicalUrl }], ["link", { rel: "canonical", href: canonicalUrl }]);
    const segments = cleanPath.replace(/\.html$/, "").split("/").filter(Boolean);
    if (segments.length > 0) {
      const breadcrumbItems = [
        { "@type": "ListItem", position: 1, name: "Home", item: `${hostname}/` }
      ];
      for (let i = 0;i < segments.length; i++) {
        const path = segments.slice(0, i + 1).join("/");
        const name = segments[i].replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
        breadcrumbItems.push({
          "@type": "ListItem",
          position: i + 2,
          name: pageData.title && i === segments.length - 1 ? pageData.title : name,
          item: `${hostname}/${path}`
        });
      }
      pageData.frontmatter.head.push([
        "script",
        { type: "application/ld+json" },
        JSON.stringify({
          "@context": "https://schema.org",
          "@type": "BreadcrumbList",
          itemListElement: breadcrumbItems
        })
      ]);
    }
    if (segments.length > 0) {
      const article = {
        "@context": "https://schema.org",
        "@type": "TechArticle",
        headline: title,
        description,
        url: canonicalUrl
      };
      if (pageData.lastUpdated) {
        article.dateModified = new Date(pageData.lastUpdated).toISOString();
      }
      if (authorName) {
        article.author = { "@type": "Person", name: authorName };
      }
      pageData.frontmatter.head.push(["script", { type: "application/ld+json" }, JSON.stringify(article)]);
    }
    if (canonicalUrl.includes(apiPathPrefix)) {
      const sourceCode = {
        "@context": "https://schema.org",
        "@type": "SoftwareSourceCode",
        name: title,
        programmingLanguage: "TypeScript",
        runtimePlatform: "Bun"
      };
      if (options.codeRepository) {
        sourceCode.codeRepository = options.codeRepository;
      }
      pageData.frontmatter.head.push(["script", { type: "application/ld+json" }, JSON.stringify(sourceCode)]);
    }
    if (Array.isArray(pageData.frontmatter.faq) && pageData.frontmatter.faq.length > 0) {
      const faqSchema = {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: pageData.frontmatter.faq.map((item) => ({
          "@type": "Question",
          name: item.q,
          acceptedAnswer: { "@type": "Answer", text: item.a }
        }))
      };
      pageData.frontmatter.head.push(["script", { type: "application/ld+json" }, JSON.stringify(faqSchema)]);
    }
    if (pageData.frontmatter.howto?.name && Array.isArray(pageData.frontmatter.howto.steps)) {
      const howtoSchema = {
        "@context": "https://schema.org",
        "@type": "HowTo",
        name: pageData.frontmatter.howto.name,
        step: pageData.frontmatter.howto.steps.map((text, i) => ({
          "@type": "HowToStep",
          text,
          position: i + 1
        }))
      };
      pageData.frontmatter.head.push(["script", { type: "application/ld+json" }, JSON.stringify(howtoSchema)]);
    }
  };
}

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

// src/terminal-glossary.ts
import { readFileSync } from "node:fs";
import { join as join2, dirname } from "node:path";
var TERMINFO_HOST = "https://terminfo.dev";
function loadTerminalGlossary(glossaryPath) {
  const candidates = glossaryPath ? [glossaryPath] : [
    join2(dirname(import.meta.dirname ?? ""), "..", "..", "..", "terminfo.dev", "content", "glossary.json"),
    join2(dirname(import.meta.dirname ?? ""), "..", "..", "terminfo.dev", "content", "glossary.json")
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
  validateGlossary,
  seoTransformPageData,
  seoHead,
  replaceInHtml,
  replaceEntities,
  loadTerminalGlossary,
  glossaryPlugin,
  createLinkifier,
  compileEntities
};
