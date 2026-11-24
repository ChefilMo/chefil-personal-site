---
title: "第 12 篇：Flash 持久化——设置怎么存、擦写寿命的账、以及“统一存储块”"
description: "设置只活在 RAM 里，一复位全蒸发。本篇把设置存进芯片内部 Flash：讲清只能 1 变 0 的物理脾气、擦写寿命的算术，以及统一存储块为什么是小资源产品的标准答案。"
pubDate: 2026-11-24
lang: zh
translationKey: wifi-thermometer-part12
tags: [嵌入式, STM32, 教程]
series: wifi-thermometer
seriesOrder: 12
category: embedded
---

> DP 缓存能应用了，但设置只活在 RAM 里：一复位（换电池、看门狗咬了、OTA 升级），用户改过的阈值全部蒸发。
> 本篇把设置存进芯片内部的 Flash。听起来是"调库读写"的活，实际藏着三个硬问题：**Flash 的物理脾气（只能 1 变 0）、擦写寿命的算术、以及多个设置怎么存才不互相磨损**。

---

## 一、本篇目标与效果

**目标**：实现设置存储——串口命令修改温度上限并保存，**按复位键、拔电重上电之后，设置依然在**。

**做完你会懂**：内部 Flash 的擦写规则（先解锁、先擦后写、半字写入）、寿命账怎么算、以及为什么"所有设置合并成一个块存"是小资源产品的标准答案。

## 二、原理 10 分钟

### 2.1 Flash 的物理脾气：只能"1 变 0"

MCU 内部的 Flash 是 NOR 型，它有一条反直觉的铁律：

> **每一位只能从 1 写成 0，不能从 0 写回 1。**

想把一个 0 变回 1？唯一的办法是**擦除**——而且擦除有最小粒度（STM32F103 按"页"擦，一页 1 KB），一擦就是整页全部归 0xFF。

所以写 Flash 的标准流程永远是：**解锁 → 擦整页 → 写入 → 上锁**。想改其中一个字节？对不起，整页擦掉重写。

另一个要命的特性是**寿命**：F103 每页标称擦写寿命约 **1 万次**。1 万次听着多，算笔账就清醒了（2.3 节详算）。

### 2.2 寄存器操作五部曲

```c
#define FLASH_PAGE_ADDR   0x0800FC00    // F103C8 64KB, 用最后一页(1KB)做存储

static void flash_unlock(void)
{
    FLASH->KEYR = 0x45670123;           // 钥匙 1
    FLASH->KEYR = 0xCDEF89AB;           // 钥匙 2（顺序不能错，错一次锁死到复位）
    while (FLASH->CR & FLASH_CR_LOCK) { }
}

static void flash_erase_page(uint32_t addr)
{
    FLASH->CR |= FLASH_CR_PER;          // 页擦除模式
    FLASH->AR = addr;                   // 选页
    FLASH->CR |= FLASH_CR_STRT;         // 开擦
    while (FLASH->SR & FLASH_SR_BSY) { }
    FLASH->CR &= ~FLASH_CR_PER;
}

static void flash_write_halfword(uint32_t addr, uint16_t data)
{
    FLASH->CR |= FLASH_CR_PG;           // 编程模式
    *(__IO uint16_t *)addr = data;      // F103 只能 16 位（半字）写
    while (FLASH->SR & FLASH_SR_BSY) { }
    FLASH->CR &= ~FLASH_CR_PG;
}

static void flash_lock(void) { FLASH->CR |= FLASH_CR_LOCK; }
```

产品里也有一模一样的解锁时序——**写 Flash 前忘解锁，写操作会静默丢弃**，不报错、不中断（这个坑的第 16 篇 OTA 版本更大，先记账）。

### 2.3 寿命的账：为什么"各存各的"会磨穿

假设产品的双向设置有 6 个：温度/湿度上下限、温标、静音、校准……**如果每个设置独占一页 Flash**，各自的磨损就完全不均衡：

