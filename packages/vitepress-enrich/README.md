# @bearly/vitepress-enrich

Glossary auto-linking, SEO structured data, and tooltip CSS for VitePress documentation sites.

Used by [silvery.dev](https://silvery.dev), [termless.dev](https://termless.dev), and [terminfo.dev](https://terminfo.dev).

## Features

- **Glossary auto-linking** — markdown-it plugin that auto-links terms on first mention per page, longest-match-first, skipping code/headings/links
- **Content linkification** — build-time string linkifier for `v-html` content in dynamic routes
- **SEO helpers** — OpenGraph, canonical URLs, JSON-LD (WebSite, BreadcrumbList, TechArticle, SoftwareSourceCode, FAQPage, HowTo)
- **Build-time validation** — warns on broken glossary links during `docs:build`
- **Tooltip CSS** — pure CSS hover tooltips, no JavaScript

## Quick Start

```bash
bun add -d @bearly/vitepress-enrich
```

### 1. Create a glossary

`docs/content/glossary.json`:

```json
[
  { "term": "SelectList", "href": "/api/select-list", "tooltip": "Interactive list component" },
  { "term": "SGR", "tooltip": "Select Graphic Rendition — controls text styling" },
  { "term": "Termless", "href": "https://termless.dev", "tooltip": "Headless terminal testing", "external": true }
]
```

### 2. Wire up VitePress

`.vitepress/config.ts`:

```typescript
import { defineConfig } from "vitepress"
import { glossaryPlugin, seoHead, seoTransformPageData, validateGlossary } from "@bearly/vitepress-enrich"
import glossary from "../content/glossary.json"

const seo = {
  hostname: "https://my-site.dev",
  siteName: "My Site",
  description: "What my site does",
  ogImage: "https://my-site.dev/og-image.svg",
  author: "Author Name",
  codeRepository: "https://github.com/me/my-site", // optional — enables SoftwareSourceCode on /api/ pages
}

export default defineConfig({
  lastUpdated: true,

  markdown: {
    config(md) {
      md.use(glossaryPlugin, { entities: glossary })
    },
  },

  head: [...seoHead(seo)],

  transformPageData: seoTransformPageData(seo),

  buildEnd(siteConfig) {
    validateGlossary(glossary, siteConfig)
  },
})
```

### 3. Import CSS

`.vitepress/theme/index.ts`:

```typescript
import DefaultTheme from "vitepress/theme"
import "@bearly/vitepress-enrich/css/tooltip.css"
import "@bearly/vitepress-enrich/css/glossary-links.css"

export default { extends: DefaultTheme }
```

That's it. Every page now gets glossary auto-linking, tooltips, and structured data.

## Glossary Entity Format

```typescript
interface GlossaryEntity {
  term: string // Text to match (word-boundary, case-sensitive)
  href?: string // Link URL — omit for tooltip-only
  tooltip?: string // Hover tooltip text
  external?: boolean // Opens in new tab
}
```

**Linking behavior:**

- Longest match wins (`"Kitty keyboard protocol"` before `"Kitty"`)
- First occurrence only per page (no link spam)
- Skips code blocks, inline code, headings, and existing links
- With `href`: renders as `<a class="hover-link">` (dotted underline, links on hover)
- Without `href`: renders as `<span class="glossary-hint">` (tooltip only, help cursor)

## SEO Schemas

`seoTransformPageData()` adds to every page:

| Schema                 | When                                          | What                                        |
| ---------------------- | --------------------------------------------- | ------------------------------------------- |
| **BreadcrumbList**     | All pages with path segments                  | Auto-generated from URL path                |
| **TechArticle**        | All non-home pages                            | headline, description, dateModified, author |
| **SoftwareSourceCode** | Pages under `apiPathPrefix` (default `/api/`) | programmingLanguage, codeRepository         |
| **FAQPage**            | `frontmatter.faq` array                       | Question/Answer pairs                       |
| **HowTo**              | `frontmatter.howto` object                    | Numbered steps                              |

### FAQPage (opt-in)

Add to page frontmatter:

```yaml
---
faq:
  - q: "Do I need a real terminal?"
    a: "No, it runs headless."
  - q: "Which backend should I use?"
    a: "vterm.js for most cases."
---
```

### HowTo (opt-in)

```yaml
---
howto:
  name: "Get Started with My Tool"
  steps:
    - "Install with bun add my-tool"
    - "Create a config file"
    - "Run the dev server"
---
```

## Build-Time Linkification

For dynamic routes that use `v-html`, use `createLinkifier`:

```typescript
import { createLinkifier } from "@bearly/vitepress-enrich/linkify"
import glossary from "../content/glossary.json"

const linkify = createLinkifier(glossary)
const enrichedHtml = linkify("Use SelectList for keyboard navigation")
// → 'Use <a href="/api/select-list" class="hover-link" data-tooltip="...">SelectList</a> for keyboard navigation'
```

## Validation

`validateGlossary()` runs at build time and:

- Reports term counts: `[glossary] 53 terms (31 linked, 22 tooltip-only, 3 external)`
- Warns on broken internal links: `⚠ "SelectList" → /api/select-list` if the page doesn't exist

## Exports

| Export                 | Path                                              | Purpose                     |
| ---------------------- | ------------------------------------------------- | --------------------------- |
| `glossaryPlugin`       | `@bearly/vitepress-enrich`                        | markdown-it plugin          |
| `createLinkifier`      | `@bearly/vitepress-enrich/linkify`                | Build-time string linkifier |
| `seoHead`              | `@bearly/vitepress-enrich/seo`                    | Static `<head>` entries     |
| `seoTransformPageData` | `@bearly/vitepress-enrich/seo`                    | Per-page SEO hook           |
| `validateGlossary`     | `@bearly/vitepress-enrich/validate`               | Build-time link validation  |
| `compileEntities`      | `@bearly/vitepress-enrich`                        | Low-level entity compiler   |
| `replaceEntities`      | `@bearly/vitepress-enrich`                        | Low-level text replacer     |
| CSS                    | `@bearly/vitepress-enrich/css/tooltip.css`        | Hover tooltip styles        |
| CSS                    | `@bearly/vitepress-enrich/css/glossary-links.css` | Link/hint styles            |

## Requirements

- VitePress >= 1.0
- Node.js >= 23.6.0 (native TypeScript) or Bun

## License

MIT
