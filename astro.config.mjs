// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  // TODO: 部署时替换为真实域名（RSS、canonical 依赖此项）
  site: 'http://localhost:4321',
  i18n: {
    locales: ['zh', 'en'],
    defaultLocale: 'zh',
    routing: {
      prefixDefaultLocale: true,
    },
  },
  vite: {
    plugins: [tailwindcss()],
  },
});
