<script setup>
import hljs from "highlight.js/lib/core";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import bash from "highlight.js/lib/languages/bash";
import nim from "highlight.js/lib/languages/nim";
import plaintext from "highlight.js/lib/languages/plaintext";
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { getDocByParams } from "../lib/docs";

hljs.registerLanguage("c", c);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sh", bash);
hljs.registerLanguage("nim", nim);
hljs.registerLanguage("plaintext", plaintext);
hljs.registerLanguage("text", plaintext);
hljs.registerLanguage("asm", plaintext);
hljs.registerLanguage("ld", plaintext);

const route = useRoute();
const articleBodyRef = ref(null);
const mermaidModuleUrl = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
let mermaidPromise = null;

const article = computed(() =>
  getDocByParams(String(route.params.collection), String(route.params.slug)),
);

async function highlightCodeBlocks() {
  await nextTick();
  if (!articleBodyRef.value) {
    return;
  }

  const blocks = articleBodyRef.value.querySelectorAll("pre code");
  for (const block of blocks) {
    hljs.highlightElement(block);
    const normalizedHtml = block.innerHTML.replace(/\n$/, "");
    const lines = normalizedHtml.split("\n");
    block.innerHTML = lines
      .map((line) => `<span class="code-line">${line || " "}</span>`)
      .join("");
  }
}

async function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import(/* @vite-ignore */ mermaidModuleUrl).then((module) => {
      const mermaid = module.default;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "dark",
        fontFamily: "IBM Plex Sans, sans-serif",
      });
      return mermaid;
    });
  }

  return mermaidPromise;
}

async function renderMermaidBlocks() {
  await nextTick();
  if (!articleBodyRef.value) {
    return;
  }

  const nodes = articleBodyRef.value.querySelectorAll("pre.mermaid");
  if (nodes.length === 0) {
    return;
  }

  const mermaid = await loadMermaid();
  await mermaid.run({ nodes, suppressErrors: true });
}

async function enhanceArticle() {
  await highlightCodeBlocks();
  await renderMermaidBlocks();
}

watch(article, () => {
  enhanceArticle();
});

onMounted(() => {
  enhanceArticle();
});
</script>

<template>
  <section v-if="article" class="page-card article-page">
    <p class="page-label">Documentation / {{ article.sectionTitle }}</p>
    <h1 class="page-title">{{ article.title }}</h1>
    <p class="article-meta">{{ article.status }} / Updated {{ article.displayUpdated }}</p>
    <div class="tag-row">
      <span v-for="tag in article.tags" :key="tag" class="tag-chip">{{ tag }}</span>
    </div>
    <div class="article-layout">
      <aside v-if="article.headings.length > 0" class="article-toc">
        <p class="article-toc-label">Contents</p>
        <nav aria-label="Table of contents">
          <a
            v-for="heading in article.headings"
            :key="heading.id"
            :href="`#${heading.id}`"
            class="article-toc-link"
            :class="{
              'is-sub': heading.level === 3,
            }"
          >
            {{ heading.level === 2 ? `${heading.numbering}. ${heading.title}` : `${heading.numbering} ${heading.title}` }}
          </a>
        </nav>
      </aside>

      <div ref="articleBodyRef" class="article-body" v-html="article.html"></div>
    </div>
    <RouterLink class="inline-back-link" to="/docs">Back to Documentation</RouterLink>
  </section>

  <section v-else class="page-card">
    <p class="page-label">Docs</p>
    <h1 class="page-title">Document Not Found</h1>
    <p class="page-description">
      The requested document is unavailable or has not been published.
    </p>
    <RouterLink class="inline-back-link" to="/docs">Back to Docs</RouterLink>
  </section>
</template>
