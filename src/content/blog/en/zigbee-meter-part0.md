---
title: "00 · Introduction: What Kind of Meter Are We Building?"
description: "Part 0 of the Zigbee three-phase smart meter series: the rationale behind every major choice (Zigbee, TLSR8258, dual metering chips, Tuya private cluster 0xEF00), the system architecture, all 38 DPs, and the full series roadmap."
pubDate: 2026-11-24
lang: en
translationKey: zigbee-meter-part0
tags: [Embedded, Zigbee, Tutorial]
series: zigbee-meter
seriesOrder: 0
category: embedded
---

> Hardware: TLSR8258 (Telink) + ZT3L module / HLW8112 + HLW8110 metering chips / VK1621 segment LCD
> Software: TuyaOS 3.11.1 Zigbee sub-device development kit
> Code size: roughly 10k lines of C, 38 DP data points

---

## 1. Why Build a Meter at All?

Before starting this project, I asked myself one question: **smart plugs cost just a few dozen yuan on the market and they're everywhere — so why hand-build a three-phase smart meter?**

There are three answers:

1. **A smart plug is a "single-phase toy"; three-phase is "industrial reality."** A home is fed by single-phase 220V, but the main meters of shops, factories, and rental buildings are almost all three-phase four-wire. Three phases means three voltages, three currents, three powers, and energy in both directions — the data volume jumps by an order of magnitude.
2. **I wanted to truly understand "metering."** You can sample voltage and current with an ADC, but "energy" is power integrated over time — how does a chip do that? How is calibration done? How do you keep the energy count from getting lost on a power failure? Reading ten WeChat articles won't teach you as much as writing the code once.
3. **Zigbee is a nice technical backwater.** Wi-Fi device tutorials are a dime a dozen, but Zigbee — the protocol stack hiding behind smart-home gateways (endpoints, clusters, ZCL, pairing, OTA) — has surprisingly few hands-on tutorials in Chinese.

And so the project was born: a **Zigbee 3.0 Router smart meter** hanging on a three-phase circuit, reporting each phase's voltage/current/power/power factor/forward-and-reverse energy to the Tuya cloud in real time, with a local segment LCD cycling through readings, automatic relay trip on power overload, and remote OTA upgrades.

Final form:

- Module: Tuya ZT3L (Telink TLSR8258 chip, Zigbee 3.0 Router)
- Metering: HLW8112 (SPI interface, handles channels A and B) + HLW8110 (UART interface, handles channel C)
- Display: VK1621-driven segment LCD, 3 digits × 2 rows + icons
- Interaction: 1 button (short press = page / double press = self-test / triple press = all segments / hold 5s = pairing) + 1 LED
- Actuation: 1 relay (PC0), auto-opens on power overload
- Temperature: NTC thermistor (ADC)

## 2. The Journey Behind the Technical Choices

### 2.1 Why Zigbee and not Wi-Fi?

| Dimension | Zigbee | Wi-Fi |
|-----------|--------|-------|
| Networking | Mesh — devices can route for each other | Star — everything depends on the router |
| Standby power | mA-level (Router) / μA-level (sleepy end device) | tens of mA |
| Spectrum congestion | 2.4G, 16 independent channels, clean in home scenarios | fighting your router for airtime |
| Ecosystem | one-tap pairing via Tuya gateway | pairing success rate gets complained about constantly |

A meter is a **mains-powered** device, so power consumption isn't the top concern. But meters usually live deep inside a distribution box — a Wi-Fi signal through two walls is dicey at best, while Zigbee's mesh topology is made for exactly this scenario (Router devices can even relay for others).

The price: Zigbee's development barrier is noticeably higher. You have to understand the **endpoint / cluster / attribute / ZCL command** model, and you need a Zigbee-capable gateway. That's exactly what the first two parts of this series will spell out.

### 2.2 Why the TLSR8258 / ZT3L?

