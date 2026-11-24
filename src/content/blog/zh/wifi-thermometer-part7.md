---
title: "第 7 篇：主循环状态机——把前面六篇组装成一个产品"
description: "前六篇造好了感知、表达、睡眠、自愈模块，本篇用 WAKEUP→PROCESS→SLEEP 三状态主循环把它们组装成产品：事件驱动判定是否值得上报，窗口制给醒着的时间设预算。"
pubDate: 2026-11-24
lang: zh
translationKey: wifi-thermometer-part7
tags: [嵌入式, STM32, 教程]
series: wifi-thermometer
seriesOrder: 7
category: embedded
---

> 前六篇，我们一块一块地造了感知（I2C/ADC）、表达（UART）、睡眠（STOP）、自愈（IWDG）。它们各自运转良好，但还不是一个产品——产品需要一个"大脑"来决定：**什么时候干活、干什么活、什么时候睡觉**。
> 本篇搭这个大脑。它是全系列的架构枢纽：第 8~16 篇的所有功能，最终都会挂到本篇这棵树上。

---

## 一、本篇目标与效果

**目标**：实现三状态主循环——`WAKEUP → PROCESS → SLEEP → 醒来回到 WAKEUP`。数据没变化时醒 2 秒就睡；有变化（或按键触发）时进入 5 秒上报窗口，窗口内处理串口通信；按键还能让窗口顺延。

**做完你会懂**：为什么用状态机而不是直线代码、"事件驱动"四个字怎么让电池寿命翻倍、以及"窗口制"这套调度思想。

## 二、原理 10 分钟

### 2.1 从直线代码到状态机

假设不用状态机，主循环大概率写成这样：

```c
while (1) {
    采样();
    上报();
    处理串口();
    睡觉10秒();
}
```

这叫**周期驱动**：每 10 秒把全套流程无条件跑一遍。它简单，但致命：Wi-Fi 模组是整个产品最大的电老虎，而上面这个循环**每 10 秒都要给模组上一次电**——哪怕温度纹丝没动。电池不是被用光的，是被这种"无脑勤奋"耗光的。

状态机的思路是把"现在该干嘛"显式建模成一个变量：

```c
typedef enum {
    ST_WAKEUP = 0,    // 刚醒：采样、判定
    ST_PROCESS,       // 窗口期：处理串口/协议
    ST_SLEEP          // 睡觉
} state_t;
```

`switch (s_state)` 每次循环只执行一个分支，状态的跳转条件写在分支末尾——**流转规则集中可见**，这是状态机对直线代码的第一个胜利：你能画出图、能审查每一条边。

### 2.2 事件驱动：值得干才醒着

第二个胜利是本篇的灵魂。WAKEUP 状态干完后，不直接上报，先问一个问题：

> **"这次醒来，值不值得给 Wi-Fi 上电？"**

产品的判定清单是这样的（按优先级）：

1. **按键醒了**——用户盯着屏幕呢，必须上报；
2. **强制上报标志**——比如按键在醒着的时候按过；
3. **正在配网**——配网期间必须保持通信；
4. **距上次上报满 60 分钟**——兜底心跳，哪怕什么都没变（云端知道设备活着）；
5. **DP 值显著变化**——温度变化 ≥ 1℃、湿度变化 ≥ 5%RH、告警状态翻转、或者从未上报过。

**五条都不满足 → 不上电 Wi-Fi，采完样刷新完屏幕直接睡。** 产品的真实数字：无事可报时，一次醒来全程约 **50 毫秒**——10 秒的周期里只醒 0.5%，其余 99.5% 在 Deepstop。平均电流就是这么从"月抛"变成"年抛"的。

### 2.3 窗口制：醒着的时间也要预算

判定为"该上报"之后，进入 PROCESS 状态。这里采用**窗口制**：设一个时长上限（产品 10 秒），窗口内每 10 ms 驱动一次串口协议栈；窗口耗尽了？**强制入睡**——哪怕 Wi-Fi 还没连上。

为什么必须强制？回看第 6 篇彩蛋的教训：**一切等待都必须可超时**。窗口就是整个醒着阶段的"总超时"：Wi-Fi 异常、信号弱、模组抽风，最坏情况就是这一个窗口的电量，绝不会出现"醒着干等一整夜"。