- 告警阈值这种设置，调试期一天改几十次很正常；
- 温标切换，用户一辈子可能就动两三回。

各占一页的话：热门页一天 50 次擦写 → 10000 ÷ 50 = **200 天就磨穿了**；冷门页 99.9% 的寿命白白陪葬。项目里早期版本就长这样——每个缓存 DP 各自擦写，算下来一天上千次擦写，几个月就是 Flash 的寿命尽头。

**标准答案：统一存储块**。定义一个结构体把所有设置打包，**任何**一个设置变化都整体重写这个块。页寿命的消耗从"每设置分别累计"变成"全设置合并计数"：

```
统一块后：一天就算改 20 次设置，擦写也只有 20 次
10000 ÷ 20 ÷ 365 ≈ 1.4 年 → 还是不够？再往下抠：
保存时机改为"仅在设置真正变化时"，而不是周期性保存 →
实际用户场景一天几次都不到 → 寿命直接按十年计
```

把"保存"从**周期性动作**改成**事件性动作**（设置变了才存），是寿命账里最大的一笔节省。

### 2.4 数据布局：魔数 + 内容 + 校验

存一页数据，怎么知道里面是有效设置而不是出厂的 0xFF 垃圾？三件套：

```
┌─────────┬──────────────────────┬────────┐
│ magic    │ 设置结构体内容         │ 校验和  │
│ 2 字节   │ N 字节               │ 2 字节 │
└─────────┴──────────────────────┴────────┘
magic  = 0xA55A（自定义暗号，0xFF 不可能是它）
校验和 = 对内容做累加/异或，读出时验一遍
```

读的时候：magic 不对 → 当作首次使用，加载默认值；校验不对 → 数据曾受损（比如上次保存中途断电），同样回退默认值。**保存中途断电**是真实场景，校验和就是为它买的保险。

## 三、动手写代码

```c
typedef struct {
    uint16_t temp_hi_x10;
    uint16_t temp_lo_x10;
    uint16_t hum_hi;
    uint16_t hum_lo;
    uint8_t  unit_f;
    uint8_t  mute;
} settings_t;                                // 全设置打包

static settings_t s_settings;

#define SET_MAGIC   0xA55A

static void settings_save(void)
{
    flash_unlock();
    flash_erase_page(FLASH_PAGE_ADDR);

    uint16_t magic = SET_MAGIC;
    flash_write_halfword(FLASH_PAGE_ADDR, magic);

    uint16_t *src = (uint16_t *)&s_settings;             // 结构体按半字写
    for (uint32_t i = 0; i < sizeof(settings_t) / 2; i++) {
        flash_write_halfword(FLASH_PAGE_ADDR + 2 + i * 2, src[i]);
    }

    uint16_t sum = 0;                                    // 校验和：内容累加
    for (uint32_t i = 0; i < sizeof(settings_t) / 2; i++) sum += src[i];
    flash_write_halfword(FLASH_PAGE_ADDR + 2 + sizeof(settings_t), sum);

    flash_lock();
}

static int settings_load(void)
{
    uint16_t magic = *(volatile uint16_t *)FLASH_PAGE_ADDR;
    if (magic != SET_MAGIC) return -1;                   // 没存过

    uint16_t *dst = (uint16_t *)&s_settings;
    for (uint32_t i = 0; i < sizeof(settings_t) / 2; i++) {
        dst[i] = *(volatile uint16_t *)(FLASH_PAGE_ADDR + 2 + i * 2);
    }
    uint16_t sum = *(volatile uint16_t *)(FLASH_PAGE_ADDR + 2 + sizeof(settings_t));
    uint16_t calc = 0;
    for (uint32_t i = 0; i < sizeof(settings_t) / 2; i++) calc += dst[i];
    return (sum == calc) ? 0 : -1;                       // 校验失败
}

void settings_init(void)
{
    if (settings_load() != 0) {                          // 读不出 → 出厂默认
        s_settings.temp_hi_x10 = 300;
        s_settings.temp_lo_x10 = 100;
        s_settings.hum_hi      = 60;
        s_settings.hum_lo      = 20;
        s_settings.unit_f      = 0;
        s_settings.mute        = 1;                      // 告警默认静音（产品定义）
    }
}
```

