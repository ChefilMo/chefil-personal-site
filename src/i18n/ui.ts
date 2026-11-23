export const languages = {
  zh: '简体中文',
  en: 'English',
} as const;

export const defaultLang = 'zh';

export type Lang = keyof typeof languages;

/** 界面文案字典：页面模板文案与内容数据分离 */
export const ui = {
  zh: {
    'nav.home': '首页',
    'nav.experience': '经历',
    'nav.projects': '作品',
    'nav.blog': '博客',
    'nav.about': '关于',
    'nav.menu': '菜单',
    'lang.switch': 'Switch to English',
    'footer.rights': '保留所有权利',
    'blog.readMore': '阅读全文',
    'blog.publishedAt': '发布于',
    'blog.translationLink': '阅读英文版',
    'blog.empty': '还没有文章。',
    '404.title': '页面不存在',
    '404.backHome': '返回首页',
    'home.viewProjects': '查看作品',
    'home.contactMe': '联系我',
    'home.skills': '技能',
    'about.heading': '关于我',
    'about.contact': '联系方式',
  },
  en: {
    'nav.home': 'Home',
    'nav.experience': 'Experience',
    'nav.projects': 'Projects',
    'nav.blog': 'Blog',
    'nav.about': 'About',
    'nav.menu': 'Menu',
    'lang.switch': '切换为中文',
    'footer.rights': 'All rights reserved.',
    'blog.readMore': 'Read more',
    'blog.publishedAt': 'Published on',
    'blog.translationLink': 'Read in Chinese',
    'blog.empty': 'No posts yet.',
    '404.title': 'Page not found',
    '404.backHome': 'Back to home',
    'home.viewProjects': 'View projects',
    'home.contactMe': 'Contact me',
    'home.skills': 'Skills',
    'about.heading': 'About me',
    'about.contact': 'Contact',
  },
} as const;