窗口还有两个顺延条件（产品规则，后面会用到）：

- **按键忙**：用户正在连击操作，窗口延长伺候；
- **蜂鸣器忙**：正在滴滴滴告警，睡下去会把 PWM 打断。

顺延的实现朴素到可爱：顺延条件成立时，窗口计时器清零重数。

## 三、动手写代码

学习版做一个缩减但骨架一致的三状态机：窗口 5 秒（产品 10 秒）、兜底 3 个周期（产品 360 个）、STOP 换成普通延时（定时唤醒原理已在第 5 篇原版对照学过）、上报判定用简化条件。

```c
typedef enum { ST_WAKEUP = 0, ST_PROCESS, ST_SLEEP } state_t;

#define SLEEP_PERIOD_MS      10000
#define UART_WINDOW_MS       5000
#define UART_TICK_MS         10
#define REPORT_BACKUP_CYCLES 3                 // 兜底：3 个周期必报一次
#define TEMP_DELTA_X10       20                // 温度变化 ≥2.0℃ 视为显著

static state_t s_state = ST_WAKEUP;
static uint16_t s_window_tick = 0;
static uint8_t  s_cycles_since_report = 0;
static bool     s_force_report = false;
static int16_t  s_last_report_temp_x10 = -9999;   // "从未上报"的哨兵值
static int16_t  s_cur_temp_x10 = 250;             // 由采样函数更新

/* g_key_event 由下方按键中断置位（volatile！第 2 篇讲过为什么） */
extern volatile bool g_key_event;
```

三个状态：

```c
void app_main(void)
{
    while (1) {
        iwdg_feed();                            // 每个状态入口喂狗（第 6 篇）

        switch (s_state) {
        case ST_WAKEUP: {
            app_do_measurement();               // 采样：I2C 读温湿度 + ADC（第 3、4 篇）

            bool need_report =
                   s_force_report                                   // ① 按键强制
                || (++s_cycles_since_report >= REPORT_BACKUP_CYCLES) // ② 兜底
                || (s_last_report_temp_x10 == -9999)                // ③ 从未上报
                || (abs(s_cur_temp_x10 - s_last_report_temp_x10) >= TEMP_DELTA_X10); // ④ 变化

            if (need_report) {
                uart_puts("[WAKEUP] need report, open window\r\n");
                s_cycles_since_report = 0;
                s_force_report = false;
                s_window_tick = 0;
                s_state = ST_PROCESS;
            } else {
                uart_puts("[WAKEUP] nothing new, back to sleep\r\n");
                s_state = ST_SLEEP;             // 无事：采完就睡
            }
            break;
        }

        case ST_PROCESS: {
            uart_service_tick();                // 10ms 驱动串口/协议栈（第 2 篇的环形缓冲消费）

            if (g_key_event) {                  // 用户还在操作：窗口顺延
                g_key_event = false;
                s_window_tick = 0;
            }

            s_window_tick += UART_TICK_MS;
            if (s_window_tick >= UART_WINDOW_MS) {
                uart_puts("[PROCESS] window over, sleep\r\n");
                s_last_report_temp_x10 = s_cur_temp_x10;  // 记录上报基准
                s_state = ST_SLEEP;
            }
            delay_ms(UART_TICK_MS);
            break;
        }

        case ST_SLEEP: {
            uart_puts("[SLEEP] zzz...\r\n");
            while ((USART1->SR & USART_SR_TC) == 0) { } // 发完再睡（第 2 篇彩蛋）
            delay_ms(SLEEP_PERIOD_MS);                  // 学习版用延时占位
            /* 真机此处是 STOP：LPTIM 10s 后唤醒 + 恢复时钟（第 5 篇） */
            s_state = ST_WAKEUP;
            break;
        }
        }
    }
}
```

按键中断里置标志（注意 volatile，第 2 篇学过）：

```c
volatile bool g_key_event = false;
void EXTI0_IRQHandler(void) { EXTI->PR = EXTI_PR_PR0; g_key_event = true; }
```

