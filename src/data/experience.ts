// 经历时间线数据：字段级双语，同一条记录无需写两遍
import type { LocalizedText } from './site';

export interface ExperienceItem {
  /** 时间段展示文本，如 "2024 - 至今" */
  period: string;
  /** 职位名称 */
  title: LocalizedText;
  /** 公司/组织名称 */
  org: string;
  /** 要点描述 */
  points: LocalizedText;
}

// TODO: 替换为真实经历
export const experience: ExperienceItem[] = [
  {
    period: '2023 - 至今',
    title: { zh: '高级开发工程师（占位）', en: 'Senior Developer (placeholder)' },
    org: '某某科技公司',
    points: {
      zh: '负责某某业务线的架构设计与核心开发，带领 N 人小团队交付了某某项目。',
      en: 'Owned architecture design and core development for a business line, leading a team of N to deliver a major project.',
    },
  },
  {
    period: '2020 - 2023',
    title: { zh: '开发工程师（占位）', en: 'Developer (placeholder)' },
    org: '某某互联网公司',
    points: {
      zh: '参与某某系统从 0 到 1 的建设，负责后端 API 设计与实现。',
      en: 'Built a system from scratch, responsible for backend API design and implementation.',
    },
  },
];
