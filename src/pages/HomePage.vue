<script setup>
import { RouterLink } from "vue-router";
import { getLatestDocs, getSectionCollections } from "../lib/docs";

const latestDocs = getLatestDocs(3);
const sectionGroups = getSectionCollections();
const logoPath = `${import.meta.env.BASE_URL}img/Rk-C_logo_tp.png`;
</script>

<template>
  <section class="page-card home-page">
    <p class="page-label">Welcome to Rk-C!</p>
    <img class="project-logo" :src="logoPath" alt="Rk-C" />
    
    <p class="page-description">
      Design documentation and API references for Rk-C, a microkernel-style
      operating system implemented in Nim for the QEMU RISC-V 64-bit platform.
    </p>

    <section class="home-section">
      <div class="section-heading">
        <p class="section-kicker">Browse</p>
        <h2 class="section-title">Documentation Areas</h2>
      </div>

      <div class="doc-area-grid">
        <RouterLink
          v-for="section in sectionGroups"
          :key="section.id"
          :to="{ path: '/docs', query: { section: section.id } }"
          class="doc-area-card"
        >
          <h3 class="doc-area-title">{{ section.title }}</h3>
          <p class="doc-area-description">{{ section.description }}</p>
          <p class="doc-area-count">{{ section.docs.length }} documents</p>
        </RouterLink>
      </div>
    </section>

    <section class="home-section">
      <div class="section-heading">
        <p class="section-kicker">Recently Updated</p>
        <h2 class="section-title">Reference Documents</h2>
      </div>

      <div class="article-stack compact-stack">
        <article v-for="doc in latestDocs" :key="doc.id" class="article-card">
          <p class="article-meta">{{ doc.sectionTitle }} / Updated {{ doc.displayUpdated }}</p>
          <h3 class="article-title">
            <RouterLink :to="doc.path">{{ doc.title }}</RouterLink>
          </h3>
          <p class="article-excerpt">{{ doc.excerpt }}</p>
        </article>
      </div>
    </section>
  </section>
</template>
