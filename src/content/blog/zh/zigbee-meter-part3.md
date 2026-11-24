---
title: "03 · 手脚：按键状态机与 LED 模式机"
description: "按键三态状态机 + LED 自接力定时器：中断去抖、松手锚点多击裁决、闪 N 次与模式恢复，全程零阻塞，附四个踩坑实录。"
pubDate: 2026-11-24
lang: zh
translationKey: zigbee-meter-part3
tags: [嵌入式, Zigbee, 教程]
series: zigbee-meter
seriesOrder: 3
category: embedded
---

> 目标：一个按键识别单击/双击/三击/长按，一个 LED 实现常亮/快闪/慢闪/闪 N 次，全程零阻塞

---

别小看一颗按键和一颗 LED——它们是设备上唯二的人机交互器官，而且把嵌入式里两个最经典的模式（**中断 + 定时器扫描**、**单次定时器自接力**）都演了一遍。本篇的两个模块加起来不到 400 行代码，但值得逐行讲。

## 一、按键：中断唤醒 + 20ms 状态机

### 1.1 硬件与总体思路

按键接在 PB4，配置上拉输入 + 下降沿中断（低电平有效）。设计目标：

| 动作 | 语义 |
|------|------|
| 短按 | LCD 翻页 |
| 双击 | 电表自检 |
| 三击 | LCD 全笔画测试（屏幕测试模式） |
| 长按 5s | 触发 Zigbee 配网 |

硬件中断天然带抖动（按键弹片接触的瞬间会产生几毫秒的毛刺），如果直接在 IRQ 里计数，一次按压可能被算成三次。最朴素的去抖是 IRQ 里 `delay_ms(20)`——**这是严禁的**，中断里睡觉等于整个系统陪你睡觉。本项目的方案分三层：

```
下降沿 IRQ  ──只做一件事：转入"去抖态"，启动 20ms 扫描定时器
    │
    ▼
20ms 定时器扫描状态机  ──连续 2 次读到低电平才算"真的按下了"（消抖）
    │                    累计 250 次低电平 = 5s 长按
    ▼
松手 ──不立即上报！重开一个 500ms 窗口，窗口内再按则计数+1
    │
    ▼
500ms 窗口超时 ──按累计次数裁决：1 次=单击，2 次=双击，≥3 次=三击
```

### 1.2 中断里做什么、不做什么

按键模块的 IRQ 处理只有几行有效逻辑：

```c
STATIC VOID_T __app_key_irq_handle(VOID_T *args)
{
    if (sg_key_state == KEY_STATE_IDLE) {
        sg_key_state = KEY_STATE_DEBOUNCE;              /* 转入去抖态 */
        sg_key_scan_cnt = 0;
        app_led_key_press();                            /* 按下立刻亮灯（视觉反馈） */
        tal_sw_timer_start(sg_etimer_key_scan, KEY_SCAN_INTERVAL_MS, TAL_TIMER_ONCE);
    }
}
```

注意两个细节：一是 IRQ 里**没有任何等待和循环**，置个状态、点个灯、启个定时器就退场；二是用 `sg_key_state == KEY_STATE_IDLE` 做门——已经按下时再来下降沿（抖动产生的假中断）直接忽略，这是第一道防线。

按键注册延续上一篇讲过的两阶段拆分：`app_key_init()` 在 `tuya_init_second` 只创建软件定时器，`app_key_init_hw()` 在 `tuya_init_third` 才注册 GPIO IRQ。

### 1.3 扫描状态机：三态足够

```c
typedef enum {
    KEY_STATE_IDLE = 0,     /* 空闲，等待 IRQ */
    KEY_STATE_DEBOUNCE,     /* 去抖：确认"真的按下" */
    KEY_STATE_PRESSED,      /* 已确认按下：检测长按与松手 */
} KEY_STATE_E;
```

扫描回调每 20ms 被调一次：

**去抖态**——连续 2 次读到低电平才进入 PRESSED：