Telink's TLSR8258 is a fascinating chip: a dual-mode SoC with BLE 5.0 and IEEE 802.15.4 (Zigbee's PHY). Cortex-M0? No — it's a Telink in-house 32-bit RISC core (TC32 instruction set), 512K Flash + 64K SRAM, more than enough to run a Zigbee stack, and a notch cheaper than an EFR32. Tuya packaged the 8258 into the ZT3L module and hooked it into the TuyaOS ecosystem, so documentation and gateway compatibility are well covered.

The toolchain is a **TC32 GCC cross-compiler** (`tc32-elf-gcc`) bundled inside the development kit — you don't need to install anything yourself. More on that in Part 01.

### 2.3 Why the weird "two metering chips" approach?

This is the most interesting hardware decision of the project. Three-phase means measuring 3 current channels + (at least) 1 voltage channel. The common options:

- **Three single-phase metering chips**: cost ×3, and a big chunk of board area;
- **One dedicated three-phase metering chip** (like the multi-channel versions of ATT7022/HLW8032): great in theory, but at selection time they were either out of stock or in painful-to-solder packages;
- **HLW8112 + HLW8110 mix-and-match** (this project): the HLW8112 is a dual-channel metering chip with an **SPI interface** — one init and it meters channels A and B in parallel; the HLW8110 is its single-channel sibling with a **UART interface**, covering channel C.

This approach crams two completely different driver models — "synchronous SPI reads" and "asynchronous UART reads" — into a single project. The former is simple and direct; the latter gave birth to the hardest bug of the whole project (the star of Part 07). And to make it spicier, the HLW8112's two physical channels are **cross-wired to the A/B phases** in hardware (channel A is actually connected to phase B's terminal), so the firmware has to do a cross-mapping — Part 06 is devoted to this "foreshadowing."

### 2.4 Why Tuya private cluster 0xEF00 instead of standard ZCL?

The Zigbee Alliance defines a standard metering cluster (0x0702 Simple Metering), which is theoretically the proper way. But the reality of the Tuya ecosystem is this: App panels, cloud rules, and the gateway's DP thing model are all built around the **Tuya private cluster 0xEF00** DP protocol. Use the standard cluster and you have to write your own gateway plugin; use 0xEF00, define the DP points on the Tuya IoT platform, and the App panel works the moment the device joins the network.

So the pragmatic choice is: report the device type as `ZG_DEVICE_ID_SMART_PLUG`, the model ID as `TS0601` (the "passthrough device" model ID by convention in the Tuya ecosystem), and route all data through 0xEF00. **This is essentially a custom application-layer protocol running on top of Zigbee** — Part 05 dissects its frame format byte by byte.

## 3. System Architecture Overview

First, the software layering (this is the map for the whole series):

```
┌──────────────────────────────────────────────────────────┐
│ Application Layer                                          │
│  Lifecycle callbacks  4-stage init + network FSM + OTA     │
│  Endpoint/cluster reg Zigbee descriptor & registration     │
│  DP protocol layer    DP parse/encap + app TX queue        │
│  Data model           central data + deadband + KV persist │
│  Metering aggregation 3-chip agg + NV + hourly energy      │
│                      + LCD rotation                        │
│  Double-tap self-test per-phase meter self-check           │
├──────────────────────────────────────────────────────────┤
│ Driver Layer                                               │
│  HLW8112 SPI driver   A/B metering, sync reads             │
│  HLW8110 UART driver  C-channel metering, async state mach │
│  VK1621 LCD driver    segment map + GPIO bit-bang timing   │
│  NTC temp sensing     ADC sampling + 341-point lookup      │
│  Button driver        GPIO IRQ + 20ms scan state machine   │
│  LED driver           mode machine (off/on/fast/slow blink)│
│  UART wrapper         9600 8E1, metering chip only         │
│  GPIO wrapper         relay drive + 3 pairing-detect boots │
├──────────────────────────────────────────────────────────┤
│ TuyaOS SDK (TAL abstraction + TKL kernel + precompiled .a) │
└──────────────────────────────────────────────────────────┘
```

Hardware resource allocation (a table worth memorizing before touching the code):

