// 站点与个人身份信息（占位内容，上线前替换为真实信息）
export interface LocalizedText {
  zh: string;
  en: string;
}

export interface SocialLink {
  label: string;
  href: string;
}

export const site = {
  name: 'Chefil',
  // TODO: 替换为真实职业头衔
  title: {
    zh: '全栈开发工程师',
    en: 'Full-stack Developer',
  },
  // TODO: 替换为真实一句话简介
  tagline: {
    zh: '构建简单可靠的 Web 应用。',
    en: 'Building simple and reliable web apps.',
  },
  // TODO: 替换为真实个人简介
  bio: {
    zh: '这里是一段个人简介占位文字。介绍你的背景、擅长领域、正在关注的技术方向，以及你希望通过这个网站展示什么。',
    en: 'This is a placeholder bio. Introduce your background, areas of expertise, technologies you are exploring, and what you would like to showcase on this site.',
  },
  // TODO: 替换为真实技能清单
  skills: ['TypeScript', 'Astro', 'React', 'Node.js', 'Tailwind CSS', 'Python'],
  // TODO: 替换为真实联系方式
  socials: [
    { label: 'GitHub', href: 'https://github.com/your-username' },
    { label: 'Email', href: 'mailto:you@example.com' },
  ] as SocialLink[],
};
