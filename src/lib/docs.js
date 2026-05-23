import { getSectionDefinition, sectionDefinitions } from "./sections";

const baseUrl = import.meta.env.BASE_URL ?? "/";

function parseFrontMatter(source) {
  const normalized = source.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { metadata: {}, body: normalized };
  }

  const endIndex = normalized.indexOf("\n---\n", 4);
  if (endIndex === -1) {
    return { metadata: {}, body: normalized };
  }

  const frontMatter = normalized.slice(4, endIndex);
  const body = normalized.slice(endIndex + 5).trim();
  const metadata = {};

  for (const line of frontMatter.split("\n")) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    metadata[key] = value;
  }

  return { metadata, body };
}

function slugify(value) {
  return value
    .toLocaleLowerCase()
    .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

function resolveAssetPath(path) {
  if (!path.startsWith("/") || path.startsWith("//")) {
    return path;
  }

  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

function renderImage(alt, src) {
  return `<img src="${escapeAttribute(resolveAssetPath(src))}" alt="${escapeAttribute(alt)}" loading="lazy" />`;
}

function renderInline(value) {
  const parts = value.split(/(`[^`]+`)/g);
  return parts
    .map((part) => {
      if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) {
        return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      }

      return part
        .replace(
          /!\[([^\]]*)\]\(([^)]+)\)/g,
          (_match, alt, src) => renderImage(alt, src),
        )
        .replace(
        /\[([^\]]+)\]\(([^)]+)\)/g,
        (_match, label, href) =>
            `<a href="${escapeAttribute(href)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`,
        );
    })
    .join("");
}

function renderMarkdown(markdown) {
  const lines = markdown.split("\n");
  const html = [];
  const headings = [];
  let inList = false;
  let listTag = "";
  let inBlockquote = false;
  let inCodeBlock = false;
  let codeLanguage = "";
  let codeLines = [];
  let tableRows = [];
  let h2Count = 0;
  let h3Count = 0;

  const closeList = () => {
    if (inList) {
      html.push(`</${listTag}>`);
      inList = false;
      listTag = "";
    }
  };

  const closeBlockquote = () => {
    if (inBlockquote) {
      html.push("</blockquote>");
      inBlockquote = false;
    }
  };

  const closeCodeBlock = () => {
    if (codeLanguage.toLowerCase() === "mermaid") {
      html.push(`<pre class="mermaid">${codeLines.join("\n")}</pre>`);
    } else {
      const languageClass = codeLanguage ? ` class="language-${codeLanguage}"` : "";
      html.push(
        `<pre class="code-block"><code${languageClass}>${codeLines.join("\n")}</code></pre>`,
      );
    }

    codeLanguage = "";
    codeLines = [];
  };

  const closeTable = () => {
    if (tableRows.length === 0) {
      return;
    }

    const cells = tableRows.map((row) =>
      row
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    );
    const hasSeparator =
      cells.length > 1 && cells[1].every((cell) => /^:?-{3,}:?$/.test(cell));
    const dataStart = hasSeparator ? 2 : 1;

    html.push("<div class=\"table-scroll\"><table>");
    html.push(
      `<thead><tr>${cells[0].map((cell) => `<th>${renderInline(cell)}</th>`).join("")}</tr></thead>`,
    );
    html.push("<tbody>");
    for (const row of cells.slice(dataStart)) {
      html.push(`<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`);
    }
    html.push("</tbody></table></div>");
    tableRows = [];
  };

  for (const line of lines) {
    if (line.startsWith("```")) {
      closeList();
      closeBlockquote();
      closeTable();
      if (inCodeBlock) {
        closeCodeBlock();
      } else {
        codeLanguage = line.slice(3).trim();
      }
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(
        line
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;"),
      );
      continue;
    }

    if (line.startsWith("|") && line.endsWith("|")) {
      closeList();
      closeBlockquote();
      tableRows.push(line);
      continue;
    }

    closeTable();

    if (!line.trim()) {
      closeList();
      closeBlockquote();
      continue;
    }

    if (line.startsWith("> ")) {
      closeList();
      if (!inBlockquote) {
        html.push("<blockquote>");
        inBlockquote = true;
      }
      html.push(`<p>${renderInline(line.slice(2))}</p>`);
      continue;
    }

    closeBlockquote();

    if (line.startsWith("### ")) {
      closeList();
      const title = line.slice(4).trim();
      h3Count += 1;
      const numbering = h2Count > 0 ? `${h2Count}.${h3Count}` : `0.${h3Count}`;
      const id = slugify(`${numbering}-${title}`);
      headings.push({ level: 3, title, numbering, id });
      html.push(
        `<h3 id="${id}"><a class="heading-anchor" href="#${id}">${numbering} ${renderInline(title)}</a></h3>`,
      );
      continue;
    }

    if (line.startsWith("## ")) {
      closeList();
      const title = line.slice(3).trim();
      h2Count += 1;
      h3Count = 0;
      const numbering = `${h2Count}`;
      const id = slugify(`${numbering}-${title}`);
      headings.push({ level: 2, title, numbering, id });
      html.push(
        `<h2 id="${id}"><a class="heading-anchor" href="#${id}">${numbering}. ${renderInline(title)}</a></h2>`,
      );
      continue;
    }

    const unorderedItem = line.match(/^- (.+)$/);
    const orderedItem = line.match(/^\d+\. (.+)$/);
    if (unorderedItem || orderedItem) {
      const nextListTag = unorderedItem ? "ul" : "ol";
      if (inList && listTag !== nextListTag) {
        closeList();
      }
      if (!inList) {
        html.push(`<${nextListTag}>`);
        inList = true;
        listTag = nextListTag;
      }
      html.push(`<li>${renderInline((unorderedItem ?? orderedItem)[1])}</li>`);
      continue;
    }

    closeList();
    html.push(`<p>${renderInline(line)}</p>`);
  }

  closeList();
  closeBlockquote();
  closeTable();

  if (inCodeBlock) {
    closeCodeBlock();
  }

  return {
    html: html.join("\n"),
    headings,
  };
}

