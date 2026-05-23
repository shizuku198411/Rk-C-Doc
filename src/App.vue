<script setup>
import { ref, watch } from "vue";
import { RouterLink, RouterView, useRoute, useRouter } from "vue-router";
import { sectionDefinitions } from "./lib/sections";

const route = useRoute();
const router = useRouter();

const navigationItems = [
  { label: "Overview", to: "/" },
  { label: "Documentation", to: "/docs" },
  { label: "Project", to: "/about" },
  { label: "Contact", to: "/contact" },
  { label: "Privacy", to: "/privacy" }
];

const searchMode = ref("text");
const searchQuery = ref("");

watch(
  () => route.query,
  (query) => {
    searchMode.value = query.mode === "tag" ? "tag" : "text";
    searchQuery.value = typeof query.q === "string" ? query.q : "";
  },
  { immediate: true },
);

function submitSearch() {
  const query = {};

  if (searchQuery.value.trim()) {
    query.q = searchQuery.value.trim();
    query.mode = searchMode.value;
  }

  if (typeof route.query.section === "string") {
    query.section = route.query.section;
  }

  router.push({
    path: "/docs",
    query,
  });
}
</script>

<template>
  <div class="site-shell">
    <aside class="sidebar">
      <div class="sidebar-inner">
        <RouterLink class="site-title" to="/">Rk-C</RouterLink>
        <p class="site-summary">
          Architecture and API documentation for the RISC-V 64-bit microkernel.
        </p>

        <nav class="side-nav" aria-label="Primary">
          <RouterLink
            v-for="item in navigationItems"
            :key="item.to"
            :to="item.to"
            class="side-nav-link"
            :class="{ 'is-active': route.path === item.to || (item.to === '/docs' && route.path.startsWith('/docs')) }"
          >
            {{ item.label }}
          </RouterLink>
        </nav>

        <div class="side-sections">
          <p class="side-section-label">Browse By Section</p>
          <RouterLink
            v-for="section in sectionDefinitions"
            :key="section.id"
            :to="{ path: '/docs', query: { section: section.id } }"
            class="side-section-link"
            :class="{ 'is-active': route.path.startsWith('/docs') && route.query.section === section.id }"
          >
            {{ section.title }}
          </RouterLink>
        </div>

        <form class="search-panel" @submit.prevent="submitSearch">
          <label class="search-label" for="site-search-input">Search Documentation</label>
          <select id="site-search-mode" v-model="searchMode" class="search-select">
            <option value="text">Title and content</option>
            <option value="tag">Tag</option>
          </select>
          <input
            id="site-search-input"
            v-model="searchQuery"
            class="search-input"
            type="search"
            :placeholder="searchMode === 'tag' ? 'ipc' : 'page table'"
          />
          <button class="search-button" type="submit">Search</button>
        </form>
      </div>
    </aside>

    <main class="content-shell">
      <RouterView />
    </main>
  </div>
</template>
