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
function replaceEntities(text, entities, _linkedTerms) {
  const matches = [];
  const occupied = new Set;
  for (const entity of entities) {
    entity.pattern.lastIndex = 0;
    let m;
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
      for (let p = start;p < end; p++)
        occupied.add(p);
      matches.push({ start, end, entity });
    }
  }
  if (matches.length === 0)
    return text;
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
    for (const region of textRegions) {
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
        for (let p = absStart;p < absEnd; p++)
          occupied.add(p);
        matches.push({ start: absStart, end: absEnd, entity });
      }
    }
  }
  if (matches.length === 0)
    return html;
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
    for (const blockToken of state.tokens) {
      if (blockToken.type === "html_block" && blockToken.content) {
        blockToken.content = replaceInHtml(blockToken.content, entities);
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
        const replaced = replaceEntities(child.content, entities);
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
    ["meta", { name: "twitter:card", content: "summary_large_image" }]
  ];
  if (options.ogImage) {
    head.push(["meta", { property: "og:image", content: options.ogImage }], ["meta", { property: "og:image:width", content: "1200" }], ["meta", { property: "og:image:height", content: "630" }]);
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
function generateDescription(title, relativePath, siteName) {
  const cleanPath = relativePath.replace(/\.md$/, "").replace(/(^|\/)index$/, "");
  const segments = cleanPath.split("/").filter(Boolean);
  if (segments.length === 0)
    return "";
  const section = segments[0];
  const pageTitle = title || segments[segments.length - 1].replace(/-/g, " ");
  switch (section) {
    case "api":
      return `API reference for ${pageTitle} in ${siteName} — props, usage examples, and TypeScript types.`;
    case "components":
      return `${pageTitle} component in ${siteName} — usage, props, examples, and best practices for terminal UIs.`;
    case "guide":
      return `${pageTitle} — an in-depth guide for building terminal apps with ${siteName}.`;
    case "guides":
      return `${pageTitle} — practical guide for ${siteName} terminal UI development.`;
    case "reference":
      return `${pageTitle} — ${siteName} reference documentation with detailed API information.`;
    case "examples":
      return `${pageTitle} — interactive ${siteName} example with code and live terminal demo.`;
    case "getting-started":
      return `${pageTitle} — get up and running with ${siteName} in minutes.`;
    case "design":
      return `${pageTitle} — ${siteName} design patterns and architectural decisions.`;
    case "matchers":
      return `${pageTitle} matcher — ${siteName} assertion reference with usage examples and TypeScript signatures.`;
    case "advanced":
      return `${pageTitle} — advanced ${siteName} topic with in-depth technical details.`;
    default:
      return `${pageTitle} — ${siteName} documentation.`;
  }
}
function seoTransformPageData(options) {
  const { hostname, siteName, description: defaultDesc } = options;
  const authorName = typeof options.author === "string" ? options.author : options.author?.name;
  const authorUrl = typeof options.author === "object" ? options.author?.url : undefined;
  const apiPathPrefix = options.apiPathPrefix ?? "/api/";
  return function transformPageData(pageData) {
    const title = pageData.title || siteName;
    const description = pageData.description || generateDescription(title, pageData.relativePath, siteName) || defaultDesc || "";
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
        const isoDate = new Date(pageData.lastUpdated).toISOString();
        article.dateModified = isoDate;
        article.datePublished = isoDate;
      }
      if (options.ogImage) {
        article.image = options.ogImage;
      }
      if (authorName) {
        const author = { "@type": "Person", name: authorName };
        if (authorUrl) {
          author.url = authorUrl;
        }
        if (typeof options.author === "object" && options.author?.sameAs) {
          author.sameAs = options.author.sameAs;
        }
        article.author = author;
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
    join2(dirname(import.meta.dirname ?? ""), "..", "..", "..", "terminfo.dev", "content", "glossary.json")
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
    const bundledPath = join2(dirname(import.meta.dirname ?? ""), "terminal-glossary-data.json");
    const raw = JSON.parse(readFileSync(bundledPath, "utf-8"));
    return parseGlossary(raw);
  } catch {
    return [];
  }
}

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

// src/doc-glossary.ts
import { readFileSync as readFileSync2, writeFileSync, readdirSync, statSync } from "node:fs";
import { join as join3, relative, dirname as dirname2, extname } from "node:path";
function matchGlob(pattern, filePath) {
  const regexStr = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\x00").replace(/\*/g, "[^/]*").replace(/\0/g, ".*");
  return new RegExp(`^${regexStr}$`).test(filePath);
}
function collectMarkdownFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join3(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || entry.name === "node_modules")
        continue;
      results.push(...collectMarkdownFiles(full));
    } else if (extname(entry.name) === ".md") {
      results.push(full);
    }
  }
  return results;
}
function resolveFiles(include) {
  const files = new Set;
  for (const pattern of include) {
    const base = pattern.replace(/\/?\*.*$/, "") || ".";
    let dir;
    try {
      dir = statSync(base).isDirectory() ? base : dirname2(base);
    } catch {
      continue;
    }
    for (const file of collectMarkdownFiles(dir)) {
      const rel = relative(dir, file);
      const fullPattern = pattern.startsWith(base) ? pattern.slice(base.length + 1) : pattern;
      if (matchGlob(fullPattern || "**/*.md", rel)) {
        files.add(file);
      }
    }
  }
  return [...files];
}
function inferBucket(filePath, pathBuckets, defaultBucket) {
  if (pathBuckets) {
    for (const [pattern, bucket] of Object.entries(pathBuckets)) {
      if (matchGlob(pattern, filePath))
        return bucket;
    }
  }
  return defaultBucket ?? "default";
}
function deriveHref(filePath, baseUrl) {
  if (!baseUrl)
    return;
  const withoutExt = filePath.replace(/\.md$/, "").replace(/\/index$/, "");
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return `${base}${withoutExt}`;
}
function extractHeadingTerms(content, filePath, defaultBucket, baseUrl) {
  const terms = [];
  const markerRe = /<!--\s*glossary:\s*(\S+)\s*-->/g;
  let marker;
  while ((marker = markerRe.exec(content)) !== null) {
    const bucket = marker[1];
    const afterMarker = content.slice(marker.index + marker[0].length);
    const headingMatch = afterMarker.match(/\n#{1,6}\s+(.+)/);
    if (!headingMatch)
      continue;
    const term = headingMatch[1].trim();
    const afterHeading = afterMarker.slice(headingMatch.index + headingMatch[0].length);
    const paraMatch = afterHeading.match(/\n\n*([^\n#<][^\n]+)/);
    const tooltip = paraMatch ? paraMatch[1].trim() : "";
    if (!tooltip)
      continue;
    terms.push({
      term,
      tooltip,
      bucket,
      href: deriveHref(filePath, baseUrl),
      source: filePath
    });
  }
  return terms;
}
function extractAbbreviationTerms(content, filePath, bucket) {
  const terms = [];
  const abbrRe = /^\*\[([^\]]+)\]:\s*(.+)$/gm;
  let match;
  while ((match = abbrRe.exec(content)) !== null) {
    const term = match[1];
    const tooltip = match[2].trim();
    if (!tooltip)
      continue;
    terms.push({
      term,
      tooltip,
      bucket,
      source: filePath
    });
  }
  return terms;
}
function extractDfnTerms(content, filePath, bucket) {
  const terms = [];
  const dfnRe = /<dfn>([^<]+)<\/dfn>/g;
  let match;
  while ((match = dfnRe.exec(content)) !== null) {
    const term = match[1];
    const before = content.slice(0, match.index);
    const after = content.slice(match.index + match[0].length);
    const sentStart = Math.max(before.lastIndexOf(". ") + 2, before.lastIndexOf(`.
`) + 2, before.lastIndexOf(`

`) + 2, 0);
    const periodIdx = after.search(/\.\s|\.\n|$/);
    const sentEnd = periodIdx >= 0 ? match.index + match[0].length + periodIdx + 1 : content.length;
    let tooltip = content.slice(sentStart, sentEnd).trim();
    tooltip = tooltip.replace(/<\/?dfn>/g, "");
    if (!tooltip || tooltip === term)
      continue;
    terms.push({
      term,
      tooltip,
      bucket,
      source: filePath
    });
  }
  return terms;
}
function extractFrontmatterBucket(content) {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch)
    return;
  const bucketMatch = fmMatch[1].match(/^glossary_bucket:\s*(.+)$/m);
  return bucketMatch ? bucketMatch[1].trim() : undefined;
}
function extractGlossary(options) {
  const { include, defaultBucket, pathBuckets, baseUrl } = options;
  const files = resolveFiles(include);
  const allTerms = [];
  for (const filePath of files) {
    const content = readFileSync2(filePath, "utf-8");
    const rel = filePath;
    const fmBucket = extractFrontmatterBucket(content);
    const bucket = fmBucket ?? inferBucket(rel, pathBuckets, defaultBucket);
    allTerms.push(...extractHeadingTerms(content, rel, bucket, baseUrl));
    allTerms.push(...extractAbbreviationTerms(content, rel, bucket));
    allTerms.push(...extractDfnTerms(content, rel, bucket));
  }
  const seen = new Set;
  return allTerms.filter((t) => {
    if (seen.has(t.term))
      return false;
    seen.add(t.term);
    return true;
  });
}
function extractFromMarkdown(content, options = {}) {
  const filePath = options.filePath ?? "<inline>";
  const bucket = options.bucket ?? "default";
  const terms = [];
  const fmBucket = extractFrontmatterBucket(content);
  const effectiveBucket = fmBucket ?? bucket;
  terms.push(...extractHeadingTerms(content, filePath, effectiveBucket, options.baseUrl));
  terms.push(...extractAbbreviationTerms(content, filePath, effectiveBucket));
  terms.push(...extractDfnTerms(content, filePath, effectiveBucket));
  const seen = new Set;
  return terms.filter((t) => {
    if (seen.has(t.term))
      return false;
    seen.add(t.term);
    return true;
  });
}
function loadBucket(terms, bucket) {
  return terms.filter((t) => t.bucket === bucket).map((t) => ({
    term: t.term,
    tooltip: t.tooltip,
    href: t.href
  }));
}
function writeGlossaryBucket(terms, bucket, outPath) {
  const filtered = terms.filter((t) => t.bucket === bucket);
  const lines = filtered.map((t) => JSON.stringify(t));
  writeFileSync(outPath, lines.join(`
`) + `
`, "utf-8");
}
function readGlossaryBucket(path) {
  const content = readFileSync2(path, "utf-8");
  return content.split(`
`).filter((line) => line.trim()).map((line) => JSON.parse(line));
}
export {
  writeGlossaryBucket,
  validateGlossary,
  seoTransformPageData,
  seoHead,
  replaceInHtml,
  replaceEntities,
  readGlossaryBucket,
  loadTerminalGlossary,
  loadEcosystemGlossary,
  loadBucket,
  glossaryPlugin,
  extractGlossary,
  extractFromMarkdown,
  createLinkifier,
  compileEntities
};
