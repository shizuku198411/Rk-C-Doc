import { createRouter, createWebHistory } from "vue-router";
import HomePage from "./pages/HomePage.vue";
import DocsPage from "./pages/DocsPage.vue";
import DocArticlePage from "./pages/DocArticlePage.vue";
import AboutPage from "./pages/AboutPage.vue";
import ContactPage from "./pages/ContactPage.vue";
import PrivacyPage from "./pages/PrivacyPage.vue";

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: "/", component: HomePage },
    { path: "/docs", component: DocsPage },
    { path: "/docs/:collection/:slug", component: DocArticlePage, props: true },
    { path: "/series", redirect: "/docs" },
    { path: "/about", component: AboutPage },
    { path: "/contact", component: ContactPage },
    { path: "/privacy", component: PrivacyPage }
  ],
  scrollBehavior() {
    return { top: 0 };
  },
});
