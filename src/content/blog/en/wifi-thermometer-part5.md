---
title: "Part 5: Put It to Sleep — STOP Mode, Timed Wakeup, and the Mystery of Waking Up 'With Amnesia'"
description: "First of the low-power trilogy: STOP mode drops the MCU to microamps, an EXTI button wakes it up, and we meet the series' most famous pitfall — the clock downgrades after wakeup, delays run 9× slow, and the serial port prints pure garbage."
pubDate: 2026-11-24
lang: en
translationKey: wifi-thermometer-part5
tags: [Embedded, STM32, Tutorial]
series: wifi-thermometer
seriesOrder: 5
category: embedded
---

> With all the sensing in place, a battery-powered product faces its real life-or-death question: **power consumption**. Running flat out around the clock, a single battery won't last a month; our goal is to have it asleep almost all the time — wake up once every 10 seconds, do its job, go straight back to sleep.
> This post is the first of the low-power trilogy: how to sleep, how to wake, and the most famous pitfall of the entire series — **after waking up, the world has changed**.

---

## 1. Goals and the Payoff

**Goal**: the MCU spends its idle time in STOP mode (current down to the microamp range), and only wakes to work when a button is pressed (blink the LED + say hello over serial), then goes right back to sleep. Along the way, use a multimeter to measure the current gap between "awake" and "asleep".

**What you'll understand afterwards**: the Cortex-M sleep-mode ladder, the difference between STOP and "fake sleep", what a wakeup source actually is, and why the clock must be reconfigured after every wakeup — this one is the soul of the whole post.

## 2. Ten Minutes of Theory

### 2.1 The Sleep-Mode Ladder: It's Not Just "Asleep" and "Awake"

