# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

个人网站（Astro 7 + Tailwind CSS 4），部署到 GitHub Pages 项目页 `https://chefilmo.github.io/chefil-personal-site`，支持中英双语。

## 常用命令

```bash
npm run dev      # 本地开发（默认 http://localhost:4321/chefil-personal-site/）
npm run build    # 静态构建（仅 astro build，不运行测试、lint 或 astro check）
npm run preview  # 预览构建产物
```

项目没有测试框架和 lint 配置，验证方式是 `npm run build` 必须成功。新增页面/改路由后务必跑一次完整 build，因为 SSG 静态路径的错误只在构建时暴露。

## 架构要点

### 双语路由（Astro i18n + 手动文案字典）

- `astro.config.mjs` 配置了 `locales: ['zh', 'en']`、`prefixDefaultLocale: true`，所以**所有页面都在 `src/pages/[lang]/` 下**，URL 形如 `/zh/blog/`、`/en/about/`。根路径 `/` 由 `src/pages/index.astro` 用 meta refresh 重定向到 `/zh/`。
- 页面模板文案不依赖 Astro 内置 `t()`，而是走自己的字典：`src/i18n/ui.ts`（`ui[lang]['nav.home']` 这类键）+ `src/i18n/utils.ts` 的 `useTranslations(lang)`。页面里 `const t = useTranslations(lang)` 后使用。
- 内容数据（站点信息、经历、项目）在 `src/data/site.ts`、`src/data/experience.ts`、`src/data/projects.ts`，按语言分字段；**改内容只动 data 文件，不要动页面组件**。

### 博客内容集合

- `src/content.config.ts` 定义 `blog` 集合，用 glob loader 读取 `src/content/blog/{zh,en}/*.md`。必填 frontmatter 为 `title`、`description`、`pubDate`、`lang`、`category`；可选字段包括 `translationKey`、`tags`、`heroImage`、`series`、`seriesOrder`。没有草稿过滤逻辑，放入目录的 Markdown 都会参与构建。
- 同一篇文章的中英文是两个独立文件，靠 `translationKey` 互相关联（文章页据此渲染另一语言链接）。新增双语文章时两个文件都要写、`translationKey` 要一致；URL slug 取各自文件名（不含扩展名）。
- 文章页路由 `src/pages/[lang]/blog/[...slug].astro`，RSS 在 `src/pages/[lang]/blog/rss.xml.ts`（每语言一个 feed）。

### 博客分类与系列

- `category` 是必填技术栈分类，取值由 `src/data/blog-categories.ts` 和 content schema 共同约束。博客首页只展示分类入口；新增分类必须同步修改这两个文件，分类页才会生成对应静态路径。
- 系列文章还需设置 `series` 和数值型 `seriesOrder`，并在 `src/data/series.ts` 注册系列 ID 的双语名称。系列页按 `seriesOrder` 排序，文章页据此生成同语言的上一篇/下一篇导航。
- 分类页由 `src/pages/[lang]/blog/category/[category].astro` 生成，系列文章分组展示，无 `series` 的文章归入“独立文章”；系列落地页位于 `src/pages/[lang]/blog/series/[series].astro`。

### GitHub Pages base 路径（最容易踩的坑）

站点带 `base: '/chefil-personal-site'` 部署，**所有站内链接、图片、RSS 链接都必须过 `src/utils/url.ts` 的 `withBase()` 包装**，硬编码 `/zh/...` 路径在生产环境会 404。语言切换用 `src/i18n/utils.ts` 的 `getLocalizedPath()`（它内部已处理 base）。

### 样式与主题

Tailwind CSS 4 通过 `astro.config.mjs` 中的 Vite 插件接入，不使用独立的 `tailwind.config.*`。全局样式和 design token 在 `src/styles/global.css`：`@import "tailwindcss"` 引入框架，`@custom-variant` 让 `dark:` 跟随 `<html>` 的 `.dark` class，`@theme` 定义字体。`BaseLayout.astro` 还实现了滚动进场动画，修改布局时保留主题防闪烁和 `prefers-reduced-motion` 处理。

### 页面/组件分层

`src/pages/` 只做路由和取数（getCollection / 读 data 文件），渲染逻辑全部委托给 `src/components/pages/*Page.astro`，布局由 `src/layouts/BaseLayout.astro` 提供（含暗色模式防闪烁脚本，修改主题逻辑时注意保留）。

### 部署

`.github/workflows/deploy.yml`：push 到 `main` 自动构建并发布到 GitHub Pages（`withastro/action@v3`，Node 24）。`astro.config.mjs` 里的 `site`/`base` 与线上地址强绑定，改仓库名或域名时必须同步修改。
