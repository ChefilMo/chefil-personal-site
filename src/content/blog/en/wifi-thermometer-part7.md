---
title: "Part 7: The Main-Loop State Machine — Assembling the Previous Six Parts into a Product"
description: "Parts 1–6 built the sensing, output, sleep, and self-healing blocks; this part assembles them into a product with a three-state main loop (WAKEUP → PROCESS → SLEEP): event-driven decisions on whether reporting is worth it, and a window system that budgets awake time."
pubDate: 2026-11-24
lang: en
translationKey: wifi-thermometer-part7
tags: [Embedded, STM32, Tutorial]
series: wifi-thermometer
seriesOrder: 7
category: embedded
---

> In the previous six parts we built the blocks one by one: sensing (I2C/ADC), output (UART), sleep (STOP), and self-healing (IWDG). Each works well on its own, but they are not yet a product — a product needs a "brain" to decide: **when to work, what work to do, and when to sleep**.
> This part builds that brain. It is the architectural hub of the whole series: every feature in Parts 8–16 will eventually hang off the tree we plant here.

---

## 1. Goals and What You'll Get

**Goal**: implement a three-state main loop — `WAKEUP → PROCESS → SLEEP → wake back into WAKEUP`. When nothing has changed, wake for 2 seconds and go back to sleep; when something changed (or a key press triggers it), enter a 5-second reporting window and handle UART communication inside the window; a key press can also extend the window.

**What you'll understand afterward**: why use a state machine instead of straight-line code, how the words "event-driven" can double battery life, and the "window" scheduling philosophy.

## 2. Theory in 10 Minutes

### 2.1 From straight-line code to a state machine

Suppose we skip the state machine; the main loop would most likely be written like this:

```c
while (1) {
    采样();
    上报();
    处理串口();
    睡觉10秒();
}
```

This is **period-driven**: every 10 seconds the entire pipeline runs unconditionally. It's simple, but fatal: the Wi-Fi module is the product's biggest power hog, and the loop above **powers up the module every 10 seconds** — even if the temperature hasn't budged. The battery isn't drained by use; it's drained by this "mindless diligence."

The state machine approach explicitly models "what should I do now" as a variable:

```c
typedef enum {
    ST_WAKEUP = 0,    // 刚醒：采样、判定
    ST_PROCESS,       // 窗口期：处理串口/协议
    ST_SLEEP          // 睡觉
} state_t;
```

`switch (s_state)` executes exactly one branch per loop, and the transition conditions are written at the end of each branch — **the transition rules are all in one visible place**. That's the state machine's first victory over straight-line code: you can draw the diagram and audit every edge.

### 2.2 Event-driven: stay awake only when it's worth it

The second victory is the soul of this part. When WAKEUP finishes its work, it doesn't report right away — it first asks one question:

> **"This time I woke up — is it worth powering up the Wi-Fi?"**

The product's decision checklist looks like this (in priority order):

1. **Woken by a key press** — the user is staring at the screen; must report;
2. **Force-report flag** — e.g. a key was pressed while the device was awake;
3. **Currently in pairing mode** — communication must stay alive during pairing;
4. **60 minutes since the last report** — a fallback heartbeat, so the cloud knows the device is alive even if nothing changed;
5. **Significant DP change** — temperature change ≥ 1℃, humidity change ≥ 5%RH, an alarm state flip, or never reported before.

**If none of the five hold → don't power up Wi-Fi; finish sampling and refreshing the screen, then go straight to sleep.** The product's real numbers: when there's nothing to report, an entire wake-up lasts about **50 milliseconds** — 0.5% of a 10-second period, with the remaining 99.5% spent in Deepstop. That's exactly how the average current turns "replace the battery monthly" into "replace it yearly."

### 2.3 The window system: budget your awake time too

Once the decision is "should report," we enter the PROCESS state, which uses a **window system**: set a maximum duration (10 seconds on the product), drive the UART protocol stack once every 10 ms inside the window; window exhausted? **Force sleep** — even if Wi-Fi hasn't connected yet.

Why must it be forced? Recall the lesson from the Part 6 bonus: **every wait must have a timeout**. The window is the "total timeout" for the entire awake phase: flaky Wi-Fi, weak signal, a module acting up — the worst case costs exactly one window's worth of battery. There will never be a case of "staying awake all night waiting."

The window also has two extension conditions (product rules, used later):

- **Key busy**: the user is clicking away; extend the window to serve them;
- **Buzzer busy**: an alarm is beeping; going to sleep would cut the PWM short.

The extension implementation is charmingly naive: while an extension condition holds, reset the window timer to zero and count again.

## 3. Hands-On: Writing the Code

