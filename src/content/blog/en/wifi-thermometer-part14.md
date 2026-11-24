---
title: "Part 14: Buttons and Gestures — Debounce, Multi-Click, Long Press, and the Two Routes to “Woken from Sleep”"
description: "The LCD gives the product a face, but it still needs a hand. This part crams every interaction onto a single button — click, multi-click, and long-press gestures via 10 ms polling debounce — plus EXTI edge-wake to handle being pressed while asleep."
pubDate: 2026-11-24
lang: en
translationKey: wifi-thermometer-part14
tags: [Embedded, STM32, Tutorial]
series: wifi-thermometer
seriesOrder: 14
category: embedded
---

> The product has a face (the LCD), but it's still missing a hand: how does the user interact with it? This product's answer is a single button — every interaction is crammed onto one PB2: short-press to view data, long-press to enter pairing, five quick clicks to trigger OTA.
> Three gestures from one button, plus one hidden requirement: **if the device is asleep when you press it, it has to wake up**. Those are the two threads of this part.

---

## 1. Goals and What You'll See

**Goal**: build a complete button subsystem —

1. 10 ms polling debounce that reliably detects press/release;
2. Gesture recognition: single click, double click, multi-click (click counting), and long press (2 seconds — the learning-version threshold);
3. EXTI both-edges wakeup: press the button while the device is in STOP sleep, and it wakes up and reports "woken by button";
4. Hook it into the Part 7 state machine: single click = force report, long press = print "entering pairing (stub — for real in Part 17)".

**What you'll understand**: what mechanical bounce is, why debounce must use polling rather than interrupts, how to design the timing window for multi-click gestures, and why "sleep wakeup" and "awake gestures" are two parallel routes.

## 2. Theory in 10 Minutes

### 2.1 Bounce: The Inner Life of a Button

A mechanical button is not a clean switch. The moment the contacts close, they bounce for a few milliseconds to twenty milliseconds, and the waveform looks like this:

```
Ideal:   ──────┐        ┌──────────────
               └────────┘
Actual:  ──────┐ ┌┐ ┌─┐   ┌──┐ ┌────────
               └─┘└─┘ └──┘  └──┘
               ←bounce region→
```

If you took every edge at face value, one press would be read as "5 presses." The debounce idea is to **filter with time**: only count a press as real when the level has stayed **stable** for some number of milliseconds.

### 2.2 Why Debounce Uses Polling, Not Interrupts

Instinct says "use an interrupt for the button," but inside the bounce region the level keeps flip-flopping, and the interrupt will get hammered — 20 ms of bounce can trigger a dozen-plus interrupts, and on each entry you have no idea whether to believe it.

So the product-grade solution is always **polling + timed sampling**: read the button level once per 10 ms tick of the main loop (the PROCESS-state beat from Part 7), and run a small state machine for "stability determination":

```
IDLE ──press detected──▶ DEBOUNCE (confirm 2x)──confirmed──▶ PRESSED
  ▲                                                            │          │
  │                                                     still held     released
  │                                                            │          │
  │                                                     (timing,        ▼
  │                                                      long-press) RELEASE_DEBOUNCE ──confirmed──▶ count/dispatch gesture
  └──────────────────────────────────────────────────────────────────────────────────────────┘
```

### 2.3 Multi-Click and Long Press: A Matter of Two Timers

The entire secret of gesture recognition is **two timing quantities**:

- **Hold duration** `hold_ms`: accumulates every 10 ms while held. Exceed the long-press threshold (5 s in the product) → dispatch a long-press event (only once — no single clicks counted during the hold);
- **Multi-click window** `multi_click_ms`: a countdown starts on release (600 ms in the product). Press again within the window → count +1 and reset the window; window expires → dispatch by count: 1 = single click, 2 = double click, 5 = quintuple-click...

Note one design constraint: **when to dispatch the long press**. You can't dispatch the instant the hold reaches 5 s — if the user releases at 5.5 s, the long press dispatched at 5 s would fight the single click due at release. The product's approach settles the long press **at release**: during the hold you only set a flag, and at the release moment you check it — "long-press flag set and duration sufficient" → dispatch long press and swallow the click count; otherwise dispatch by click count. Simple and unambiguous.

