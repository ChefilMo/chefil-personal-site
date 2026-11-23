// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  // GitHub Pages 项目页：站点域名 + 仓库名作为 base 路径
  site: 'https://chefilmo.github.io',
  base: '/chefil-personal-site',
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