| Function | Pin | Notes |
|----------|-----|-------|
| Button | PB4 | Pull-up input + falling-edge IRQ, active low |
| LED | PB5 | Push-pull output |
| Relay | PC0 | High level = engaged |
| SPI→HLW8112 | SDI=PD7, SCLK=PD3, SDO=PD4, CS=PC1 | Bit-banged SPI |
| UART0→HLW8110 | TX/RX | 9600 8E1, **exclusive** |
| LCD→VK1621 | CS=PC2, WR=PC3, DATA=PD2 | Bit-banged timing |
| NTC | PB6 (ADC ch6) | 3.3V reference, averaged 4× |
| Debug log | PC4 | Bit-banged UART, 115200 (`Tl_printf`) |

> Note one critical fact: **UART0 is handed over entirely to the HLW8110 shortly after boot**; logs go out via the bit-banged UART on PC4. This is the evolved design — the earliest version shared UART0 between logging and metering, which triggered the famous "UART0 war" (told in Part 07).

## 4. The 38 DP Points: The Device's "Language"

In the Tuya thing model, each data point is called a DP (Data Point). All DP IDs in this project are defined as a set of macros in the code — 38 in total, in five categories:

- **Cumulative energy (14)**: total forward/reverse + 3 channels by terminal forward/reverse + 3 phases forward/reverse (DP 1/2, 56–61, 125–130)
- **Real-time data (11)**: voltage, 3 channel currents, 3 channel powers, 3 power factors, total power, temperature (DP 9, 101–110, 131)
- **Configuration (11, writable)**: relay switch, 3 power thresholds, 7 calibration values (DP 16, 111–113, 132–138)
- **Alarms (3)**: 3 power-overload alarms (DP 114–116)
- **Hourly energy (8)**: A/B/C/total × forward/reverse (DP 117–124)

The DPs defined in the cloud thing model correspond one-to-one with the macros in the code. Create the cloud product and define the DPs before writing firmware — that flow is covered in Part 05.

## 5. The Series Roadmap

One verifiable milestone per part — follow along and you can reproduce the whole device from scratch:

| Part | Content | Milestone |
|------|---------|-----------|
| 01 | Dev environment setup and first flash | logs visible on the serial port |
| 02 | TuyaOS four-stage lifecycle, endpoint/cluster registration | the gateway can discover the device |
| 03 | Button state machine + LED mode machine | the button can "understand" single/double/long press |
| 04 | Pairing flow + network state machine | the device shows online in the App |
| 05 | Private cluster 0xEF00 and the DP protocol | the App receives its first DP |
| 06 | HLW8112: dual-channel SPI metering | real data from phases A and B |
| 07 | HLW8110: UART async state machine + the UART0 war | all three phases complete; the deepest pit of the series |
| 08 | Data model and KV persistence | energy survives a power cycle |
| 09 | DP send queue and the battle against deadlock | 38 DPs batched without a lost frame |
| 10 | VK1621 segment LCD + NTC temperature | you can see data locally |
| 11 | Calibration, power alarms, and relay protection | auto-trip on overload |
| 12 | The full OTA upgrade flow | firmware upgraded over the air |
| 13 | Finale: self-test, all-segment test, and the road to production | a deliverable meter |

## 6. Prerequisites for Beginners

This series assumes you know C and know what GPIO / interrupts / timers are, but it does **not** assume any Zigbee or TuyaOS experience. Each part's "background knowledge" section only covers just enough — for example, Part 02 explains endpoints and clusters with a "rooms and mailboxes" analogy, and Part 05 walks you through dissecting a real captured DP frame byte by byte.

All code and configuration in this series comes from the real project, and every pitfall comes from genuine fix records during development — not made-up textbook failures.

Next up: sharpen the knife first — set up the environment, get the first compile through, flash the bin into the chip, and make the serial port spit out its first line of log.

---

*Series index: [Part 00 Introduction]* · *Next: [Part 01 Sharpening the Knife: Setting Up the TuyaOS Dev Environment and First Flash]*
