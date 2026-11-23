// 作品集数据：字段级双语
import type { LocalizedText } from './site';

export interface Project {
  /** 项目名称 */
  name: string;
  /** 一句话简介 */
  summary: LocalizedText;
  /** 技术标签 */
  tags: string[];
  /** 项目链接（GitHub / 在线演示等） */
  links: { label: string; href: string }[];
  /** 截图路径（public/ 下），可选 */
  image?: string;
}

// TODO: 替换为真实作品
export const projects: Project[] = [
  {
    name: 'Project Alpha（占位）',
    summary: {
      zh: '一个用于演示的占位项目，介绍它解决了什么问题、用了什么技术。',
      en: 'A placeholder project demonstrating what problem it solves and which technologies it uses.',
    },
    tags: ['TypeScript', 'Astro'],
    links: [{ label: 'GitHub', href: 'https://github.com/your-username' }],
  },
  {
    name: 'Project Beta（占位）',
    summary: {
      zh: '第二个占位项目，可以写上它的亮点和你负责的部分。',
      en: 'A second placeholder project. Highlight its features and your role.',
    },
    tags: ['Node.js', 'React'],
    links: [{ label: 'Demo', href: '#' }],
  },
];
