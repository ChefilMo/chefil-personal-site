---
title: "13 · Finale: System Integration, the Road to Mass Production, and a Project Retrospective"
description: "The finale: a system integration checklist and shared-resource conflict matrix, authorization flashing and factory testing, an engineering-lessons retrospective across all 15 posts, plus a known-issues list and a reproduction roadmap."
pubDate: 2026-11-24
lang: en
translationKey: zigbee-meter-part13
tags: [Embedded, Zigbee, Tutorial]
series: zigbee-meter
seriesOrder: 13
category: embedded
---

> Goal: a methodology for system integration, authorization flashing and mass production, a retrospective of the project's full evolution, and advice for anyone tackling a similar project

---

## 1. System Integration: When All the Modules Talk at Once

The previous 12 posts followed a "divide and conquer" approach — every module explained thoroughly in isolation. But the real difficulty lies in integration: **each module being correct ≠ the whole system being correct**. Shared resources between modules, timing coupling, and state dependencies only surface when everything runs at full speed.

This project's system integration checklist (in dependency order):

### 1.1 Startup Sequence (Within 3 Seconds of Power-On)

The complete sequence you should see on the debug UART, condensed into a text timeline:

1. `first init` — UART initialized, log system ready, application version printed;
2. `second init` — Zigbee endpoint/cluster registration, triple power-on join detection;
3. `third init` — LED/button GPIO initialization;
4. `last init` — data model, send queue, both metering chips, and LCD initialized in order;
5. The timestamp delta across the init section should be **< 100ms** — this is how the Part 02 rule "no time-consuming work in init" is verified: synchronous initialization (SPI metering chip + UART metering chip + LCD) must complete within a hundred milliseconds; the remaining async tasks (metering chip verification, first sampling) are handed off to timers;
6. About 200ms after power-on, the metering chip verification flow starts asynchronously.

### 1.2 Steady-State Operation (After Joining the Network)

