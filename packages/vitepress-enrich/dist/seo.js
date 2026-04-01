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
export {
  seoTransformPageData,
  seoHead
};
