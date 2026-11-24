---
title: "Part 18: Final Review — A 3 KB Ledger, a Pitfall Map, and the Road Ahead"
description: "The series finale: we open the 3 KB resource ledger, chart the depth distribution of 95 pitfalls, inventory the full skill tree, and point to three paths forward — RTOS, advanced debugging, and hardware."
pubDate: 2026-11-24
lang: en
translationKey: wifi-thermometer-part18
tags: [Embedded, STM32, Tutorial]
series: wifi-thermometer
seriesOrder: 18
category: embedded
---

> Eighteen posts in, we went from a dark LED to a complete product that can sense, connect, sleep, heal itself, upgrade over the air, and survive the production line.
> This final post teaches nothing new. It does three things: **open the ledger** (where the resources actually went), **draw the map** (how 95 pitfalls are distributed), and **point at the road ahead**.

---

## 1. The Resource Ledger: Where Did the 3 KB Go?

The real ledger at product ship:

| Resource | Budget | Actual usage | Headroom |
|----------|--------|--------------|----------|
| Flash (App) | 15 KB (OTA partition) | **13.2 KB** | ~1.8 KB |
| Flash (Bootloader) | 8 KB | **4.5 KB** | ~3.5 KB |
| SRAM | 3 KB | **~1.9 KB** (incl. 1 KB stack) | ~1.1 KB |

Zoom into the SRAM's 1.9 KB; the big-ticket items are:

- The 1 KB stack (hard-wired in the startup file; holds the working space of every interrupt and function call);
- The Tuya SDK protocol buffer at ~300+ B (the figure after the macro-order fix in Part 9);
- The 128 B TX buffer (sized by the largest frame of the "14-DP merged frame," Part 11);
- The rest is loose change — globals, state-machine variables, and per-module static buffers.

Within the Flash's 13.2 KB, two design choices directly saved a considerable number of bytes: **replacing the floating-point NTC formula with a 128-point lookup table** (zero floating-point library at runtime, Part 4), and **storing the segment table as a `const` array in Flash so it costs no RAM** (Part 13). On a small-resource chip, "saving" is never penny-pinching — it's an **architecture-level trade-off**.

**Learning-build readers can run their own ledger right now**: open the `.map` of your STM32F103 project and find `Image component sizes` — you'll see that RW+ZI sits far below the 20 KB budget. That is the essential difference between the learning build and the product: with generous resources, every "budget-driven" design (lookup tables, merged frames, trimming, event-based saving) looks optional. **I suggest one thought experiment: pretend your chip has only 3 KB, re-read Parts 4, 9, 11, and 12, and see which choices you would make the same way** — this mental gymnastics is the final step to internalizing the series.

## 2. The Pitfall Map: Ranking 95 Bugs by Depth

Three months of real development left roughly 95 commits, the majority of them fixes. Classify them by "debugging difficulty" and a clear pattern emerges:

**Five stars deep: silent failures** (hardware decides success or failure for you; software never notices)

- 0x02 empty-frame checksum misread as pairing state → factory reset on every power-up (Part 10)
- Forgot to unlock Flash before OTA writes → only the first frame lands, everything after silently dropped (Part 16)
- Wrong SDK macro order → multi-DP delivery silently rejected by the length guard (Part 9)
- Per-DP multi-frame reporting drops frames on weak links → missing entries on the app panel (Part 11)

**Four stars deep: handoff timing** (two correct actions; the seam between them goes wrong)

- SDA direction switch jumping the gun → bus locked solid, only a power cycle revives it (Part 3)
- Waiting for TXE but not TC → frame tail amputated by sleep (Part 2)
- The cache apply-vs-report ordering fight → stale value overwrites the user's setting (Part 11)
- Forgot to restore the clock after wake-up → all timing runs 6× slow (Part 5)
- A button press straddling the sleep boundary → missed by polling, saved by EXTI latching (Part 14)

**Three stars deep: the physical world** (the real temperaments of circuits and components)

- Back-feed current through PA3 after Wi-Fi power-down → whole-device power draw over budget (Part 5)
- NTC divider wired backwards → temperature readings drift ever further from sanity (Part 4)
- Divider left powered all the time → microamp-level leakage quietly eats the battery life (Part 4)

**Two stars deep: arithmetic discipline** (one miscalculation, collected months later)

- Flash allocated willy-nilly → the hot page worn through in 200 days (Part 12)
- Watchdog timeout < sleep period → bitten awake mid-dream, reset loop (Part 6)
- Production-test RSSI threshold set too low → borderline units slip out, then drop offline at users' homes (Part 17)

**The map's pattern is a single sentence: the costliest bugs to debug are all the ones that never report an error.** So the refrain that kept surfacing in this series — "if this path fails, who would ever see it?" — is no longer a piece of advice. It is a statistical conclusion distilled from 95 pitfalls.

## 3. What You Can Do Now: A Real Skill Tree