The Cortex-M family offers a power-consumption ladder (the names are ARM's generic terms; individual chip vendors rename them):

| Mode | Core clock | Peripherals/SRAM | Wakeup source | Current |
|------|-----------|------------------|---------------|---------|
| Sleep | stopped | **all peripherals keep running** | any interrupt | roughly half |
| **Stop (deep sleep)** | stopped | clocks all stopped, **SRAM retained** | EXTI/RTC/low-power timer | a few µA ~ tens of µA |
| Standby (near death) | stopped | SRAM lost, only the backup domain survives | reset pin/RTC | 1~2 µA |

See the difference? **Stop is the sleep that remembers everything** — variables are still there, the program counter is still there, and execution resumes from the exact line where it fell asleep. Standby is the amnesiac sleep — SRAM is wiped, and waking up is the same as rebooting from reset.

Our product chose deep sleep (HuaDa calls it Deepstop, the Stop tier): **waking up able to continue running the program is the precondition of an event-driven architecture** — the state machine in the next part lives entirely off "resume from the breakpoint after waking".

Why isn't Sleep mode good enough? Its current is still in the milliamp range, because the clock tree keeps pumping blood to the peripherals. **The essence of saving power is cutting off the clock's food supply**: Stop mode shuts down the main clock generator entirely, leaving only a low-power clock source (a 32 kHz crystal or the internal low-speed RC) to power the "alarm clock".

### 2.2 Where Does the Alarm Clock Come From?

The STM32F103 doesn't have the product's kind of LPTIM (low-power timer); its STOP wakeup alarm is the RTC — and that configuration is fairly tedious. For the learning build we'll use the more intuitive option: **EXTI external-interrupt wakeup** (a button). The product's timed-wakeup principle gets its own section under "The Original Product", and the math is fun.

### 2.3 Entering STOP: Three Registers' Worth of Work

```c
PWR->CR &= ~PWR_CR_PDDS;              // 1. 选 Stop（不是 Standby）
SCB->SCR |= SCB_SCR_SLEEPDEEP_Msk;    // 2. 告诉内核：这次是深睡
__WFI();                              // 3. Wait For Interrupt，睡着
/* …… 被唤醒后，从这里继续 …… */
```

The wakeup source must be configured in advance: set the button pin as an EXTI falling-edge interrupt. Once asleep, press the button, EXTI fires, the core wakes, and execution continues from the line after `__WFI()`.

### 2.4 The Soul of This Post: After Waking Up, the Clock Has Been "Downgraded"

This is the most counterintuitive and most easily stepped-on pitfall, so it gets its own enlarged lecture.

STOP mode shuts down the main clock generator. At the instant of wakeup, to guarantee "something to run on immediately", the hardware automatically switches the system clock back to the **internal high-speed clock HSI (8 MHz)** — even if you were running at 72 MHz before bed.

The consequences cascade:

- The delay function's initial values were loaded for 72 MHz, but the code is now running at 8 MHz → **delays run 9× slow**;
- The UART baud-rate registers were computed for 72 MHz → after wakeup the actual baud rate is garbage, and the serial port prints pure mojibake;
- everything that depends on `SystemCoreClock` is silently out of tune.

**The correct posture**: the first thing after wakeup is to re-run the clock configuration (bring HSE+PLL back up, switch back to 72 MHz), and update the `SystemCoreClock` global variable in sync.

In the product firmware this operation is baked into a fixed ritual: the low-power-exit function automatically calls "clock restore", leaving the application layer no chance to forget it. In this post you will personally reproduce the "forgot to restore" failure — feel the pain first, then remember the cure.

## 3. Hands On: Writing the Code

### Step 1: Button EXTI Configuration (PA0)

```c
static void wakeup_button_init(void)
{
    RCC->APB2ENR |= RCC_APB2ENR_IOPAEN | RCC_APB2ENR_AFIOEN;

    GPIOA->CRL &= ~(0xF << 0);          // PA0 浮空输入
    AFIO->EXTICR[0] &= ~(0xF << 0);     // EXTI0 源 = PA0
    EXTI->IMR  |= EXTI_IMR_MR0;         // 不屏蔽
    EXTI->FTSR |= EXTI_FTSR_TR0;        // 下降沿触发
    NVIC_EnableIRQ(EXTI0_IRQn);
}
```

### Step 2: Enter STOP + Restore the Clock After Wakeup

Extract the 72 MHz clock configuration from Part 1 into a function `clock_config_72mhz()`, then:

```c
static void enter_stop(void)
{
    uart_puts("going to sleep...\r\n");
    while ((USART1->SR & USART_SR_TC) == 0) { }   // 等最后一个字节发完！（第 2 篇彩蛋）

    EXTI->PR = EXTI_PR_PR0;            // 清一次挂起标志，防误唤醒

    PWR->CR |= PWR_CR_CRDS;            // 调压器低功耗（省一点是一点）
    PWR->CR &= ~PWR_CR_PDDS;
    SCB->SCR |= SCB_SCR_SLEEPDEEP_Msk;
    __WFI();                           // ★ 睡着。唤醒后从下一行继续 ★
    SCB->SCR &= ~SCB_SCR_SLEEPDEEP_Msk;

    /* —— 唤醒必做：时钟降级了，立刻恢复 —— */
    clock_config_72mhz();              // 重开 HSE+PLL 并切回 72MHz
    SystemCoreClock = 72000000;        // 同步更新全局时钟变量
}
```

### Step 3: Main Loop — the Sleep-Wake Cycle

```c
int main(void)
{
    clock_config_72mhz();
    SystemCoreClock = 72000000;
    uart_init();
    wakeup_button_init();

    uint32_t wake_count = 0;
    while (1) {
        wake_count++;
        uart_puts("awake! #");
        uart_put_num(wake_count);      // 简易整数打印，前面篇练习过
        uart_puts("\r\n");

        for (int i = 0; i < 3; i++) {  // 闪 3 下灯表示"我醒了"
            led_toggle();
            delay_ms(100);
        }

        enter_stop();                  // 睡。下次按键醒来wake_count还在！
    }
}
```

The EXTI interrupt handler can be empty — its existence is only for wakeup; it has no work to do:

```c
void EXTI0_IRQHandler(void)
{
    EXTI->PR = EXTI_PR_PR0;            // 清挂起标志
}
```

**Key observation**: `wake_count` keeps incrementing across STOP — the SRAM survived. That's the value of Stop-tier deep sleep.

### Step 4: Measuring the Current (Multimeter Time)

Set the multimeter to the mA range and **insert it into the power supply loop** (battery positive → multimeter red probe → board VCC):

- Awake (blinking + sending serial): a few mA ~ twenty-something mA;
- Asleep (in STOP): drops to tens of µA or even lower (the Blue Pill's onboard power LED eats a chunk of that — don't be surprised; subtract it to get the MCU's true level).

A gap of over two orders of magnitude — that is the entire meaning of a low-power product.

## 4. Flashing and Acceptance

- [ ] After power-on, the LED blinks 3 times, the serial port prints `awake! #1`, followed by `going to sleep...`;
- [ ] Press the button: the LED blinks, `awake! #2` appears — **the count is continuous, SRAM intact**;
- [ ] Multimeter check: sleep current is two orders of magnitude below run current;
- [ ] **Failure reproduction** (mandatory): comment out the `clock_config_72mhz()` lines in `enter_stop()`, recompile and flash. Symptom: after button wakeup the LED blinks extremely slowly (9× slow) and the serial output is mojibake — this is the real "woke up with amnesia" crime scene the product actually stepped in. Restore the code and everything is normal.

## 5. The Original Product (CIU32F003): The Math of LPTIM Timed Wakeup

Nobody presses buttons on the product; it relies on **LPTIM1** (low-power timer), whose core trait is: **it keeps running even with the main clock fully off**, because it feeds on the independent low-speed clock RCL 32 kHz.

How do you load a 10-second timeout? LPTIM is a 16-bit counter, maxing out at 65535; counting 10 seconds directly at 32 kHz would reach 327680 — blown past the ceiling. So prescale first:

```
32768 Hz ÷ 8 = 4096 Hz        ← prescaler
4096 Hz × 10 s = 40960        ← under 65535, works
```

So the auto-reload register ARR = 40960 − 1: the counter counts from 0 to 40959, which is exactly 10 seconds; on overflow it fires the wakeup and the CPU is roused.

The product's complete wakeup chain: `LPTIM1 (RCL clock) → 10 s overflow → CPU wakes → first thing: restore the 48 MHz clock → sample and report → back to Deepstop`. The current ledger for the whole chain looks like this: in each 10-second period, ~50 ms awake working (a few mA), ~9.95 s in deep sleep (a few µA), averaging out to only tens of µA — and the battery's life can be counted in "years".

The product also has one more power-saving detail: before entering Deepstop, it switches off power-hungry peripherals like the ADC and the bandgap reference (BGR), turning them back on after wakeup. The full lights-out checklist before bed gets consolidated in Part 6, when we cover the watchdog.

## 6. Bonus: System Current Over Spec — The Culprit Was a Single IO Line

The product's whole-system current test failed. We turned the code upside down: clock downscaled, peripherals off, Deepstop entered... still high.

The oscilloscope plus a pin-by-pin hunt finally cornered the culprit: **PA3**.

After the Wi-Fi module powers down to sleep, a residual level remains on the IO on its side, and it backflows into the MCU through PA3. The MCU is in Deepstop with its IOs left in their default, unmatched states — like a sleeping person who forgot to close the door, the neighbor's current quietly seeps in. Every single component "met its spec"; add them together and you get a battery killer.

The fix: before entering Deepstop, configure PA3 as an **analog input** (input buffer off, physically close to disconnected), and while at it, set every unused pin on the board to analog input too. After that, current passed spec.

Here's a copy-paste-ready "pre-sleep checklist", paid for with the product's real money:

- [ ] The clock-restore function sits on the **first line** of the wakeup path, giving nobody a chance to skip it;
- [ ] The final frame of serial and other peripherals waits for **TC** (transmission complete) before sleeping;
- [ ] Power-hungry peripherals like ADC/BGR are off;
- [ ] Every IO connected to an external device is verified not to backflow in its sleep-state level (when in doubt, configure it as analog input);
- [ ] All unused pins go analog input, no floating allowed.

## 7. Next Up

It can sleep and wake now, but one fatal problem remains: if the program gets stuck in some corner — the MCU neither wakes nor complains, and the battery is quietly drained to death. Next up, Part 6: "Bitten Awake by a Dog in Your Sleep": the independent watchdog IWDG — a dog that only stops working when power is cut — and the life-or-death inequality "the overflow period must be longer than the sleep period".

---

*This series is adapted from a real mass-production project; every pitfall recorded here comes from real development. Reading in order is recommended, as the parts depend on each other.*
