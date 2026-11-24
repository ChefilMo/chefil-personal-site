// 博客技术栈分类：id → 双语显示名称与图标
// 文章 frontmatter 的 category 字段必须取这里的键
export const blogCategories = [
  { id: 'embedded', icon: '🔧' },
  { id: 'ios', icon: '📱' },
  { id: 'android', icon: '🤖' },
  { id: 'notes', icon: '✏️' },
] as const;

export type BlogCategory = (typeof blogCategories)[number]['id'];

export const categoryNames: Record<BlogCategory, { zh: string; en: string }> = {
  embedded: { zh: '嵌入式', en: 'Embedded' },
  ios: { zh: 'iOS', en: 'iOS' },
  android: { zh: 'Android', en: 'Android' },
  notes: { zh: '随笔', en: 'Notes' },
};
