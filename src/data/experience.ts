// 经历时间线数据：字段级双语，同一条记录无需写两遍
import type { LocalizedText } from './site';

export interface ExperienceItem {
  /** 时间段展示文本，如 "2024 - 至今" */
  period: string;
  /** 职位名称 */
  title: LocalizedText;
  /** 要点描述 */
  points: LocalizedText;
}

export const experience: ExperienceItem[] = [
  {
    period: '2019.12 - 至今',
    title: { zh: '技术合伙人', en: 'Technical Partner' },
    points: {
      zh: '负责涂鸦产品的研发、调试和发布，独立开发几十款量产产品（WiFi / ZigBee / BLE 系列：烟雾、PIR、门窗、温湿度、燃气、水浸、SOS 等传感器），囊括公司量产出货 90% 的产品；撰写技术文档与产测文档，协调生产、测试与升级环节；维护 iOS 和 Android 项目，处理客户定制需求。',
      en: 'Led R&D, debugging, and release of Tuya-based products, independently developing dozens of mass-produced devices (WiFi / ZigBee / BLE series: smoke, PIR, door/window, temperature-humidity, gas, water leak, SOS sensors, etc.), covering 90% of the company\'s shipped products. Wrote technical and production-test documentation, coordinated manufacturing and testing, and maintained iOS / Android projects for client customizations.',
    },
  },
  {
    period: '2017.03 - 2019.12',
    title: { zh: 'iOS / Android / 单片机工程师', en: 'iOS / Android / MCU Engineer' },
    points: {
      zh: '主导公司 iOS / Android 双平台历史项目的架构维护与性能治理，承担技术债务清理、兼容性适配与崩溃率优化；独立完成 G66W 智能报警器 App 全栈研发（双平台架构 + WiFi/ZigBee 多协议兼容，实现设备配网、报警推送、场景联动）；独立负责 HomeSee 安卓板报警系统技术落地，基于 Android 4.0 嵌入式平台完成系统裁剪、驱动适配及安防业务层开发。',
      en: 'Led architecture maintenance and performance governance of legacy iOS / Android projects, covering tech-debt cleanup, compatibility adaptation, and crash-rate optimization. Independently delivered the G66W smart alarm app end-to-end (dual-platform architecture + WiFi/ZigBee multi-protocol support: device pairing, alarm push, scene automation). Solely responsible for the HomeSee Android-panel alarm system, completing system trimming, driver adaptation, and security service layer development on an embedded Android 4.0 platform.',
    },
  },
  {
    period: '2015.02 - 2017.03',
    title: { zh: '项目组组长', en: 'Project Team Lead' },
    points: {
      zh: '作为创始技术成员主导「令令开门」从 0 到 1 的架构搭建与性能优化，通过通信协议重构、边缘计算策略及云端协同优化，将开门响应优化至秒级体验；主导 SDK 标准化封装与对接方案设计，支撑国内 Top10 地产商中 7 家（万科、恒大、保利等）规模化集成；统筹项目分工与里程碑管控，建立版本管理、兼容性升级与定制化需求响应机制。',
      en: 'As a founding technical member, led the "LingLing KaiMen" smart door access product from 0 to 1 — architecture setup and performance optimization via communication protocol refactoring, edge computing strategy, and cloud coordination, bringing door-open response to a sub-second experience. Led SDK standardization and integration design, supporting large-scale integration at 7 of China\'s top-10 real estate developers (Vanke, Evergrande, Poly, etc.). Managed team task allocation and milestone control, establishing version management and customization response mechanisms.',
    },
  },
  {
    period: '2014.02 - 2015.02',
    title: { zh: 'iOS 工程师', en: 'iOS Engineer' },
    points: {
      zh: '为智能手环设计并开发手机端 App，负责上架与后期维护升级。2014 年 6 月首个 App「iBracele」在苹果应用商店上架销售，同年 11 月第二个 App「iCardiocare」上架。',
      en: 'Designed and developed companion iOS apps for smart bracelets, handling App Store submission and maintenance. First app "iBracele" launched on the App Store in June 2014, followed by the second app "iCardiocare" in November 2014.',
    },
  },
];