### 2.4 Two Parallel Routes: Polling While Awake, Interrupts While Asleep

The "two routes" teased at the start of this part now unfold:

- **Device awake**: run the 10 ms polling state machine from 2.2 and recognize the full gesture;
- **Device asleep (STOP)**: polling is dead, so an **EXTI both-edges interrupt** (the capability from Part 5) wakes it up, and the interrupt does exactly one thing — **latch a "woken by button" flag**.

There's a subtlety in the post-waking flow: when the button wakes you up, your finger is most likely still pressing. The awakened polling state machine picks up from the "press stable" state, and the gesture can still be recognized in full — **the interrupt handles waking, polling handles understanding**. Clean division of labor.

## 3. Hands-On: Writing the Code

### Step 1: Debounce + Gesture State Machine (10 ms tick)

```c
#define BTN_LONG_PRESS_MS     2000     // 学习版长按 2s（产品 5s）
#define BTN_MULTI_WINDOW_MS    600
#define DEBOUNCE_CNT             2     // 连续 2 次采样确认（20ms 抗抖）

static const uint32_t BTN_PIN = 1 << 0;    // PA0，低电平按下

typedef enum { EV_NONE, EV_SINGLE, EV_MULTI, EV_LONG } btn_event_t;

static btn_event_t button_task_10ms(void)      // 挂在主循环 tick 上
{
    static uint8_t  state = 0, cnt = 0;
    static uint16_t hold_ms = 0, window_ms = 0, clicks = 0;
    static bool     long_flag = false;

    bool pressed = ((GPIOA->IDR & BTN_PIN) == 0);

    btn_event_t ev = EV_NONE;

    switch (state) {
    case 0:                                     // IDLE
        if (pressed) { cnt = 0; state = 1; }
        else if (clicks > 0 && ++window_ms >= BTN_MULTI_WINDOW_MS) {
            ev = (clicks == 1) ? EV_SINGLE : EV_MULTI;   // 窗口耗尽，结算手势
            clicks = 0;
        }
        break;
    case 1:                                     // DEBOUNCE 按下确认
        if (pressed && ++cnt >= DEBOUNCE_CNT) {
            state = 2; hold_ms = 0; long_flag = false;
        } else if (!pressed) state = 0;
        break;
    case 2:                                     // PRESSED 按住中
        if (++hold_ms >= BTN_LONG_PRESS_MS) long_flag = true;
        if (!pressed) { cnt = 0; state = 3; }
        break;
    case 3:                                     // RELEASE 松开确认
        if (!pressed && ++cnt >= DEBOUNCE_CNT) {
            if (long_flag) { ev = EV_LONG; clicks = 0; }
            else { clicks++; window_ms = 0; }    // 计入一次点击，等连击窗口
            state = 0;
        } else if (pressed) state = 2;
        break;
    }
    return ev;
}
```

### Step 2: EXTI Wakeup + Latching

```c
volatile bool g_wakeup_by_button = false;

void EXTI0_IRQHandler(void)             // 双边沿，PA0
{
    EXTI->PR = EXTI_PR_PR0;             // 清标志
    g_wakeup_by_button = true;          // 只锁存，别的不干（第 5 篇的原则）
}
```

### Step 3: Hooking Into the State Machine

```c
/* PROCESS 状态 tick 里 */
switch (button_task_10ms()) {
case EV_SINGLE:
    s_force_report = true;              // 单击 = 强制上报（第 7 篇的判定清单①）
    uart_puts("[btn] single -> force report\r\n");
    break;
case EV_MULTI:
    uart_puts("[btn] multi-click xN\r\n");
    break;
case EV_LONG:
    uart_puts("[btn] LONG -> enter pairing (stub)\r\n");   // 第 17 篇接真
    break;
}

/* WAKEUP 状态开头 */
if (g_wakeup_by_button) {
    g_wakeup_by_button = false;
    uart_puts("[wakeup] by button\r\n");
    s_force_report = true;              // 睡梦中被按醒 = 用户等着看数据，立即上报
}
```

## 4. Flash and Acceptance

