// 博客系列的 id → 双语显示名称
// 文章 frontmatter 写 series: wifi-thermometer 即归入该系列
export const seriesNames: Record<string, { zh: string; en: string }> = {
  'wifi-thermometer': {
    zh: '从零做一款 Wi-Fi 温湿度计',
    en: 'Build a Wi-Fi Thermo-Hygrometer from Scratch',
  },
  'zigbee-meter': {
    zh: '从零造一个 Zigbee 三相智能电表',
    en: 'Build a Zigbee Three-Phase Smart Meter from Scratch',
  },
};