在 `dp_download_handle()`（第 9 篇）里，设置类 DP 的每个分支末尾加一句 `settings_save();`——设置一变，立即落盘。主循环不做任何周期性保存（2.3 节的寿命账）。

## 四、烧录与验收

- [ ] 串口命令修改温度上限为 35，打印确认；
- [ ] **按开发板复位键**：重新启动后设置仍是 35——Flash 生效；
- [ ] **拔掉 USB 断电、重新上电**：设置仍是 35——对抗了真正的掉电；
- [ ] 首次烧录的新芯片：读到的是默认值（magic 校验路径生效）；
- [ ] （进阶实验）把保存时机改成"每 10 秒无条件保存"，连续跑一小时，串口打印累计擦写次数——然后回来算这笔账是多少天磨穿一页。亲手算一遍，2.3 节的数字才真正变成你的。

## 五、原版对照（CIU32F003）

产品的存储模块就是本篇思路的产品化加强，四处升级：

1. **统一块 + 事件保存**：所有设置类 DP 合并为一个存储块，只在设置真正变化时保存——2.3 节的账就是产品的真实账本；
2. **存储页落在 OTA 分区之外**。这是血泪点：产品规划 OTA（第 16 篇）时发现，设置页若放在 App 分区内，**每次固件升级会把用户的设置一起擦掉**——升级完用户发现阈值全复原，客诉预定。最终存储页固定在 Bootloader/App 都不碰的保留区，OTA 随便升，设置不动；
3. **保存时机配合 DP 缓存**。应用层只有在"缓存应用"或"用户下发"导致设置变化时才保存，与第 11 章的缓存状态机严格解耦——状态机管时序，存储模块只管"变了就存"；
4. **芯片地址别名细节**。产品所在芯片的 Flash 空间存在 0x0000 别名映射，擦写操作对地址窗口有特定要求——这类细节没有通用知识可言，**只认芯片数据手册的 Flash 章节**，移植时逐条核对。

## 六、彩蛋：磨穿的 Flash 和"怎么就改不动了"

把寿命账讲成一个完整的事故推演：某产品（行业真实案例的常见形态）把 Wi-Fi 配网计数器存在 Flash 里，每连一次云写一次。实验室里测不出问题——测试一周写了几百次，离 1 万次还远。量产后到了用户手里：设备每 10 分钟连云一次，一天 144 次擦写，热门页 69 天磨穿。**磨穿的页会怎么表现？** 擦不干净、写不进去、读回数据跳变——症状是"设备工作一段时间后行为诡异、复位又好一阵"，排查难度拉满，因为示波器抓总线一切正常，**坏的是存储介质本身**。

这类事故的可怕在于它的**时间延迟性**：设计错误的账，几个月后才来收。防御手段就是本篇的三件套：合并磨损（统一块）、降低频率（事件保存）、算清预算（页寿命 ÷ 日擦写次数 > 产品寿命）。**写 Flash 存储代码之前，先把除法算出来**，这个数字比任何代码审查都先到来。

## 七、下篇预告

数据能存了、能报了、能睡了——但用户总不能靠串口看温湿度。下一篇第 13 篇《段码 LCD》：产品用的不是液晶屏而是段码屏（电子表那种），驱动芯片 VKL076 走 I2C。我们会把第 3 篇的模拟 I2C 手艺第二次用上，写显存、点图标、进省电 standby——你第 0 篇买的 1602，终于能出场了。

---

*本系列基于真实量产项目改编，文中踩坑记录均出自真实开发过程。建议按顺序阅读，篇间有依赖。*
