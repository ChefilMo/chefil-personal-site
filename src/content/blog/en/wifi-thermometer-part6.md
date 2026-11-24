---
title: "Part 6: Bitten Awake by the Dog in Your Sleep — the IWDG Watchdog and the Life-and-Death Inequality"
description: "Last time the MCU learned to sleep — but what if it hangs in its sleep? Enter the IWDG: an independent-clock countdown that can't be stopped once started, plus the life-and-death inequality that the overflow period must exceed the sleep period."
pubDate: 2026-11-24
lang: en
translationKey: wifi-thermometer-part6
tags: [Embedded, STM32, Tutorial]
series: wifi-thermometer
seriesOrder: 6
category: embedded
---

> In the last post the MCU learned to sleep: STOP mode + wake-up on keypress, and the current dropped from milliamps to microamps. But low power brought a new fear: what if the program gets stuck? If it hangs while awake, you notice on the spot; if it hangs while asleep, the device drains the battery in silence, and all the user sees is "it suddenly stopped updating."
> This post summons the head of security of the embedded world: **the Independent Watchdog (IWDG)**. And a life-and-death inequality written into a comment in the project's config.

---

## 1. Goals and the Payoff

**Goal**: install an auto-resurrection mechanism in the program — deliberately hang it, and 1.6 seconds later it resets itself and runs again, the serial counter starting over from zero.

**What you'll understand afterwards**: the essence of a watchdog as a "ignore me and I'll pull your reset" countdown, why it must run on an independent clock, why where you feed it is a science, and why its overflow period **must be greater than** the sleep period.

## 2. Ten Minutes of Theory

### 2.1 The Watchdog: A Countdown That Can't Quit

A watchdog is a down-counter; when it reaches 0 it triggers a system reset. Your job is to keep "feeding the dog" (reloading the counter) before it runs out. While the program runs happily, feeding is as automatic as breathing; once the program hangs somewhere with nobody feeding it, the countdown reaches zero — **the system reboots itself and recovers from the fault**.

Two key traits of the IWDG (Independent Watchdog):

1. **Independent clock**. It feeds on the chip's internal low-speed RC (about 40 kHz LSI on the STM32F103) and doesn't depend on the main clock system. In a low-power product this is decisive: **in STOP mode, where the main clock is switched off, the IWDG keeps ticking** — it is the only watchdog that "stays awake while you sleep";
2. **Can't be stopped once started**. Once software enables the IWDG, there's no way to turn it off until the next reset. This is fool-proofing by design: even a malfunctioning program "has no right" to shut the dog down. The side effect: **you must think through your feeding budget before enabling it** — there's no way back.