const docModules = import.meta.glob("../../docs/*/*.md", {
  eager: true,
  query: "?raw",
  import: "default",
});

function normalizeUpdatedAt(value) {
  return value.replace(" ", "T");
}

export const docs = Object.entries(docModules)
  .map(([path, source]) => {
    const { metadata, body } = parseFrontMatter(source);
    const rendered = renderMarkdown(body);
    const [, collection, fileName] = path.match(/docs\/([^/]+)\/([^/]+)\.md$/) ?? [];
    const slug = fileName;
    const updatedAt = normalizeUpdatedAt(metadata.updated ?? metadata.date ?? "2026-01-01");
    const section = metadata.section ?? "architecture";

    return {
      id: `${collection}/${slug}`,
      collection,
      slug,
      title: metadata.title ?? slug,
      updated: updatedAt,
      displayUpdated: updatedAt.slice(0, 10),
      excerpt: metadata.excerpt ?? "",
      tags: metadata.tags ? metadata.tags.split(",").map((item) => item.trim()) : [],
      section,
      sectionTitle: getSectionDefinition(section)?.title ?? section,
      status: metadata.status ?? "Draft",
      order: metadata.order ? Number(metadata.order) : Number.MAX_SAFE_INTEGER,
      body,
      html: rendered.html,
      headings: rendered.headings,
      path: `/docs/${collection}/${slug}`,
    };
  })
  .sort((left, right) => {
    if (left.section !== right.section) {
      return left.section.localeCompare(right.section);
    }
    if (left.order !== right.order) {
      return left.order - right.order;
    }
    return left.title.localeCompare(right.title);
  });

export function getLatestDocs(count) {
  return [...docs]
    .sort((left, right) => right.updated.localeCompare(left.updated))
    .slice(0, count);
}

export function getSectionCollections() {
  return sectionDefinitions.map((definition) => ({
    ...definition,
    docs: docs.filter((doc) => doc.section === definition.id),
  }));
}

export function getDocByParams(collection, slug) {
  return docs.find((entry) => entry.collection === collection && entry.slug === slug);
}

export function filterDocs(mode, query, section = "") {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const scopedDocs = section ? docs.filter((entry) => entry.section === section) : docs;

  if (!normalizedQuery) {
    return scopedDocs;
  }

  if (mode === "tag") {
    return scopedDocs.filter((entry) =>
      entry.tags.some((tag) => tag.toLocaleLowerCase().includes(normalizedQuery)),
    );
  }

  return scopedDocs.filter((entry) => {
    const title = entry.title.toLocaleLowerCase();
    const body = entry.body.toLocaleLowerCase();
    return title.includes(normalizedQuery) || body.includes(normalizedQuery);
  });
}
