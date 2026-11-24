---
title: "03 · Limbs: Button State Machine and LED Mode Machine"
description: "A three-state button machine plus a self-relaying-timer LED mode machine: IRQ debounce, release-anchored multi-click arbitration, flash-N-times and mode recovery — all zero-blocking, with four hard-won pitfalls."
pubDate: 2026-11-24
lang: en
translationKey: zigbee-meter-part3
tags: [Embedded, Zigbee, Tutorial]
series: zigbee-meter
seriesOrder: 3
category: embedded
---

> Goal: one button recognizing single/double/triple click and long press, one LED handling steady on/fast blink/slow blink/flash N times — all fully non-blocking

---

Never underestimate a single button and a single LED — they are the device's only two human-machine interaction organs, and together they act out the two most classic patterns in embedded programming (**interrupt + timer scanning** and **single-shot timer self-relay**). The two modules in this article add up to under 400 lines of code, but they deserve a line-by-line walkthrough.

## Part 1. Button: Interrupt Wakeup + 20ms State Machine

### 1.1 Hardware and Overall Approach

The button is wired to PB4, configured as pull-up input with a falling-edge interrupt (active low). Design goals:

| Action | Meaning |
|--------|---------|
| Short press | LCD page flip |
| Double click | Meter self-test |
| Triple click | LCD all-segments test (screen test mode) |
| Long press 5s | Trigger Zigbee network joining |

Hardware interrupts come with bounce built in (the moment the button contacts close, a few milliseconds of glitches appear). If you count presses directly inside the IRQ, one press can easily be counted as three. The most naive debounce is `delay_ms(20)` inside the IRQ — **this is strictly forbidden**: sleeping in an interrupt means the whole system sleeps with you. This project's solution has three layers:

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

### 1.2 What the Interrupt Does (and Doesn't)

The button module's IRQ handler has only a few lines of real logic:

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

Note two details: first, the IRQ contains **no waiting and no loops** — it sets a state, lights an LED, starts a timer, and gets out; second, it uses `sg_key_state == KEY_STATE_IDLE` as a gate — another falling edge while already pressed (a fake interrupt from bounce) is simply ignored. That's the first line of defense.

Button registration follows the two-stage split from the previous article: `app_key_init()` only creates the software timer in `tuya_init_second`, while `app_key_init_hw()` doesn't register the GPIO IRQ until `tuya_init_third`.

### 1.3 The Scan State Machine: Three States Are Enough

```c
typedef enum {
    KEY_STATE_IDLE = 0,     /* 空闲，等待 IRQ */
    KEY_STATE_DEBOUNCE,     /* 去抖：确认"真的按下" */
    KEY_STATE_PRESSED,      /* 已确认按下：检测长按与松手 */
} KEY_STATE_E;
```

The scan callback fires every 20ms:

**Debounce state** — enter PRESSED only after 2 consecutive low reads:

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

2 reads × 20ms = a 40ms confirmation window: spikes shorter than 40ms are filtered out, while a real human press usually lasts over 100ms, so it's never killed by mistake. This is the trade-off between "debouncing" and "responsiveness."

**PRESSED state** — two jobs: fire long press after 250 counts (5 seconds); a high read means the button was released:

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

### 1.4 Multi-Click Recognition: Restarting a 500ms Window on Release

Multi-click discrimination is the cleverest part of this module. The conventional approach is to draw a button timing diagram (timing press intervals and release intervals separately), and the code turns out long and ugly. This project uses an equivalent scheme "anchored on release":

**Every release restarts a 500ms one-shot timer, and the moment that timer expires, the accumulated click count arbitrates the event.**

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

The timing looks like this (using a "double click" as the example):

```
按下_                松手    按下_                松手              ←500ms 无操作→
  │___________________│      │____________________│
                      ↑                              ↑
              multi 定时器重启                定时器超时 → press_times==2 → 双击事件
```

The cost is that the event is reported at most 500ms late (a single click must wait 500ms to confirm no follow-up click), in exchange for an extremely simple and deterministic implementation. For a meter's interaction scenarios, a 500ms delay is completely imperceptible.

The `sg_long_press_done` flag solves one edge case: after a 5-second long press triggers network joining, the user's release must not be counted as a single click — so when long press fires, the click counter is cleared and the multi timer is stopped.

### 1.5 Event Dispatch

The event notification callback is a pure mapping table:

```c
case KEY_SINGLE_CLICK:  app_lcd_page_next();                    break;  /* LCD 翻页 */
case KEY_DOUBLE_CLICK:  app_meter_test_start();                 break;  /* 电表自检 */
case KEY_THREE_CLICK:   app_lcd_all_segments_on();              break;  /* 全笔画测试 */
case KEY_LONG_PRESS_START:
    tal_sw_timer_start(etimer_join_start_delay, 50, TAL_TIMER_ONCE);    /* 50ms 后开始配网 */
    break;
```

The long press deliberately waits another 50ms before calling `tal_zg_join_start` — to let the user's finger leave the button first, avoiding contention between the IRQ and the joining procedure (joining involves a lot of network activity).

## Part 2. LED: A Mode Machine Built on Single-Shot Timer Self-Relay

### 2.1 Requirements Analysis

The LED (PB5 push-pull output) must support four modes: OFF, ON, FAST_BLINK (250ms), SLOW_BLINK (1500ms), plus two special behaviors:

- While the button is held, **force steady on** (regardless of mode), and restore on release — giving the user instant "I pressed it" feedback;
- On a successful self-test, **flash quickly 5 times** and then automatically restore the original mode.

