// src/doc-glossary.ts
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname, extname } from "node:path";
function matchGlob(pattern, filePath) {
  const regexStr = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\x00").replace(/\*/g, "[^/]*").replace(/\0/g, ".*");
  return new RegExp(`^${regexStr}$`).test(filePath);
}
function collectMarkdownFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
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
      dir = statSync(base).isDirectory() ? base : dirname(base);
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
    const content = readFileSync(filePath, "utf-8");
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
  const content = readFileSync(path, "utf-8");
  return content.split(`
`).filter((line) => line.trim()).map((line) => JSON.parse(line));
}
export {
  writeGlossaryBucket,
  readGlossaryBucket,
  loadBucket,
  extractGlossary,
  extractFromMarkdown
};