`app_do_measurement()` 就是第 3 篇的 `gxht40_read()` + 第 4 篇的 ADC 读取 + 更新 `s_cur_temp_x10`——前三篇的零件原封不动拧上来，这就是模块化分层攒下来的红利。

## 四、烧录与验收

- [ ] 上电后第一周期打印 `[WAKEUP] need report`（从未上报，必报）→ 5 秒窗口 → `[SLEEP]`；
- [ ] 之后的周期温度没变时打印 `nothing new, back to sleep`——**采完即睡，没有窗口**；
- [ ] 连续 3 个周期后，兜底条件触发，重新进入上报窗口；
- [ ] 对着传感器加热（或改大判定阈值做演示），温度变化超 2℃ → 立刻触发上报窗口；
- [ ] **顺延验证**：进入窗口后按住按键不松，窗口结束打印不再出现，松手后窗口才关闭；
- [ ] 能对着串口日志画出本周期完整的状态流转图。

## 五、原版对照（CIU32F003）

学习版骨架与产品一致，差异全在参数和硬件层：

| 项 | 学习版 | 产品 |
|---|--------|------|
| 睡眠 | 延时占位 | STOP/Deepstop + LPTIM 10 s 定时唤醒 + 恢复时钟 |
| 窗口 | 5 s | 10 s（Wi-Fi 启动+握手+连云+上报要这么久） |
| 兜底 | 3 个周期 | 60 min = 360 个 LPTIM 周期 |
| 显著变化 | 温度 ≥2℃ | 温度/外温 ≥1℃、湿度 ≥5%RH、告警翻转 |
| 顺延 | 按键 | 按键忙 / 蜂鸣忙 / 产测扫描中 |

产品上还有两个学习版没有的 Wake-up 输入：**按键 EXTI 和 Deepstop 期间的按键锁存**。用户在设备睡着时按一下，EXTI 直接把芯片叫醒，WAKEUP 判定"按键唤醒"立即进入上报周期——这是产品交互体验的关键：按下按键 1 秒内屏幕就有新数据。第 14 篇按键篇会展开。

## 六、彩蛋：这套架构是"赔"出来的，不是"设计"出来的

这套三状态 + 事件驱动看着优雅，但它不是一开始就这样。产品早期版本其实是这样的（对，就是 2.1 节批判的那种）：

```
醒来 → 无条件给 Wi-Fi 上电 → 无条件上报 → 睡
```

跑起来"一切正常"，直到算电流账的时候发现不对劲：**每 10 秒就上一次电，Wi-Fi 启动那几秒是大电流**，平均功耗直接翻倍还多。更要命的是，云端看到的数据 99% 都是重复的——温度一小时可能才变 0.5℃，凭什么每 10 秒全量发一次？

后来的改造分两步：先把"无条件上报"改成"变化才上报"（加判定清单和上报基准），再把"无事也醒满窗口"改成"采完即睡"（无事时醒来全程压到 50 ms）。两个提交，平均电流降下来一大截，电池寿命直接按倍数计。

这个故事想传递的其实是系列的总主题：**小资源产品的架构，是被功耗和内存的预算"挤"出来的**。预算就是架构师——它替你做了"事件驱动"这个决定，你不做就烧电池。所以如果你读别人的低功耗代码觉得"绕"，先去找它的预算约束，绕路通常都通向那里。

另外补一个当时的现场细节：上报窗口最初只有 200 ms，测试中发现 Wi-Fi 连云慢的时候**帧发一半就被睡眠截断**，DP 数据缺胳膊少腿。窗口就是从这类"截断事故"里一路调到 10 秒的——**窗口不是设计出来的，是被最慢的那次连云逼出来的**。

## 七、下篇预告

大脑有了，还差"对话能力"：怎么和 Wi-Fi 模组说话？下一篇第 8 篇《涂鸦协议入门》：`55 AA` 开头的帧格式逐字节解剖、心跳、握手、工作模式查询——而且不用买模组，我们用电脑上的串口助手**扮演** Wi-Fi 模组，和单片机进行一场"人机对手戏"。逻辑分析仪，又该出场了。

---

*本系列基于真实量产项目改编，文中踩坑记录均出自真实开发过程。建议按顺序阅读，篇间有依赖。*