```c
if (KEY_STATE_DEBOUNCE == sg_key_state) {
    if (LOW == tal_gpio_read(USER_KEY_0_PIN)) {
        if (++sg_key_scan_cnt >= KEY_DEBOUNCE_CNT) {   /* KEY_DEBOUNCE_CNT = 2 */
            sg_key_state = KEY_STATE_PRESSED;
            sg_key_scan_cnt = 0;
        }
    } else {
        sg_key_state = KEY_STATE_IDLE;                 /* 毛刺，回空闲 */
        return;
    }
    tal_sw_timer_start(sg_etimer_key_scan, KEY_SCAN_INTERVAL_MS, TAL_TIMER_ONCE);
}
```

2 次 × 20ms = 40ms 的确认窗口：短于 40ms 的尖峰脉冲被滤掉，而人的一次按压通常在 100ms 以上，不会误杀。这是"去抖"和"响应速度"的折中。

**PRESSED 态**——两件事：数够 250 次（5 秒）触发长按；读到高电平说明松手了：

```c
if (LOW == tal_gpio_read(USER_KEY_0_PIN)) {
    if (++sg_key_scan_cnt >= KEY_LONG_PRESS_CNT) {     /* 250 × 20ms = 5s */
        if (!sg_long_press_done) {                     /* 只触发一次 */
            sg_long_press_done = TRUE;
            __app_key_event_notify(KEY_LONG_PRESS_START);
        }
    }
} else {
    /* ── 松手 ── */
    app_led_key_release();
    if (!sg_long_press_done) {
        sg_key_press_times++;                          /* 计数 +1 */
        tal_sw_timer_stop(sg_etimer_key_multi);
        tal_sw_timer_start(sg_etimer_key_multi, KEY_MULTI_INTERVAL_MS, TAL_TIMER_ONCE);
    }
    sg_key_state = KEY_STATE_IDLE;
}
```

### 1.4 多击识别：松手重开 500ms 窗口

多击区分是本模块最巧的设计。常规思路是画按键时序图（按下间隔、释放间隔分别计时），代码又臭又长。本项目用了一个"以松手为锚点"的等价方案：

**每次松手都把一个 500ms 的单次定时器重新启动，定时器超时瞬间按累计点击数裁决事件。**

```c
STATIC VOID_T __app_key_multi_timeout_cb(TIMER_ID timer_id, VOID_T *arg)
{
    switch (sg_key_press_times) {
    case 1:  __app_key_event_notify(KEY_SINGLE_CLICK);  break;
    case 2:  __app_key_event_notify(KEY_DOUBLE_CLICK);  break;
    default: __app_key_event_notify(KEY_THREE_CLICK);   break;  /* ≥3 都算三击 */
    }
    sg_key_press_times = 0;
}
```

时序上是这样的（以"双击"为例）：

```
按下_                松手    按下_                松手              ←500ms 无操作→
  │___________________│      │____________________│
                      ↑                              ↑
              multi 定时器重启                定时器超时 → press_times==2 → 双击事件
```

代价是事件最晚延迟 500ms 才上报（单击要等 500ms 确认没有后续点击），换来的是实现极简且行为确定。对电表这种交互场景，500ms 的延迟完全无感。

`sg_long_press_done` 标志解决了一个边界：长按 5 秒触发配网后，用户松手时不应该再被算成一次单击——所以长按触发后清掉点击计数、停掉 multi 定时器。

### 1.5 事件分发

事件通知回调是纯粹的映射表：

```c
case KEY_SINGLE_CLICK:  app_lcd_page_next();                    break;  /* LCD 翻页 */
case KEY_DOUBLE_CLICK:  app_meter_test_start();                 break;  /* 电表自检 */
case KEY_THREE_CLICK:   app_lcd_all_segments_on();              break;  /* 全笔画测试 */
case KEY_LONG_PRESS_START:
    tal_sw_timer_start(etimer_join_start_delay, 50, TAL_TIMER_ONCE);    /* 50ms 后开始配网 */
    break;
```

长按故意再延迟 50ms 才调 `tal_zg_join_start`——让用户的手指先离开按键，避免 IRQ 与配网流程抢资源（配网时会有很多网络活动）。

## 二、LED：单次定时器自接力的模式机

### 2.1 需求分析

LED（PB5 推挽输出）要支持四种模式：OFF、ON、FAST_BLINK（250ms）、SLOW_BLINK（1500ms），外加两个特殊行为：