With one sampling cycle every 10 seconds, the log rhythm should be: first the aggregated three-phase voltage/current/total power and temperature are printed (keep a close eye on the `all_ok` flag — it's the master switch meaning "all phases were read successfully this cycle"), followed by the DP report frames actually sent after deadband filtering, and finally the frame-by-frame send queue acknowledgments. The three log lines correspond one-to-one: **sampling → filtering → delivered**. Silence at any stage is a fault signal.

### 1.3 Resource Conflict Matrix

During integration, what you need to watch most is **shared resources**. A table for self-checking:

| Resource | Users | Conflict scenario | Solution |
|----------|-------|-------------------|----------|
| UART0 | Metering chip (UART model) | Early logs fought it for the port | Logs moved to the bit-banged UART pins |
| Software timer pool | All modules | Timer leaks / reuse | Each module creates its own; stop before start |
| Flash | OTA / KV storage | Writing KV during OTA bricks the device | Stop all timers in the OTA callback |
| Metering chip state machine | verify / calc / re-init | Re-entry deadlock | busy flag + unified entry check |
| Zigbee send queue | DP queue / acknowledgments | zcl_id clearing each other | Queue and acks use independent zcl_ids |
| Global data model | sampling writes / report reads / LCD reads | Torn data | Single-threaded event-driven, naturally race-free (ISRs only write to their own buffers) |

The last row deserves elaboration: this project has no mutex locks at all, because **the entire architecture is single-threaded and event-driven** — all accesses to the shared data model happen in the main event loop (timer callbacks, message callbacks), and the ISRs (UART RX, button IRQ) never touch shared data, writing only to their own private buffers. **"Eliminate locks with architecture" is far more elegant than "sprinkle locks everywhere."**

## 2. The Road to Mass Production: From Dev Board to Product

### 2.1 Authorization Flashing (The Unavoidable 7-Day Limit)

As mentioned in Part 01: firmware flashed directly with BDT runs for a maximum of 7 days. This is Tuya's authorization mechanism — a real product must write the authorization information (keys bound to the PID) into a designated Flash region, which the firmware verifies at startup.

The mass production flow:

1. Submit the product for certification on the Tuya IoT platform and obtain the authorized flashing tool (authorization codes generated in the cloud);
2. Install the authorized flashing tool on the production-line PC; flash the QIO bin + write the authorization;
3. Each device registers and activates with the Tuya cloud on its first network connection.

You can ignore authorization during development (7 days is plenty for debugging), but certification must be completed before sending samples or going into mass production — **put this in the project plan, because the certification cycle is often longer than you expect**.

### 2.2 Production-Line Test Procedure

Combining the self-test features from Parts 10/11, here is a minimal production test station:

```
1. 烧录授权固件，上电
2. 检查 LCD 显示全零（不是黑屏/乱码）
3. 三击按键 → 全笔画 → 肉眼检段
4. 接标准负载（220V/89W），双击 ×3 依次测 A/B/C 相
   → 每相 LED 闪 5 次 = 合格
5. 夹具触发三连上电 → 进入配网 → 测试网关确认设备上线、38 个 DP 上报正确
6. 拆夹具，贴标
```

The whole process takes under 2 minutes and covers the three major functions: display, metering, and communication.

### 2.3 Factory Default Configuration

The initialization defaults of the data model *are* the factory semantics: power threshold 500W, switch OFF, all calibrations 0. Factory reset (the triple-zeroing from Parts 04/08) pulls the device back to this state. **The defaults table must be explicitly maintained in the product documentation** — "what state is the device in after a factory reset" is a high-frequency customer-support question.

## 3. Project Evolution: Engineering Lessons from the Entire Development Process

Looking back at the whole development process, this project's evolution is itself a miniature history of embedded development. Grouped by theme, there were three stages:

### 3.1 From "It Runs" to "It Runs Reliably"

The fixes in this stage: the DP send queue (from "staggering by voodoo timing" to a queue with backpressure), the queue deadlock fix (isolating ack and queue zcl_ids + watchdog), report deadband and alarm unit corrections (from "reporting everything frantically" to "report only on change"), and the full-snapshot-on-first-report mechanism.

The theme is **reliability**: sends need a queue, failures need retries, callbacks need a watchdog, reports need a deadband, and the first report needs a full snapshot. Every lesson is a complete loop of "naive implementation → field failure → mechanism fix."

### 3.2 From "Single Points" to "A System"

The fixes in this stage: stopping sampling during join (the network state machine starts scheduling the business logic), metering chip fault self-healing (from "dead until a human intervenes" to "three-level automatic recovery"), continuing to sample while offline (offline ≠ out of work), and LED feedback + NTC detection (every state has a visual language).

The theme is **systems thinking**: modules no longer operate as independent fiefdoms, the network state determines whether business logic runs, faults have tiered recovery strategies, and users can read what the device is thinking from the LEDs.

### 3.3 From "Features" to "A Product"

The fixes in this stage: meter self-test (testable on the production line), calibration with immediate visible effect (a UX closed loop), LCD offline repair (dual state copies), first-join report hardening (6s delay + backup report), the OTA triple fix (heartbeat/timer/device type), and the triple-press all-segments display (a production-line inspection tool).

The theme is **productization**: producible, calibratable, upgradable, inspectable.

### 3.4 Distilled Methodology

A few principles that kept recurring throughout the development process and are worth borrowing for any embedded project:

1. **Every async callback has a timeout fallback** (the watchdog philosophy) — the metering state machine, the DP queue, and OTA all follow this;
2. **Checksums guard against corruption, not misalignment** — the protocol layer defends against timing issues with a ring clear and an all_ok-commit-only policy;
3. **Values pass a "physical plausibility" check before entering the system** — deadbands, clamping, NTC open-circuit sentinel values;
4. **The software mirror and hardware state must stay in sync** — the LCD dual-state trap;
5. **Events must not be lost, and high priority must preempt** — the LED's target/current dual mode;
6. **Safety-affecting input changes are re-judged immediately** — threshold edits don't wait for the cycle;
7. **Eliminate locks with architecture** — single-threaded event-driven design + ISR-private buffers.

## 4. If I Did It Again: The Improvement List

An honest retrospective — these are the known boundaries of the current code, and also directions readers can pick up and work on themselves:

### 4.1 Architecture

- **The synchronous metering chip read code is now a dead end.** The synchronous register-read primitives are still there, but all business logic goes through the async state machine. Following the principle of "remove the old implementation after fixing," the synchronous path (about 400 lines) should be deleted — leaving it in will only invite misuse by whoever comes next;
- **The two metering chip driver files have exceeded the maintainability threshold** (one at 2500+ lines, the other at 1700+). The register tables and conversion formulas of the two chips overlap heavily, so a common layer could be extracted — but beware the over-design of "an abstraction layer serving only two instances"; whether to split or not right now is a matter of taste;
- **Alarm hysteresis** (mentioned but not implemented in Part 11): dual thresholds at ±5% would eliminate boundary jitter.

### 4.2 Features

- **Chip coefficient-level calibration** (writing coefficient registers): the current additive calibration doesn't cover scale errors, which high-precision mass production scenarios need;
- **Delta OTA**: not currently supported on the TLSR8258 platform, so full-firmware upgrades over weak-signal networks take a long time;
- **Real-time energy change reporting**: energy is currently only reported on the 10s cycle; changing to "report immediately on every 0.01kWh change" would make the app's energy curve smoother — at the cost of higher frame rates, which needs to be paired with deadband strategy.

### 4.3 Engineering

- **No unit tests.** All verification relies on whole-device logs — single-threaded event-driven code is actually well suited to "event replay" testing (recording and replaying the timer callback sequence), but this project never did it;
- **Debug log levels are not tiered.** Debug printing is all-or-nothing; production firmware should be able to compile debug logs out (a global switch macro exists, but there are no per-module switches).

## 5. For Those Who Want to Build One: A Reproduction Roadmap

If you want to reproduce or adapt this project, this order of time investment saves the most:

```
第 1-2 周：环境 + 生命周期 + 配网（第 01-04 篇）
          → 目标：App 上看到设备在线
第 3-4 周：DP 协议 + 数据模型（第 05、08 篇）
          → 目标：App 能控制一个虚拟 DP（比如先用随机数代替真实计量）
第 5-6 周：SPI 计量芯片一路通道（第 06 篇）
          → 目标：单相真实数据上云
第 7-8 周：UART 计量芯片 + LCD（第 07、10 篇）
          → 目标：三相数据 + 本地显示
第 9-10 周：报警/校准/OTA（第 11、12 篇）
          → 目标：功能完整
持续：第 09 篇的队列和第 13 篇的联调清单贯穿始终
```

**Key advice: get the whole pipeline working with random/fixed values first, then bring in real hardware.** The test-value force-full-report tool mentioned in Part 05 (entering recognizable test values like 222.2V/1111mA) is kept precisely for this purpose — when the data pipeline misbehaves, it cleanly separates a "communication fault" from a "metering fault."

## 6. Epilogue

This project began with a three-line modification to a light-bulb demo and ended with a three-phase meter that can self-test, calibrate, trip, and OTA. Looking back, you might agree: **the difficulty of embedded development lies not in any single knowledge point, but in making all constraints hold simultaneously** — Flash lifespan must be balanced against energy accuracy, async callbacks against state consistency, 15 slots against 38 DPs, cost against reliability.

Every "postmortem from the trenches" in this series is, at its core, the record of one constraint conflict being resolved. I hope this series helps you dodge a few of the pits we fell into — and dig a few new pits of your own, because that's where the real fun of this trade lies.

End of series. The firmware never rests, and neither does the tinkering.

---

*Previous: [12 Evolution] · Series Index · [Back to the beginning: 00 What Kind of Meter Are We Building]*