(There's also the WWDG, the window watchdog: it hangs off the main clock, stops in STOP mode, and requires feeding neither too early nor too late. Low-power products have no use for it — just know it exists.)

### 2.2 How to Calculate the Timeout

The IWDG timeout = prescaler × reload value ÷ LSI frequency. The F103's prescaler options are 4/8/16/…/256, and the reload value is 12 bits (max 4095):

```
超时 = (4 × 2^PR) × RLR / 40000
```

Pick a demo config of 1.6 seconds: `PR = 6` (divide by 256) × `RLR = 250` → 250×256/40000 = 1.6 s.

### 2.3 The Life-and-Death Inequality: Overflow Period > Sleep Period

Where this post's title comes from, and an iron rule for configuring a watchdog in a low-power product:

```
IWDG 溢出周期  >  一次完整睡眠 + 醒着干活的最坏时间
```

Why? Recall the sleep from Part 5: the device STOPs for 10 seconds, and during those 10 seconds the main program is parked at `__WFI()` with **nobody feeding the dog** (nor could they). If you configured an 8-second watchdog — the device sleeps 10 seconds each time, and at second 8 the dog bites it awake... not a wake-up — a **reset**: SRAM cleared, counters zeroed, start over. The device falls into an endless loop of "sleep → bite → reboot → sleep → bite", never getting any real work done.

The numbers for our product: **sleep 10 s, IWDG overflow 16.384 s**. The 6 seconds of margin cover the worst case of awake-time sampling, reporting, and protocol handling. This inequality was later written verbatim into a comment in the board-level config. The original text reads:

> Independent watchdog: the overflow period must be greater than the Deepstop sleep period (10 s); 16.384 s is chosen here.

### 2.4 Where to Feed the Dog Is a Philosophy

Choosing where to feed the dog is really answering the question "**what counts as a healthy program**":

- Feed in the **main loop**: the most common choice. If the main loop keeps spinning, the program is alive;
- Feed in an **interrupt**: a cardinal sin. Interrupts are triggered by hardware — even if the main loop is hung in `while(1)`, the timer interrupt still fires and still feeds the dog — the dog can never bite, and the watchdog becomes a decoration;
- Feed at **the entry of every state** (what the product does): feed once at the top of each case of the three-state machine, for finer granularity — even if the state machine spins a few extra rounds inside some state, as long as it's still turning, it's alive.

The converse also holds: if you find some long operation repeatedly pushing against the feeding period, **don't just casually add a feed inside an interrupt** — that's plugging your ears while stealing a bell. The right move is to redo the math: split the operation shorter, optimize the feeding points, or honestly admit that this operation needs a longer timeout.

## 3. Hands On: Writing the Code

### Experiment 1: Basic Watchdog — Feed It and Live, Don't Feed and Get Bitten

```c
#include "stm32f103xb.h"

static void iwdg_init_1s6(void)
{
    IWDG->KR  = 0x5555;              // 1. 解锁配置寄存器（不解锁不让写）
    IWDG->PR  = 6;                   // 2. 预分频 256
    IWDG->RLR = 250;                 // 3. 重装载 250 → 1.6 s
    while (IWDG->SR) { }             // 4. 等寄存器更新完成
    IWDG->KR  = 0xAAAA;              // 5. 先喂一口
    IWDG->KR  = 0xCCCC;              // 6. 启动！此后无法停止
}

static void iwdg_feed(void)
{
    IWDG->KR = 0xAAAA;               // 喂狗：重装 RLR
}
```

The main loop:

```c
int main(void)
{
    /* …时钟、串口初始化… */
    iwdg_init_1s6();
    uart_puts("system up\r\n");

    while (1) {
        uart_puts("alive\r\n");
        delay_ms(500);
        iwdg_feed();                 // 主循环末尾喂狗
    }
}
```

Once it runs normally, do the control experiment: comment out `iwdg_feed()` and re-flash. What you'll see: the serial port prints `system up` once every 1.6 seconds — the system is being bitten and reset over and over. **Seeing this dog bite with your own eyes** is what makes the lesson stick.

### Experiment 2: The Life-and-Death Inequality, Live

Set the timeout back to 1.6 seconds, then have the program "sleep" for 3 seconds before feeding the dog:

```c
while (1) {
    uart_puts("alive\r\n");
    delay_ms(3000);                  // 模拟一次超时长的任务/睡眠
    iwdg_feed();                     // 3s > 1.6s，永远到不了这里
}
```

What you'll see: `alive` prints exactly once, then the system resets every 1.6 seconds. This is the fate of "overflow period < work period". Now change the timeout to 4 seconds (`PR=6, RLR=625`), and the same 3-second delay can be fed in time.

Carry this over to the product context: STOP 10 s with nobody feeding, so the timeout must be > 10 s — **the inequality is not a suggestion; it's a hardware-level constraint where a misconfiguration means death**.

### Experiment 3: The Self-Destruct Button — Self-Healing from a Hang

Finally, a complete practical demo: press the button, the program deliberately hangs, and 1.6 seconds later the watchdog brings it back.

```c
void EXTI0_IRQHandler(void)          // 按键中断里设置卡死标志
{
    if (EXTI->PR & EXTI_PR_PR0) {
        EXTI->PR = EXTI_PR_PR0;
        extern volatile int g_panic;
        g_panic = 1;
    }
}

volatile int g_panic = 0;

int main(void)
{
    /* …初始化… */
    iwdg_init_1s6();
    uint32_t n = 0;
    while (1) {
        if (g_panic) {
            uart_puts("I am stuck...\r\n");
            while (1) { }            // ★ 故意卡死：没人喂狗了
        }
        n++;
        uart_puts("tick\r\n");
        delay_ms(200);
        iwdg_feed();
    }
}
```

Press the button → `I am stuck...` prints → 1.6 seconds later `system up` reappears on the serial port (assuming you print it after reset) — **the system resurrects itself from the hang**. This is the standard working picture of the watchdog as "the last line of defense".

## 4. Flashing and Acceptance

- [ ] Experiment 1 (feeding version): `alive` keeps printing, no resets;
- [ ] Experiment 1 (no-feed version): a reset every 1.6 seconds (startup banner reprinted, LED re-initialized and blinking);
- [ ] Experiment 2: timeout 1.6 s + 3 s delay → repeated resets; timeout changed to 4 s → normal. **Be able to explain why in one sentence**;
- [ ] Experiment 3: button-induced hang → auto-resurrect after 1.6 s;
- [ ] (Food for thought) If someone called `iwdg_feed()` inside a timer interrupt, would Experiment 3's hang still be rescued? Try it, then answer the question posed in Section 2.4.

## 5. The Original Product (CIU32F003)

The product's IWDG is configured during board-level initialization, with the timeout macro defined centrally: **16.384 seconds**, leaving 6 seconds of margin over the 10-second Deepstop period. The feeding point lives in the main loop — and more precisely, **the dog is fed once at the entry of each state of the three-state machine**, not uniformly at the end of the loop.

There's real reasoning behind this granularity: the product's awake phase runs UART protocol handling, sensor sampling, and possibly Wi-Fi interactions lasting several seconds (Part 11 will expand on this). If feeding were unified at the loop tail, any state lingering a bit too long could push against the timeout; placing the feed at each state entry amounts to declaring "**the state machine is still turning = the system is healthy**" — a feeding point aligned with business semantics survives later feature bloat far better than mindless loop-tail feeding.

Another product detail: the watchdog is configured **as early as possible after power-on**. The reason is plain — power-up initialization itself can hang (say, some peripheral fails to respond), and the dog has to be on the job early to cover that window.

## 6. Bonus: The Dog Is a Good Dog, but It Can't Read Business Logic

Midway through development, the product exhibited a strange symptom: everything looked fine — no hangs, no resets, the watchdog fed by the book — yet **every 10-second wake-up needlessly powered up the Wi-Fi module once**, burning power while no data ever got reported.

The investigation found: the DP cache state machine had a path that waited on a "handshake complete" flag, and in certain wake-up sequences that flag would never be set. So the state machine **loyally, tirelessly** hung in that wait loop; the main loop kept turning, the dog kept being fed, and from the watchdog's point of view the system was the picture of health — except the business was permanently parked at "waiting".

The fix looks trivial today: add a timeout to the wait, and fall back to a fallback branch afterwards. But it left behind a lesson more important than the fix itself:

> **A watchdog guarantees "the program is spinning", not "the business is moving".** Correct feeding points solve only half of system robustness; the other half is that every "infinite wait" must carry its own timeout fallback — waiting for a handshake needs a wait timeout, waiting for a sensor needs an NACK retry limit, waiting for Wi-Fi to connect needs a window cap. **Every wait must be timeout-able** — a discipline on par with "where to feed the dog".

This discipline later showed up in the sleep-window design as well (you'll see it in Part 7): the entire awake phase is wrapped in a window of at most 10 seconds, and when the window expires the device is forced to sleep — even if Wi-Fi hasn't connected yet. No "wait" gets the privilege of an unlimited deadline.

## 7. Next Up

Sensing, sleeping, and self-healing are all in place, but so far the main loop still works in straight-line "do the fixed steps in order" thinking. Next, Part 7, "The Main-Loop State Machine — The Big Picture": we'll assemble everything from the previous posts into the core architecture of this series — **the WAKEUP / PROCESS_UART / SLEEP three-state loop** — and explain why the words "event-driven" can multiply battery life several times over. Starting with Part 8, we begin talking to the Wi-Fi module.

---

*This series is adapted from a real mass-production project; every pitfall recorded here comes from real development. Reading in order is recommended, as the parts depend on each other.*
