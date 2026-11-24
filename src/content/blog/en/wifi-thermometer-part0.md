---
title: "Part 0: Before We Start — Shopping List and Toolchain Setup"
description: "Who this series is for: you know C but have never touched a microcontroller. This is the only part with no code: gather ~¥150 of gear, install Keil, and make the debugger recognize your chip."
pubDate: 2026-11-24
lang: en
translationKey: wifi-thermometer-part0
tags: [Embedded, STM32, Tutorial]
category: embedded
series: wifi-thermometer
seriesOrder: 0
---

> Who this series is for: you know C, but have never touched a microcontroller. By the end of the series, you will have built — with your own hands — a product that reports to the cloud over Wi-Fi, supports OTA updates, and runs on battery power in low-power standby.
> This is the only part of the series with "no code to write": gather the gear, install the toolchain, and make your computer recognize your chip.

---

## What We're Building in This Series

Let's paint a picture of the finished product first, so you don't get lost halfway:

A battery-powered thermo-hygrometer. Temperature and humidity on the screen; a Wi-Fi module on the back reports data to the cloud every so often, so you can see it in a mobile app and change alarm thresholds; when the temperature exceeds the limit it beeps away; when the battery runs low there's an on-screen indicator; if a firmware bug shows up, no disassembly needed — the cloud pushes an OTA update; and when it's idle it draws almost no power, so one battery lasts a very, very long time.

The main chip we'll build it around: Huada CIU32F003, **24 KB Flash, 3 KB SRAM**.

Yes, 3 KB — a single photo on your phone is dozens of times bigger. You'll experience it firsthand later: programming under constraints like this, you check the "ledger" before adding every feature. That's also the biggest difference between this series and your average "blink an LED" tutorial — **we develop inside the constraints of a real product from start to finish**.

## Get Oriented: The Full 18-Part Roadmap

| Part | Title | What You'll Learn |
|---|------|---------|
| 00 | **Shopping List and Toolchain Setup (this part)** | Gather hardware, install Keil, make the debugger recognize your chip |
| 01 | Light Up Your First LED | Clock tree, GPIO, SysTick, and why the stack is only 1 KB |
| 02 | Make the MCU Talk | UART, RXNE interrupt, ring buffer |
| 03 | Hand-Roll I2C, Read Your First Temperature & Humidity | Bit-by-bit dissection of I2C timing, GPIO bit-banging a bus |
| 04 | ADC: Measure Battery and NTC Temperature | Voltage dividers, lookup tables with interpolation |
| 05 | Make It Sleep | LPTIM wakeup, Deepstop, and the clock-restore pitfalls after wakeup |
| 06 | Waking Up to a Dog Bite in Your Dreams | Watchdog IWDG, robustness in low-power programs |
| 07 | Main-Loop State Machine — The Big Picture | Three-state architecture, event-driven thinking |
| 08 | Introduction to the Tuya Protocol | Byte-by-byte dissection of the `55 AA` frame format, heartbeat and handshake |
| 09 | Porting the Tuya SDK | The four integration points, how to budget 3 KB of RAM |
| 10 | Detective Work: 7 Bytes Trigger a "Factory Reset" | Embedded debugging mindset (the hardest-core part of this series) |
| 11 | DP Data Flow and Cache State Machine | Report/download, the timing dispute, packing 14 DPs into one frame |
| 12 | Flash Persistence | Storing settings, the math of erase/write endurance |
| 13 | Segment LCD | VKL076 driver port, display RAM, power saving |
| 14 | Buttons and Gestures | Debouncing, click/long-press/quintuple-click, EXTI wakeup |
| 15 | Buzzer | Passive-buzzer PWM, alarm beeps |
| 16 | OTA Bootloader | Flash partitioning, app handoff, a showcase of silent failures |
| 17 | Production Test and Mass Production | Production-test scanning, a 14-item smoke checklist, release process |
| 18 | Final Review | Resource ledger, map of pitfalls, what to learn next |

## Choose Your Route: Which Board?

This series is based on a real mass-production project; the actual product uses the Huada CIU32F003. But there's a practical problem: **this chip is too niche — no retail dev board exists for it**. So you get two routes:

**Route A (recommended): the learning breadboard setup.** Use an easily available STM32F103C8T6 minimal-system board + the same sensor, wired up on a breadboard. The concepts — GPIO, UART, ADC, timers, low power — map one-to-one, the code logic is identical, and I give side-by-side register details for both chips in each part. This route costs about a hundred-plus yuan; order today, start work next week.

**Route B: the original setup.** If you have a channel to get a CIU32F003 board (say, a company sample + J-Link/ULINK), even better — you get a dev experience identical to the actual product, and there are special notes for Route B at the end of this part.

> Don't worry, I'll cover both routes. The code in the main series follows Route A (STM32F103); each part's "The Original Product (CIU32F003)" section tells you the equivalent on CIU32F003.

## Shopping List (Route A: Learning Setup)

### Must-Buy (core gear, ~¥100)

| Gear | What It's For | Price |
|------|---------|--------|
| STM32F103C8T6 minimal-system board | Main learning board, a.k.a. the "Blue Pill" | ¥12~18 |
| ST-Link V2 debugger (a domestic clone is fine) | Flashing programs and single-stepping — the "lifeline" of embedded development | ¥15~25 |
| USB-to-TTL serial module (CH340) | The channel between MCU and PC; debugging relies on it entirely | ¥5~8 |
| GXHT40 temperature/humidity sensor module | The star sensor of this series (I2C interface) | ¥10~20 |
| 400-hole breadboard + jumper wires | Solderless circuit building | ¥12 |
| NTC thermistor 10K (B=3950) | Probe for measuring external temperature | ¥1~2 |
| Passive buzzer, 3.3V | Alarm sound (make sure it's "passive", not "active") | ¥1 |
| Tactile push button | Input for gesture recognition | ¥1 |
| Multimeter | Checking wiring, measuring voltage — an embedded engineer's constant companion | ¥30~50 |

### Recommended (quality-of-life upgrade, ~¥30)

| Gear | What It's For |
|------|---------|
| 24 MHz 8-channel logic analyzer (domestic) | For viewing I2C waveforms in Part 3 and serial protocol in Part 8 — the difference between troubleshooting by eye and troubleshooting with cheats |
| 1602 LCD (I2C backpack version) | Learning-setup substitute in Part 13 (the product uses a segment LCD; an I2C 1602 is just as good for practicing GPIO bit-banged I2C) |
| Resistor kit (including 10K/100K, etc.) | Needed for the NTC and battery voltage dividers |

### No Rush to Buy

A Wi-Fi module is **not needed** in Route A — for the protocol experiments in Parts 8~11, we'll have a serial terminal tool on your PC "play" the Wi-Fi module, which is even easier to debug than a real one. Buy the module and its 3.3V power solution when you're sure you're going for a real device (Part 17 covers that).

**Total: must-buy ~¥90~130, plus recommended gear ~¥150.** This is one of the cheapest ways into embedded development.

### Extra Shopping List (Route B, Original Setup)

| Gear | Notes |
|------|------|
| CIU32F003 sample/dev board | The actual product board; pin assignment follows the product schematic |
| J-Link or ULINK2 | Both supported; more on how to choose later |
| Adjustable power supply | For production tests and current measurements (Part 17) |
| Production-test router | A router named `tuya_mdev_test` (only needed in Part 17) |

## Software Environment: Three Steps to Ready

### Step 1: Install Keil MDK

This series uses **Keil µVision MDK-ARM 5.42** with the **ARMClang V6.23** compiler. This is the mainstream combo for embedded teaching and enterprise development in China right now.

1. Download the MDK5 installer from the official site (mdk542.exe or newer). **No Chinese characters or spaces in the install path** (hard-won lesson: the linker occasionally throws a fit);
2. Midway through the install, a Pack Installer window pops up — **just close it** (installing packs separately later is faster);
3. When it's done, a µVision5 icon appears on your desktop.

> **On licensing**: Keil imposes a code-size limit (32 KB) for Cortex-M3 chips like the STM32F103, and our learning-setup code stays comfortably within the free range; the CIU32F003 is M0+ and even less of an issue. Please handle genuine licensing yourself, as appropriate.

**Installing the chip support pack (Pack)**:

- Route A: In Keil, go Project → Manage → Pack Installer, search `Keil.STM32F1xx_DFP`, install;
- Route B: Huada provides a DFP support pack for CIU32F003 (ships with the official standard-library package); the import steps are the same.

### Step 2: Serial Driver and Tools

- CH340 driver (the seller of your serial module will give you a download link);
- A serial terminal tool you're comfortable with: **SSCOM** or **MobaXterm** both work — it just needs hex display (mandatory in Part 8).

### Step 3 (Optional but Strongly Recommended): Logic Analyzer Software

For the domestic 24 MHz logic analyzer, use **PulseView** (open source, free) or the software provided by the seller. Install it and let it sit for now; in Part 3 we'll make it shine.

## First Hands-On Experiment: Make Your Computer Recognize Your Chip

No code yet — first, a "health check" of the environment. Goal: **Keil can read the STM32F103's chip ID through the ST-Link**. Once this works, the remaining 17 parts have no environment-level obstacles left.

**Wiring** (ST-Link → minimal-system board, 4 wires total):

```
ST-Link        Blue Pill
  SWDIO  ────►  SWDIO (PA13)
  SWCLK  ────►  SWCLK (PA14)
  GND    ────►  GND
  3.3V   ────►  3.3V   (power only, no data)
```

**Steps**:

1. Create a new project in Keil, select chip `STMicroelectronics → STM32F103 → STM32F103C8`;
2. When the "Manage Run-Time Environment" window pops up, **uncheck everything and just hit OK** (bare-metal hand-written code, no HAL library — all code in this series directly manipulates registers, the "bare-metal" style, and it's the only shortcut to truly understanding a microcontroller);
3. Magic wand → Debug tab → select `ST-Link Debugger` → Settings → if SW Device shows `ARM CoreSight SW-DP` and an IDCODE (something like `0x1BA01477`), **congratulations, you pass the health check**;
4. While you're at it, confirm on the Flash Download tab that the chip's Flash algorithm is configured (select the STM32F10x family algorithm).

**Acceptance criteria**: you can see the IDCODE. If this step gets stuck, 90% of the time it's wiring (SWDIO/SWCLK swapped, GND not commoned), 9% is the driver, 1% is a dead board.

## Bonus: Two True Stories About Gear

### Story 1: The Debugger War — ULINK or J-Link?

In real project development, the project directory holds both J-Link config files and J-Link logs, while the project's Debug settings default to ULINK2. This isn't mess — it's scar tissue: **on this very project, both debuggers had their turn at tripping us up**.

ULINK2 is Keil's own child — the smoothest pairing with Keil, but slow to download; J-Link is fast and powerful, but occasionally argues with domestic chips' Flash download algorithms (we had to put together a dedicated algorithm file for the CIU32F003 back then). Two lessons for you: **first**, the debugger is the lifeline of embedded development — don't move on until you've completely paved the "recognize chip → download → single-step" path; **second**, when you hit "recognizes but download fails," suspect the Flash algorithm configuration first — don't suspect your life.

### Story 2: One Watch Window Wasted a Whole Afternoon

Mid-way through development there was a paranormal phenomenon: the ADC sampling the battery voltage worked perfectly in single-step, and went insane at full speed. Two hours of investigation later, the culprit was **Keil's Live Watch window** — the debugger periodically read the ADC data register and, in passing, cleared the "conversion complete (EOC)" flag, so the program's poll on that flag waited for nothing.

The gear-level lesson of this story: **a debugger's "automatic watch" feature does interfere with peripherals**. If you ever see "normal in single-step, abnormal at full speed," close all Watch/Live Watch windows and re-test. This lesson is the kind you'd pay for.

## Summary and Next Part

Shopping list, software environment, connection health check — preparation done. Run through the checklist:

- [ ] STM32F103 minimal-system board + ST-Link received and connected
- [ ] Keil 5.42 installed, can read the chip IDCODE
- [ ] Serial terminal tool installed
- [ ] (Recommended) Logic analyzer and PulseView installed

In Part 1, "Light Up Your First LED", we finally start writing code: starting from the 48 MHz clock tree, we'll configure a GPIO output by hand and make the on-board LED blink — and along the way figure out why this product's stack is only 1 KB and its heap is 0 bytes. Five minutes of blinking, with a whole lecture on resource management behind it.

---

*This series is adapted from a real mass-production project; every pitfall recorded here comes from actual development. Reading in order is recommended, as the parts depend on each other.*