The learning version implements a reduced but structurally identical three-state machine: 5-second window (product: 10 seconds), fallback of 3 cycles (product: 360), STOP replaced with a plain delay (the timed-wakeup principle was covered in the Part 5 original-product comparison), and a simplified report decision.

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

The three states:

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

Set the flag in the key interrupt (remember `volatile` — we covered why in Part 2):

```c
volatile bool g_key_event = false;
void EXTI0_IRQHandler(void) { EXTI->PR = EXTI_PR_PR0; g_key_event = true; }
```

`app_do_measurement()` is just Part 3's `gxht40_read()` + Part 4's ADC read + updating `s_cur_temp_x10` — the parts from the previous three articles bolt on unchanged. That's the dividend paid by modular layering.

## 4. Flashing and Acceptance

- [ ] After power-on, the first cycle prints `[WAKEUP] need report` (never reported before, so it must report) → 5-second window → `[SLEEP]`;
- [ ] In later cycles, when the temperature hasn't changed, it prints `nothing new, back to sleep` — **sample and sleep immediately, no window**;
- [ ] After 3 consecutive cycles, the fallback condition triggers and the reporting window opens again;
- [ ] Heat the sensor (or enlarge the decision threshold for a demo); once the temperature change exceeds 2℃, a reporting window triggers immediately;
- [ ] **Extension check**: enter the window and hold the key down — the "window over" print never appears until you release, and only then does the window close;
- [ ] From the serial log alone, you can draw the complete state-transition diagram of one cycle.

## 5. The Original Product (CIU32F003)

The learning version has the same skeleton as the product; the differences are all in parameters and the hardware layer:

| Item | Learning version | Product |
|---|---|---|
| Sleep | Plain delay placeholder | STOP/Deepstop + LPTIM 10 s timed wakeup + clock restore |
| Window | 5 s | 10 s (Wi-Fi startup + handshake + cloud connect + report takes that long) |
| Fallback | 3 cycles | 60 min = 360 LPTIM cycles |
| Significant change | temperature ≥2℃ | temperature / external temp ≥1℃, humidity ≥5%RH, alarm flip |
| Extension | Key press | key busy / buzzer busy / factory-test scan in progress |

The product also has two Wake-up inputs the learning version lacks: **key EXTI and key latching during Deepstop**. When the user presses a key while the device is asleep, the EXTI wakes the chip directly; WAKEUP sees "woken by key" and immediately enters a reporting cycle — this is the key to the product's interaction experience: within 1 second of the key press, the screen shows fresh data. Part 14, the key article, will expand on this.

## 6. Bonus: this architecture was "paid for," not "designed"

This elegant three-state + event-driven structure didn't start out this way. The product's early version actually looked like this (yes, exactly the style that section 2.1 criticized):

```
wake → power up Wi-Fi unconditionally → report unconditionally → sleep
```

It ran "perfectly fine" — until the current budget was calculated and something looked wrong: **powering up every 10 seconds, and Wi-Fi startup draws heavy current for those few seconds**, so average power consumption more than doubled. Worse, 99% of the data the cloud received was duplicate — the temperature might move 0.5℃ in an hour; why send a full report every 10 seconds?

The rework came in two steps: first change "report unconditionally" to "report only on change" (add the decision checklist and the report baseline), then change "stay for the full window even when idle" to "sample and sleep immediately" (an idle wake-up compressed to 50 ms end to end). Two commits, average current dropped by a wide margin, and battery life started being counted in multiples.

The real message of this story is the series' overarching theme: **the architecture of a small-resource product is squeezed out by power and memory budgets**. The budget is the architect — it makes the "event-driven" decision for you; skip it and you burn batteries. So if you read someone else's low-power code and find it "convoluted," look for its budget constraints first; the detours usually lead there.

One more field detail from back then: the reporting window was initially only 200 ms, and during testing, when the Wi-Fi cloud connection was slow, **frames were truncated halfway by sleep**, leaving the DP data missing limbs. The window was tuned all the way up to 10 seconds through incidents like this — **the window wasn't designed; it was forced out by the slowest cloud connection**.

## 7. What's Next

The brain exists, but it still lacks "conversation skills": how do we talk to the Wi-Fi module? Next up is Part 8, "Getting Started with the Tuya Protocol": a byte-by-byte dissection of the `55 AA` frame format, heartbeats, handshakes, work-mode queries — and you don't need to buy a module: we'll use a serial terminal on the PC to **play the role of** the Wi-Fi module, staging a little "human-vs-machine duet" with the MCU. Logic analyzer, it's your cue again.

---

*This series is adapted from a real mass-production project; every pitfall recorded here comes from actual development. Reading in order is recommended, as the parts depend on each other.*