There's no hardware PWM available; all blinking is done in software timers.

### 2.2 The Core Trick: Timer Self-Relay

Instead of a periodic timer (`TAL_TIMER_PERIOD`), the design **toggles the level in each callback, then starts another one-shot timer**:

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

Why self-relay instead of a periodic timer? Because the same timer also doubles as the counter for "flash N times" (self-test flashing 5 times), and a periodic timer is awkward to re-time mid-flight (when switching between fast and slow blink). The beauty of self-relay is that **every toggle looks up the mode table live**, so a mode switch takes effect on the very next beat with no synchronization issues.

The mode table:

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

### 2.3 Button Override and Forced Mode: The set_mode Twins

The LED module has **two** setting interfaces, and the difference between them is the easiest-to-overlook yet most important design in this article:

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

- `app_led_set_mode`: say the network drops and you want OFF — but if the user is **holding the button** right now, the LED is in its "forced on" state, so the hardware is left alone; on release, `app_led_key_release()` applies the target mode. A network state change must not be lost just because the user happens to be pressing the button.
- `app_led_set_mode_force`: used for strong events like the start of network joining (fast blink), which clears the button override and takes effect immediately — you certainly can't have the LED sitting there dumbly lit while joining the network.

The corresponding button interplay:

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

### 2.4 Flash N Times: The Visual Language of Self-Test

`app_led_flash_times(n, on_ms, off_ms)` is used for self-test feedback: pass = 5 quick flashes, fail = turn off. The implementation borrows the shell of the self-relaying timer:

```c
sg_flash_remaining = n * 2 - 1;    /* n 次闪烁 = 2n-1 次翻转（最后一次停在灭） */
__app_led_output_set(TRUE);
tal_sw_timer_start(sg_etimer_led_blink, on_ms, TAL_TIMER_ONCE);
```

Each toggle in the callback decrements `sg_flash_remaining--`, and when it reaches 0, instead of **staying off, it calls `__app_led_apply_mode(sg_led_target_mode)` to restore the original mode** — and that "restore" came out of a later fix: the early version hardcoded the recovery to ON, which made the LED inexplicably stay lit after flashing N times under slow-blink mode.

## Part 3. Interaction Timeline of the Two Modules

Let's string together the full timeline of a "double click to start self-test" and see how this little system cooperates:

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

Nothing blocks anywhere; the main loop (`tuya_main_loop`) just idles the whole time — all "time" is carried by two software timers: the 20ms scan timer and the LED self-relay timer.

## Part 4. Pitfalls in the Trenches

**Pitfall 1: Adding a delay for debounce inside the IRQ.**
The easiest thing for a beginner to write: `if (key_low) { delay_ms(20); if (key_low) ... }`. In TuyaOS this stalls all protocol stack sending and receiving for 20ms, and the Zigbee timing collapses outright. Remember: **the only legal operations inside an interrupt are setting flags / posting messages**.

**Pitfall 2: Reporting a single click during the multi-click window.**
If you report "single click" immediately on the first release, a double click will be misreported as two single clicks. The solution is exactly this section's "release anchor + window timeout arbitration" — trading event latency for semantic correctness.

**Pitfall 3: Forgetting to restore the original mode after flashing N times.**
Once `app_led_flash_times` finishes, the state machine must be handed back to the target mode, otherwise the LED ends up in an unpredictable state. This is also why "current mode" and "target mode" must be stored separately.

**Pitfall 4: A release after long press misfires as a single click.**
After a 5-second long press triggers joining, press_times is still sitting at 1 when the user releases, and would be treated as a click that flips the page. The `sg_long_press_done` flag plus clearing the counter when long press fires — both are indispensable.

## Part 5. How to Verify

1. Set the serial log to DEBUG level; a single press should show: IRQ → DEBOUNCE → PRESSED → `KEY_SINGLE_CLICK` 500ms after release;
2. Press twice in quick succession and confirm only one `KEY_DOUBLE_CLICK` appears, not two single clicks;
3. Hold for 5 seconds and confirm the long press event fires only once, and that **no** single click event follows the release;
4. When long press triggers joining, hold the button without releasing: the LED should switch to fast blink immediately (`set_mode_force` takes effect); during an ordinary network state change while the button is held, the LED should switch to the new state on release (`set_mode` bookkeeping takes effect).

If you have the gear, grab the waveforms of PB4 and PB5 with an oscilloscope or logic analyzer and check them against the double-click timeline and the LED's 5-quick-flash sequence above.

## Part 6. Summary

- The button's three-piece set: **the IRQ only does state transitions, the 20ms scan handles debounce and long-press timing, and the release anchor + 500ms window arbitrates multi-clicks**;
- The LED's core is the self-relaying single-shot timer; every toggle looks up the mode table live, which natively supports mid-stream mode switches and "flash N times";
- The distinction between `set_mode` / `set_mode_force` is essentially the decoupling of two requirements: "**events must not be lost**" and "**high-priority events must take effect immediately**";
- All interaction latencies are in the hundreds-of-milliseconds range, entirely carried by software timers, with zero burden on the main loop.

The next article enters the core ritual of Zigbee: network joining. How does the device decide "the user wants me on the network," what to do when joining fails, and how to save itself after dropping off — an 11-state network state machine, plus a time-honored "triple power-on" trigger gesture.

---

*Previous: [Part 2 · Skeleton] · Series Index · Next: [Part 4 · 入网：配网流程与网络状态机]*
