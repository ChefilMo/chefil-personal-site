---
title: "Part 15: The Buzzer — PWM Tones, Where 2700 Hz Came From, and \"No Waiting While It Rings\""
description: "Drive a passive buzzer with TIM PWM and implement three non-blocking beep patterns — short beep, long beep, and a 10-second alarm — using a state machine on a 10 ms tick, with the UART window deferral honored while buzzing."
pubDate: 2026-11-24
lang: en
translationKey: wifi-thermometer-part15
tags: [Embedded, STM32, Tutorial]
series: wifi-thermometer
seriesOrder: 15
category: embedded
---

> One piece of interaction is still missing: sound. Key presses need confirmation, alarms need announcing, the five-tap OTA gesture needs a cue — it all comes down to one buzzer.
> The technical core of this part is not "making it ring," but **"while it rings, the main loop must not stop for a single minute."** Here is another recurring theme in embedded programming: time-slice scheduling — nobody gets to hog the CPU.

---

## 1. Goals and Results for This Part

**Goal**: use TIM PWM output to drive a passive buzzer and implement non-blocking beep scheduling —

1. Short beep, 100 ms (event cue);
2. Long beep, 2 seconds (simulating the "five-tap OTA confirm" cue; wired to the real thing in Part 16);
3. Beep-beep-beep for 10 seconds (alarm: 500 ms on / 500 ms off, looping for 10 seconds);
4. Raise a "busy" flag while buzzing — the UART window deferral from Part 7 is finally honored for real.

**What you'll understand afterward**: the fundamental difference between active and passive buzzers, the relationship between PWM frequency and pitch, and the time-slice pattern for non-blocking tasks.

## 2. Theory in 10 Minutes

### 2.1 Active vs. Passive: One Word Apart, Completely Different Circuits

Back in Part 0, when shopping for parts, I specifically told you to "buy the passive one" — now let's talk about why:

- **Active buzzer**: has a built-in oscillator circuit; feed it DC and it buzzes at a fixed frequency. Control is trivial (a GPIO high/low), but **the pitch is not controllable**, and its standby current is not trivial either;
- **Passive buzzer**: at its heart it's an electromagnetic diaphragm plus a coil — **feed it AC at some frequency and it rings at that pitch**. Driving it requires outputting a square wave — but in exchange you get two product-grade benefits: a selectable pitch (pick a band that isn't harsh, balancing loudness against power draw) and **power savings** (zero current at rest; it only draws power while ringing).

