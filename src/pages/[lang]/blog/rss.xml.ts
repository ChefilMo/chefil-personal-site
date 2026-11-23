import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import { withBase } from '../../../utils/url';

// 每语言一个 RSS feed：/zh/blog/rss.xml、/en/blog/rss.xml
export function getStaticPaths() {
  return [{ params: { lang: 'zh' } }, { params: { lang: 'en' } }];
}

export async function GET(context: { params: { lang: string }; site?: URL }) {
  const lang = context.params.lang;
  const posts = (await getCollection('blog', ({ data }) => data.lang === lang)).sort(
    (a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf(),
  );

  return rss({
    title: lang === 'zh' ? 'Chefil 的博客' : "Chefil's Blog",
    description: lang === 'zh' ? '技术、项目与想法' : 'Technology, projects and ideas',
    // channel 链接指向该语言的博客首页（site 根路径不带 base，直接拼会 404）
    site: new URL(withBase(`${lang}/blog/`), context.site!),
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.pubDate,
      link: withBase(`${lang}/blog/${post.id.split('/').pop()}/`),
    })),
    customData: `<language>${lang === 'zh' ? 'zh-CN' : 'en'}</language>`,
  });
}
