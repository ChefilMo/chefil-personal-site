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

export const projects: Project[] = [
  {
    name: '温湿度传感器（MCU 通用对接）',
    summary: {
      zh: '电池供电的涂鸦 Wi-Fi 温湿度 LCD 传感器，基于华大 CIU32F003（Cortex-M0+，Flash 24KB / SRAM 3KB）独立完成驱动、通信协议、低功耗架构、Bootloader 与 OTA 全栈固件开发。Deepstop 深度休眠 + LPTIM 周期唤醒，WiFi 通电占空比约 0.6%；设计五态缓存状态机保证休眠期间指令不丢失；双阶段 OTA 支持按键与云端推送两条升级路径。',
      en: 'Battery-powered Tuya Wi-Fi temperature-humidity LCD sensor. Independently developed the full firmware stack on a Huada CIU32F003 (Cortex-M0+, 24KB Flash / 3KB SRAM): drivers, communication protocol, low-power architecture, bootloader, and OTA. Deepstop sleep + LPTIM periodic wakeup keeps WiFi duty cycle around 0.6%; a five-state caching state machine prevents command loss during sleep; dual-stage OTA supports both button-triggered and cloud-push upgrade paths.',
    },
    tags: ['C', 'ARM Cortex-M0+', '低功耗设计', 'Bootloader/OTA', 'UART 通信协议', 'Keil MDK'],
    links: [],
  },
  {
    name: '智能电表',
    summary: {
      zh: '面向分户计量需求的三路负载（A/B/C 相）智能电表。SPI 采集 HLW8112、UART 采集 HLW8010 电量数据，I2C 驱动 LCD 实时显示电压 / 电流 / 功率，数据上报云端与手机 App，支持远程通断继电器。三路全负载测试 0.2A~32A 有功电能误差 ≤ 0.8%，App→云端→设备端到端平均 380ms，30 天老化测试零掉线，已量产。',
      en: 'A smart meter monitoring three load phases (A/B/C) for sub-metering. Energy data collected via SPI (HLW8112) and UART (HLW8010), LCD driven over I2C for real-time voltage / current / power display, with cloud and app reporting and remote relay control. Active energy error ≤ 0.8% across 0.2A–32A full-load tests, 380ms average end-to-end latency, zero disconnects in 30-day aging tests. In mass production.',
    },
    tags: ['C', '电量计量', 'SPI/UART/I2C', 'ADC 采集', '云端对接'],
    links: [],
  },
  {
    name: '温湿度传感器（涂鸦 SDK 开发）',
    summary: {
      zh: '基于涂鸦 SDK 的多功能环境监测终端，具备温湿度采集、电量检测、本地显示、报警提示及产线测试功能，有 WiFi（CBU/T1 模块）和 ZigBee（ZTU）多个版本。实现 CRC 校验与数据滤波（±0.5°C / ±3%RH 精度）、基于串口的自动化产测协议（单台测试 < 15 秒）、PWM 蜂鸣器报警，项目量产并成为公司主要出货产品。',
      en: 'A multifunctional environment monitoring terminal built on the Tuya SDK, featuring temperature-humidity sensing, battery detection, local display, alarms, and production-line testing, shipped in WiFi (CBU/T1 modules) and ZigBee (ZTU) versions. Achieved ±0.5°C / ±3%RH accuracy with CRC validation and data filtering, a serial-based automated production-test protocol (< 15s per unit), and PWM buzzer alarms. Mass-produced as one of the company\'s main shipping products.',
    },
    tags: ['涂鸦 SDK', 'WiFi/ZigBee', 'I2C', 'PWM', '产测协议'],
    links: [],
  },
  {
    name: 'G66W 智能报警器',
    summary: {
      zh: '完成双平台客户端架构设计与多协议兼容（WiFi/ZigBee）的全栈研发，实现设备自动/手动配网、云端控制主机、二维码或账号分享、配件遥控器/探测器接入，以及报警与异常情况的 App 推送提醒，体验领先同行产品。',
      en: 'Full-stack R&D of the dual-platform client architecture with WiFi/ZigBee multi-protocol support: automatic/manual device pairing, cloud-based host control, QR-code or account sharing, accessory remote/detector integration, and push notifications for alarms and abnormal events — experience ahead of competing products.',
    },
    tags: ['iOS', 'Android', 'WiFi/ZigBee', '推送服务'],
    links: [],
  },
];
