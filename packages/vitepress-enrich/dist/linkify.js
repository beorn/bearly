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
export {
  createLinkifier
};
