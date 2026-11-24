import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

// 博客文章集合：每语言一份独立 Markdown 文件（blog/zh/*.md、blog/en/*.md），
// 通过 frontmatter 的 translationKey 互相关联
const blog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.coerce.date(),
    lang: z.enum(['zh', 'en']),
    translationKey: z.string().optional(),
    tags: z.array(z.string()).optional(),
    heroImage: z.string().optional(),
    /** 所属系列 id（对应 src/data/series.ts 中的键） */
    series: z.string().optional(),
    /** 系列内序号，决定系列页和上下篇的排序 */
    seriesOrder: z.number().optional(),
    /** 技术栈分类（对应 src/data/blog-categories.ts 中的键） */
    category: z.enum(['embedded', 'ios', 'android', 'notes']),
  }),
});

export const collections = { blog };
