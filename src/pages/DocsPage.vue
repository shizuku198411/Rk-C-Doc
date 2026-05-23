<script setup>
import { computed } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { filterDocs, getSectionCollections } from "../lib/docs";
import { getSectionDefinition } from "../lib/sections";

const route = useRoute();
const searchQuery = computed(() =>
  typeof route.query.q === "string" ? route.query.q.trim() : "",
);
const searchMode = computed(() => (route.query.mode === "tag" ? "tag" : "text"));
const activeSection = computed(() => {
  const requested = typeof route.query.section === "string" ? route.query.section : "";
  return getSectionDefinition(requested) ? requested : "";
});
const selectedSection = computed(() => getSectionDefinition(activeSection.value));
const sections = getSectionCollections();
const filteredDocs = computed(() =>
  filterDocs(searchMode.value, searchQuery.value, activeSection.value),
);
</script>

<template>
  <section class="page-card docs-page">
    <p class="page-label">Documentation</p>
    <h1 class="page-title">{{ selectedSection ? selectedSection.title : "Document Library" }}</h1>
    <p class="page-description">
      {{ selectedSection ? selectedSection.description : "Design documents, interfaces, and operational references for the Rk-C kernel and userspace." }}
    </p>

    <nav class="section-filter" aria-label="Document sections">
      <RouterLink to="/docs" class="section-filter-link" :class="{ 'is-active': !activeSection }">
        All
      </RouterLink>
      <RouterLink
        v-for="section in sections"
        :key="section.id"
        :to="{ path: '/docs', query: { section: section.id } }"
        class="section-filter-link"
        :class="{ 'is-active': activeSection === section.id }"
      >
        {{ section.title }}
      </RouterLink>
    </nav>

    <p v-if="searchQuery" class="search-summary">
      {{ searchMode === "tag" ? "Tag" : "Full text" }} search:
      <span class="search-summary-value">{{ searchQuery }}</span>
      <span class="search-summary-count">{{ filteredDocs.length }} hits</span>
    </p>

    <div class="article-stack">
      <article v-for="doc in filteredDocs" :key="doc.id" class="article-card">
        <p class="article-meta">
          {{ doc.sectionTitle }} / {{ doc.status }} / Updated {{ doc.displayUpdated }}
        </p>
        <h2 class="article-title">
          <RouterLink :to="doc.path">{{ doc.title }}</RouterLink>
        </h2>
        <p class="article-excerpt">{{ doc.excerpt }}</p>
        <div class="tag-row">
          <span v-for="tag in doc.tags" :key="tag" class="tag-chip">{{ tag }}</span>
        </div>
      </article>
    </div>

    <p v-if="filteredDocs.length === 0" class="empty-state">
      No documents matched this selection.
    </p>
  </section>
</template>