In the product, the buzzer is driven through an 8050 transistor (the IO pin can't source enough current for the coil directly), conducting on a high level.

### 2.2 PWM: Let the Timer Flip the GPIO for You

Could you toggle a GPIO in software to produce a 2700 Hz square wave? Sure, but the CPU would get woken up every 185 µs to flip a level — dumb and wasteful. TIM's PWM mode was invented for exactly this: **configure it once, and the hardware outputs the square wave automatically**, at zero cost to the CPU.

The frequency formula:

```
输出频率 = 定时器时钟 / ((PSC + 1) × (ARR + 1))
```

With a 72 MHz timer clock and a 2700 Hz target: `PSC = 71` (bringing it down to 1 MHz first), `ARR = 370` (1 MHz ÷ 370 ≈ 2704 Hz, close enough). The duty cycle is controlled by the capture/compare register CCR: `CCR = 185` is about 50%; `CCR = 259` is about 70%.

### 2.3 Where 2700 Hz Came From: A Human Experiment

2700 wasn't computed — it was **tried out**. Here's the product's real iteration history: it started at 2700 Hz → wanting it louder, they tried 4000 Hz → **too harsh; the whole team vetoed it, back to 2700**; the duty cycle was raised from 50% to 70% to recover loudness. There is no theoretically optimal solution for a buzzer's "acoustic parameters" — only an empirically tested one where "the target user group doesn't find it annoying in real environments." Every such parameter table should forever carry a footnote in small print: "Verified on actual humans; do not derive from theory alone."

### 2.4 Non-Blocking: Ringing for 10 Seconds ≠ Occupying the Machine for 10 Seconds

The most naive way to write a beep:

```c
void beep_10s_naive(void)
{
    for (int i = 0; i < 10; i++) {   // 响500ms停500ms × 10
        pwm_on();  delay_ms(500);
        pwm_off(); delay_ms(500);
    }
}
```

This rings just fine on a learning board, but in a product it's a **disaster**: for those 10 seconds the main loop grinds to a halt — the serial protocol stack starves (`wifi_uart_service` from Part 9 gets nobody feeding it), the watchdog gets nobody feeding it (Part 6: good thing this dog bites and resets on its own — a lifesaver), and the UART window logic goes haywire. **A single functional module has no right to freeze the entire system.**

The non-blocking approach flattens that loop into a state machine, spread across a 10 ms tick:

```
Beep task state machine:
  IDLE --beep_start(duration,mode)--▶ ON (counting down 500ms, PWM on)
                                       │time's up
                                       ▼
                                     OFF (counting down 500ms, PWM off)
                                       │time's up     │total duration up
                                       ▼               ▼
                                 (back to ON, loop)  IDLE (PWM off)
```

The main loop calls `beep_task()` every 10 ms, and the beep task manages its own rhythm — exactly **the same idea** as the main state machine in Part 7 and the cache state machine in Part 11: **break every long process into a state machine, and turn every wait into a countdown**. This sentence has now appeared for the third time in the series; it's worth copying onto the first page of your notebook.

## 3. Writing the Code

### Step 1: TIM PWM Configuration (TIM3 CH1, PA6)

```c
static void beep_pwm_init(void)
{
    RCC->APB1ENR |= RCC_APB1ENR_TIM3EN;
    RCC->APB2ENR |= RCC_APB2ENR_IOPAEN;

    GPIOA->CRL &= ~(0xF << 24);       // PA6 复用推挽 50MHz（AFIO 默认映射 TIM3_CH1）
    GPIOA->CRL |=  (0xB << 24);

    TIM3->PSC = 72 - 1;               // 72MHz → 1MHz
    TIM3->ARR = 370;                  // 1MHz / 370 ≈ 2704Hz
    TIM3->CCR1 = 259;                 // 占空比 70%
    TIM3->CCMR1 = (6 << 4)            // PWM 模式 1
                | TIM_CCMR1_OC1PE;
    TIM3->CCER = TIM_CCER_CC1E;       // CH1 输出使能
    TIM3->CR1 = TIM_CR1_ARPE;
    /* 注意：这里不开 TIM_CR1_CEN，由 beep 任务按需要启动 */
}

static void pwm_on(void)  { TIM3->CR1 |= TIM_CR1_CEN; }
static void pwm_off(void) { TIM3->CR1 &= ~TIM_CR1_CEN; TIM3->CNT = 0; GPIOA->BSRR = GPIO_BSRR_BR6; }
```

### Step 2: The Non-Blocking Beep Task

```c
typedef enum { BP_IDLE = 0, BP_ON, BP_OFF } bp_state_t;

static bp_state_t s_bp = BP_IDLE;
static uint16_t s_bp_tick = 0;        // 当前相位剩余
static uint16_t s_bp_total = 0;       // 总时长剩余
static uint16_t s_bp_on_ms = 500;     // 响/停节奏
static uint16_t s_bp_off_ms = 500;

bool beep_is_busy(void) { return s_bp != BP_IDLE; }

void beep_start(uint16_t total_ms, uint16_t on_ms, uint16_t off_ms)
{
    s_bp_total = total_ms; s_bp_on_ms = on_ms; s_bp_off_ms = off_ms;
    s_bp = BP_ON; s_bp_tick = on_ms;
    pwm_on();
}

void beep_task_10ms(void)             // 主循环每 10ms 调用
{
    if (s_bp == BP_IDLE) return;
    if (s_bp_total <= 10) {           // 总时长到：收工
        s_bp = BP_IDLE; pwm_off(); return;
    }
    s_bp_total -= 10;

    if (--s_bp_tick > 0) return;      // 当前相位没到点
    if (s_bp == BP_ON) { s_bp = BP_OFF; s_bp_tick = s_bp_off_ms; pwm_off(); }
    else               { s_bp = BP_ON;  s_bp_tick = s_bp_on_ms;  pwm_on();  }
}
```

The three sound effects are just three sets of parameters:

```c
beep_start(100,  100,   0);    // 短鸣：100ms 一声
beep_start(2000, 2000,  0);    // 长鸣：连续 2s（OTA 确认）
beep_start(10000, 500, 500);   // 滴滴滴：10s 间歇（告警）
```

### Step 3: Hooking It Into the Main Loop (Deferral Honored)

```c
/* PROCESS 状态的 tick 里 */
beep_task_10ms();
if (beep_is_busy())                 // 蜂鸣忙 → 第 7 篇的顺延条件
    s_window_tick = 0;

/* SLEEP 状态：进 STOP 前 */
pwm_off();                          // Deepstop 期间必须静音且引脚拉低
```

## 4. Flashing and Acceptance

- [ ] Power on: one short beep (startup cue);
- [ ] Single key press: short beep as confirmation (see Bonus 2 — the product ultimately cut this; the learning version lets you experience it first, then the product decides);
- [ ] Long press triggers a 2-second long beep; **keeps responding** to single clicks during the long beep (direct evidence of non-blocking: the system isn't frozen);
- [ ] Trigger the "alarm": beep-beep-beep for 10 seconds, with the serial heartbeat printing normally the whole time (contrast with the deathly silence of the blocking version in Section 2.4);
- [ ] The window does not close while buzzing (deferral honored); the countdown starts only after the beep finishes;
- [ ] Measure the two buzzer pins with a multimeter: AC component while ringing, zero when silent — the passive buzzer's "power on demand" is visible to the naked eye.

## 5. The Original Product (CIU32F003)

Parameters and details of the product's buzzer subsystem:

1. **PA5 + TIM3 PWM, 2700 Hz, 70% duty cycle** — the conclusion of the human experiment in Section 2.3;
2. **The three-effect semantic set**: five-tap OTA confirm = 2-second long beep (**enter the Bootloader only after the long beep finishes** — the cue must play in full; no resetting halfway through a beep); temperature/humidity alarm = beep-beep-beep for 10 seconds (500/500 pattern); short-press cue = **canceled**;
3. **Silence is a product decision**. The alarm sound is governed by the "alarm mute" DP (the mute entry in the Part 11 glossary, **muted out of the factory**) — users' tolerance for "sudden beeping in the middle of the night" is negative, so sound must be opt-in;
4. **The device stays awake during the alarm**. During the 10 seconds of beep-beep-beep, the device does not enter Deepstop: the PWM clock would stop, the pin state would become uncontrollable, and the cue would cut out — which is why "buzzer busy" joins the deferral condition (Chapter 7) and the sleep guard;
5. **PA5 must be low during Deepstop**. Before entering STOP, call `pwm_off()` and actively pull the pin low, to keep the transistor from leaking current in that half-on, half-off state (Chapter 5's "pre-sleep checklist" gains one more line).

## 6. Bonus 1: The "Life and Death" of the Short-Press Beep

The acceptance checklist in the learning version has you implement the short beep on key press — and then tells you the product cut it. It's not that the feature couldn't be built; it's **a conspiracy of three product-grade reasons**:

1. **Power savings**: every 100 ms short beep is pure expense on the battery ledger, and what it buys is a replaceable experience like "the key press has feedback" (the LCD refresh is itself feedback);
2. **Scene interference**: thermo-hygrometers live in bedrooms, and any cue sound at night is a demerit (same logic as the mute DP defaulting to muted);
3. **Factory-floor noise**: when hundreds of devices are being tested simultaneously in the factory and every one goes "beep," nobody hears anything anymore.

This trade-off is worth writing down: **whether a feature exists doesn't depend on "can it be done," but on "the total payoff across all scenarios after it's done."** In the learning phase you implement everything; in the product phase you cut features everywhere — that's not regression, it's two different jobs.

## 7. Bonus 2: An Autopsy of the Blocking Beep

A real debugging scene, reconstructed: during an integration test of the alarm feature, a test colleague reported "after triggering the alarm, the App gets no response from the device for 10 seconds, then everything is back to normal."

Look at the code: inside `beep_alarm()` lurked that naive loop from Section 2.4. For 10 seconds, `wifi_uart_service()` starved — the heartbeats from the Wi-Fi module went unanswered, so per the protocol the module judged "the MCU is dead" and disconnected and reconnected; 10 seconds later the beep ended, the main loop recovered, and everything was "normal."

The classic thing about this bug is that **its symptoms point entirely in the wrong direction**: "App unresponsive" — the first reaction is network problem, cloud problem, Wi-Fi module problem — who would suspect a buzzer? Yet it was nothing more than the most ordinary form of "one module froze the system with `delay_ms`." **When debugging any 'periodic disconnection,' first list all the code that executed a delay inside the disconnection window** — that's a directly usable takeaway this case leaves behind.

## 8. Next Part Preview

Only one last — and biggest — piece remains in the feature puzzle: OTA. What do you do when the firmware has a bug? Crack the case open and reflash? No — the users are all over the world. Next up, Part 16, "OTA Bootloader": Flash partitioning, how the Bootloader decides "jump to the App or wait for an upgrade," how upgrade data gets written into Flash, and the mystery of "dies after receiving a single frame." The five-tap foreshadowing planted in Part 14 finally pays off.

---

*This series is adapted from a real mass-production project; the pitfalls described all come from actual development. Reading in order is recommended, as the parts depend on one another.*
