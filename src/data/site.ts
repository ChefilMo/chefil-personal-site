// 站点与个人身份信息
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
  title: {
    zh: '嵌入式软件工程师 / 物联网通信专家',
    en: 'Embedded Software Engineer / IoT Communication Specialist',
  },
  tagline: {
    zh: '专注 IoT 与嵌入式，从芯片到云端交付量产级产品。',
    en: 'Focused on IoT and embedded systems, shipping production-grade products from silicon to cloud.',
  },
  headline: {
    zh: '从芯片到云端，把 IoT 产品做到真正量产。',
    en: 'From silicon to cloud, I build IoT products that ship.',
  },
  bio: {
    zh: '14 年移动端与嵌入式开发经验，深耕物联网通信（蓝牙 / WiFi / ZigBee），7 年专注涂鸦智能生态，独立交付几十款量产级 IoT 产品，具备完整的硬件联调到云端对接全链路实战经验。iOS / Android 双平台 SDK 架构出身，也长期将 Claude / ChatGPT 等 AI 工具融入日常研发 workflow，实现代码生成、自动化 Review 与技术方案预研的显著提效。',
    en: '14 years of mobile and embedded development experience, specializing in IoT communication (Bluetooth / WiFi / ZigBee). 7 years focused on the Tuya Smart ecosystem, having independently delivered dozens of mass-produced IoT products with full-chain experience from hardware bring-up to cloud integration. Background in iOS / Android dual-platform SDK architecture, and routinely integrate AI tools like Claude / ChatGPT into my daily workflow for code generation, automated review, and technical research.',
  },
  skills: [
    'C / ARM Cortex-M',
    '低功耗设计（Deepstop / 电源门控）',
    'UART / I2C / SPI / ADC',
    'Bootloader / OTA',
    '涂鸦 IoT 生态（WiFi / ZigBee / BLE）',
    'iOS（Objective-C / Swift）',
    'Android（Java / Kotlin）',
    'AI 辅助研发（Claude / ChatGPT）',
  ],
  stats: [
    {
      value: { zh: '14 年', en: '14 yrs' },
      label: { zh: '移动端与嵌入式研发', en: 'Mobile & embedded engineering' },
    },
    {
      value: { zh: '7 年', en: '7 yrs' },
      label: { zh: '涂鸦 IoT 生态实践', en: 'Building with Tuya IoT' },
    },
    {
      value: { zh: '数十款', en: 'Dozens' },
      label: { zh: '独立交付量产产品', en: 'Mass-produced devices delivered' },
    },
  ],
  socials: [
    { label: 'GitHub', href: 'https://github.com/ChefilMo' },
    { label: 'Email', href: 'mailto:chefilmocf@gmail.com' },
  ] as SocialLink[],
};