- 按键按下时**强制常亮**（不管什么模式），松手恢复——给用户"按到了"的即时反馈；
- 自检通过时**快闪 5 次**后自动恢复原模式。

没有硬件 PWM 可用，闪烁全靠软件定时器。

### 2.2 核心技巧：定时器自接力

不用周期定时器（`TAL_TIMER_PERIOD`），而是**每次回调里翻转电平、再启动一个单次定时器**：

```c
STATIC VOID_T __app_led_blink_cb(TIMER_ID timer_id, VOID_T *arg)
{
    if (sg_flash_remaining > 0) {              /* "闪 N 次"模式优先 */
        /* ... 计数递减，闪够次数后恢复原模式 ... */
        return;
    }

    if (sg_led_output_state) {                 /* 当前是亮 → 灭掉，定时 off_ms */
        __app_led_output_set(FALSE);
        tal_sw_timer_start(sg_etimer_led_blink, off_ms, TAL_TIMER_ONCE);
    } else {                                   /* 当前是灭 → 点亮，定时 on_ms */
        __app_led_output_set(TRUE);
        tal_sw_timer_start(sg_etimer_led_blink, on_ms, TAL_TIMER_ONCE);
    }
}
```

为什么要自接力而不是周期定时器？因为同一个定时器还要兼任"闪 N 次"的计数器（自检闪 5 次），而且周期定时器不好中途改周期（快闪/慢闪切换时）。自接力的好处是**每一次翻转都用当时的模式现场查表**，模式切换下一拍就生效，没有同步问题。

模式表：

```c
typedef struct {
    UINT16_T on_ms;
    UINT16_T off_ms;
} LED_BLINK_CFG_T;

STATIC CONST LED_BLINK_CFG_T sg_led_blink_table[] = {
    [LED_MODE_OFF]        = {0,     0   },
    [LED_MODE_ON]         = {0,     0   },
    [LED_MODE_FAST_BLINK] = {250,   250 },
    [LED_MODE_SLOW_BLINK] = {1500,  1500},
};
```

### 2.3 按键覆盖与强制模式：set_mode 的双胞胎

LED 模块有**两个**设置接口，区别是本篇最容易被忽略、却最重要的设计：

```c
/* 普通切换：记目标模式，按键按着时不动硬件 */
VOID_T app_led_set_mode(LED_MODE_E mode)
{
    sg_led_target_mode = mode;            /* 目标先记下来 */
    if (!sg_led_key_override) {           /* 按键按着？只记账，不动硬件 */
        sg_led_current_mode = mode;
        __app_led_apply_mode(mode);
    }
}

/* 强制切换：立即生效，清掉按键覆盖 */
VOID_T app_led_set_mode_force(LED_MODE_E mode)
{
    sg_led_target_mode = mode;
    sg_led_current_mode = mode;
    sg_led_key_override = FALSE;
    __app_led_apply_mode(mode);
}
```

- `app_led_set_mode`：比如断网时设 OFF——但如果用户**正按着按键**，LED 此刻处于"强制亮"状态，硬件不动，等松手时 `app_led_key_release()` 会应用 target mode。网络状态变化不能因为用户按着按键就丢失。
- `app_led_set_mode_force`：用于配网开始（快闪）这类强事件，直接清掉按键覆盖立即生效——总不能让 LED 在配网时还傻亮着。

对应的按键联动：

```c
VOID_T app_led_key_press(VOID_T)
{
    sg_led_key_override = TRUE;
    tal_sw_timer_stop(sg_etimer_led_blink);
    __app_led_output_set(TRUE);         /* 按下立刻亮 */
}

VOID_T app_led_key_release(VOID_T)
{
    sg_led_key_override = FALSE;
    __app_led_apply_mode(sg_led_target_mode);   /* 松手恢复目标模式 */
}
```

### 2.4 闪 N 次：自检的视觉语言

`app_led_flash_times(n, on_ms, off_ms)` 用于自检反馈：通过 = 快闪 5 次，失败 = 熄灭。实现上借了自接力定时器的壳：

