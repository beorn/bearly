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
export {
  seoTransformPageData,
  seoHead
};