- [ ] Single click: the serial port prints `[btn] single -> force report`, and the next cycle enters the report window (linked with Part 7);
- [ ] Quick double click, triple click: prints multi-click. **Rhythm test** — two clicks more than 600 ms apart should count as two single clicks, not one double click;
- [ ] Hold for over 2 s then release: prints LONG; holding still must not retrigger;
- [ ] Quintuple-click (five clicks within 600 ms): the click count reaches 5 (in the product this triggers OTA — for real in Part 16);
- [ ] Press while in STOP sleep: the device wakes, first prints `[wakeup] by button`, then runs gesture recognition normally — **waking and understanding each do their own job**;
- [ ] (Feel experiment) Set DEBOUNCE_CNT to 0 (no debounce) and press quickly — watch the serial events go wild. That's the first time bounce becomes visible.

## 5. The Original Product (CIU32F003)

The product's button subsystem is the full version of this part, with more "product-grade" parameters and semantics:

1. **PB2, active low, external pull-up** — saves the BOM cost of an internal pull-up resistor; the trade-off is that the IO configuration has to be double-checked against the hardware;
2. **Long press for 5 s = reset Wi-Fi and enter pairing**. The threshold was changed from 3 s to 5 s because 3 s is too easy to trigger by accident (the device gets reset while held in your hand); 5 s is the lower bound of "deliberate intent." Changing the threshold also needs supporting changes: after the reset the device stays awake waiting for pairing, up to 3 minutes, and returns to the low-power cycle once connected to the cloud — **the end of a gesture is an entire business flow**;
3. **Quintuple-click with a 600 ms window = OTA trigger**. The window was widened from 300 ms to 600 ms because "five fast clicks" is an extreme operation for ordinary users; the 300 ms tempo requirement was so demanding that even the testers couldn't do it;
4. **Button-busy window extension**. After a gesture is recognized, the UART window timer from Part 7 is cleared and extended — the user is operating the device, so it's not allowed to sleep;
5. **Latch detail for the sleep button**. The product clears the button wakeup flag once during power-on initialization, keeping only the latch from Deepstop — preventing button glitches during the initialization phase from being misread as user wakeups.

## 6. Bonus: The Button That Polling "Missed"

After the event-driven refactor (mentioned in the Part 7 bonus: when there's nothing to do, the device is only awake for 50 ms), a subtle edge case appeared: during the 50 ms the device is awake, if the user happens to press and release the button, the 10 ms polling catches it — but **if the button action happens to straddle the "falling asleep" boundary** (say, pressed a few milliseconds before entering STOP), the polling state machine hasn't had time to confirm it before the device falls asleep.

Symptom: the user presses once, and the device doesn't wake (because the EXTI wakeup is configured for "edges," and the edge produced by the press happens to land in the window where the EXTI hasn't been configured on the GPIO yet) — extremely low probability, but test long enough and you'll hit it.

The product's fallback design is elegant: **after waking, the EXTI latch flag is not fully cleared — a copy is kept for the WAKEUP state to check** — even if polling recognized no gesture, as long as the EXTI latch shows "there was a button edge while asleep," it's treated as a button wakeup and a report cycle starts. This is an extension of the "interrupts handle waking" route: **polling can miss; the interrupt latch doesn't lie**.

The general lesson of this case: **whenever two routes run in parallel (polling/interrupt, software/hardware), you need an "arbitration mechanism" for the handoff window** — when both routes claim to be reliable, the packets lost in the seam of the handoff are the real story.

## 7. Next Part Preview

The interaction chain is still missing its last piece of feedback: when a button is pressed or an alarm triggers, there has to be a sound telling the user "heard it / something's wrong." Next is Part 15, "The Buzzer": driving a passive buzzer with PWM, why the frequency is 2700 Hz, and the non-blocking timer design behind the "beep-beep-beep for 10 seconds" alarm — **no waiting inside interrupts; the buzzer sounds on its own**. The "buzzer-busy window extension" foreshadowed in Part 7 will be paid off then.

---

*This series is adapted from a real mass-production project; every pitfall described comes from actual development. Reading in order is recommended — the parts build on each other.*