```c
sg_flash_remaining = n * 2 - 1;    /* n 次闪烁 = 2n-1 次翻转（最后一次停在灭） */
__app_led_output_set(TRUE);
tal_sw_timer_start(sg_etimer_led_blink, on_ms, TAL_TIMER_ONCE);
```

回调里每翻一次 `sg_flash_remaining--`，减到 0 时**不是停在灭，而是调 `__app_led_apply_mode(sg_led_target_mode)` 恢复原来的模式**——这个"恢复"是后来一次修复改出来的：早期版本硬编码恢复成 ON，导致慢闪状态下闪完 N 次后 LED 莫名常亮。

## 三、两个模块的联动时序

把一次"双击启动自检"的完整时序串起来，看看这套小系统是怎么协作的：

```
用户按下按键
  → PB4 下降沿 IRQ：sg_key_state = DEBOUNCE，LED 强制亮
  → 40ms 后（2 次扫描）：确认按下，进入 PRESSED
  → 用户松手：LED 恢复目标模式，press_times=1，multi 定时器启动
  → 500ms 内用户再按一次：press_times=2，multi 定时器重启
  → 松手后再过 500ms：multi 超时 → 双击事件
  → app_meter_test_start() 开始逐相自检
  → 自检通过：app_led_flash_times(5, 250, 250) → LED 快闪 5 次 → 恢复原模式
```

全程没有一处阻塞，主循环（`tuya_main_loop`）一直空转——所有"时间"都由 20ms 扫描定时器和 LED 自接力定时器两个软件定时器承载。

## 四、踩坑实录

**坑 1：IRQ 里加 delay 去抖。**
新手最容易写的 `if (key_low) { delay_ms(20); if (key_low) ... }`。在 TuyaOS 里这会导致 20ms 内协议栈收发全部停摆，Zigbee 时序直接崩。记住：**中断里唯一的合法操作是置标志位/发消息**。

**坑 2：多击窗口期上报单击。**
如果在第一次松手时就立即报"单击"，双击就会被误报成两次单击。解法就是本节的"松手锚点 + 窗口超时裁决"——事件延迟换语义正确。

**坑 3：LED 闪 N 次后忘了恢复原模式。**
`app_led_flash_times` 用完一定要把状态机交还给 target mode，否则 LED 会停在不可预期的状态。这也是"当前模式"和"目标模式"必须分开存储的原因。

**坑 4：长按触发后松手误报单击。**
长按 5 秒触发配网，用户松手时 press_times 还停留在 1，会被当成单击翻页。`sg_long_press_done` 标志 + 长按触发时清零计数，缺一不可。

## 五、验证方法

1. 串口 log 开 DEBUG 级别，单次按压应看到：IRQ → DEBOUNCE → PRESSED → 松手后 500ms 出现 `KEY_SINGLE_CLICK`；
2. 快速连按两次，确认只出现一次 `KEY_DOUBLE_CLICK` 而非一次单击；
3. 按住 5 秒，确认长按事件只触发一次，松手后**没有**单击事件；
4. 长按触发配网时，按住按键不放，LED 应立即切快闪（`set_mode_force` 生效）；普通网络状态切换时按住按键，松手后 LED 应切到新状态（`set_mode` 记账生效）。

有条件的可以用示波器或逻辑分析仪抓 PB4 与 PB5 的波形，对照上面的双击时序和 LED 快闪 5 次过程。

## 六、小结

- 按键三件套：**IRQ 只做状态转移、20ms 扫描做去抖与长按计时、松手锚点 + 500ms 窗口做多击裁决**；
- LED 核心是自接力单次定时器，每次翻转现场查模式表，天然支持中途切模式和"闪 N 次"；
- `set_mode` / `set_mode_force` 的区分本质是"**事件不能丢**"和"**高优先级事件要立即生效**"两个需求的解耦；
- 所有交互延迟在百毫秒级，全部由软件定时器承载，主循环零负担。

下一篇进入 Zigbee 的核心仪式：配网。设备怎么判断"用户想让我入网"、入网失败怎么办、掉线怎么自救——一个 11 态的网络状态机，外加一个"三连上电"的祖传触发姿势。

---

*上一篇：[02 骨架] · 系列目录 · 下一篇：[04 入网：配网流程与网络状态机]*