Spread the returns of 18 posts flat, and you get a skills list that belongs on a résumé under "Projects":

- **GPIO & register programming**: clock gating, alternate functions, open-drain/push-pull, BSRR atomic operations (Parts 1, 3)
- **Interrupts & concurrency**: NVIC, RXNE interrupts, `volatile`, "`move data only, inside the ISR`" (Part 2)
- **Bus protocols**: bit-level understanding of I2C timing, bit-bang implementation, bus-lock first aid (Part 3)
- **Analog acquisition**: ADC, divider design, NTC lookup tables with interpolation, open/short diagnostics (Part 4)
- **Low power**: STOP/Deepstop, wake-up sources, clock recovery, IO back-feed prevention (Part 5)
- **Robustness**: IWDG, the philosophy of where to feed the dog, the discipline of timeout fallbacks (Part 6)
- **Architecture**: state machines, event-driven design, windowed scheduling (Part 7)
- **Communication protocols**: frame formats, checksums, state-machine parsing, cache synchronization timing (Parts 8, 11)
- **SDK engineering**: porting, trimming, RAM budgeting, managing third-party code (Part 9)
- **Storage**: Flash erase/write, endurance budgeting, power-loss-safe layout (Part 12)
- **The whole peripheral family**: segment LCDs, PWM buzzers, button debouncing and gestures (Parts 13–15)
- **System level**: bootloaders, OTA, vector-table relocation, brick-proofing (Part 16)
- **Productization**: production-test design, smoke-test checklists, release discipline (Part 17)

Note what these skills share: **every one was taken from "it runs" to "it's safe to mass-produce."** That is exactly where this series parts ways with most tutorials.

## 4. What to Learn Next: Three Paths Forward

**Path 1: an RTOS (FreeRTOS).** Now is the best time — you've already hand-written state machines, timeslice scheduling, and timeout discipline on bare metal. When you look at RTOS tasks, semaphores, and software timers, you'll immediately understand that "they solve problems I've already met." Suggested first project: rewrite the three-state machine from Part 7 as a FreeRTOS task version, and compare code size and behavior. More instructive than any tutorial.

**Path 2: leveling up debugging and observability.** The world beyond serial logs: SWO single-wire output, ITM trace, Keil's event recorder, and advanced triggering on a logic analyzer. Debugging skill has the highest ROI in the entire skill tree — the "half-day detour" of Part 10 compresses down to half an hour once your equipment levels up.

**Path 3: one step toward hardware.** Reading schematics, computing dividers, knowing how a transistor drives a buzzer — this series has already walked you to the doorstep. The next step is systematic study: power trees, reset circuits, ESD, and EMC fundamentals. The "can hold a conversation" zone between pure software and pure hardware is an embedded engineer's most valuable ecological niche.

Whichever path you pick, learn it on the back of **one small product** — sensor, screen, connectivity, battery: assemble the full set of four, and let the constraints breed creativity.

## 5. Final Words

Return to the number from the start of the series: **3 KB**.

Eighteen posts in, you should now grasp the full meaning of that sentence: 3 KB forced static-memory discipline and zero heap allocation; 24 KB forced lookup tables over floating point and SDK trimming; battery power forced event-driven design and physically cutting Wi-Fi power; the mass-production goal forced production-test design and timeout fallbacks. **The budget is the best architect** — it never says a word, but every "nice-to-have" it vetoes makes the remaining design more honest.

If you built along hands-on from Part 0: congratulations — you've done what most computer-science students may not accomplish in four years: **walked the product's full life chain, from the first line of code to mass-production logic**. The Blue Pill on your breadboard and the real product behind this series share the same set of ideas.

If you jumped in somewhere in the middle: no problem. Every post tries to be self-contained, and it's never too late to go back and fill the gaps.

This is where the series ends. The 3 KB course is adjourned — for now.

---

**Full Series Table of Contents**

| # | Title | # | Title |
|---|-------|---|-------|
| 00 | Tooling & Environment Setup | 09 | Porting the Tuya SDK & the RAM Budget |
| 01 | Blink the First LED | 10 | Detective Work: The 7-Byte Empty-Frame Mystery |
| 02 | Make the MCU Talk | 11 | DP Data Flow & the Cache State Machine |
| 03 | Bit-Banging I2C: Read Temp & Humidity | 12 | Flash Persistence & Erase Endurance |
| 04 | ADC: The Battery and NTC | 13 | Segment LCD Driver & Porting |
| 05 | Put It to Sleep | 14 | Buttons & Gestures |
| 06 | The Watchdog & the Life-or-Death Inequality | 15 | Buzzer PWM & Non-Blocking Timers |
| 07 | The Main-Loop State Machine | 16 | OTA Bootloader |
| 08 | Tuya Protocol 101 | 17 | Production Test & Mass Production |
| | | 18 | **Final Review (this post)** |

*This series is adapted from a real mass-production project; every pitfall recorded here comes from real development.*
