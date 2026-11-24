---
title: "Part 9: Porting the Tuya SDK — Four Integration Points and a 3 KB Memory Budget"
description: "Port the Tuya low-power MCU SDK to a microcontroller with only 3 KB of RAM: wire up four integration points, use a budget table to decide which features live and which die, and dissect a macro-ordering bug that silently dropped two-DP commands."
pubDate: 2026-11-24
lang: en
translationKey: wifi-thermometer-part9
tags: [Embedded, STM32, Tutorial]
series: wifi-thermometer
seriesOrder: 9
category: embedded
---

> In Part 8 we hand-wrote the protocol parser — great teaching value, but no product actually ships that way. Tuya's official MCU SDK already wraps up framing, parsing, and DP management.
> This part is about porting. Porting an SDK sounds like manual labor, but the real work boils down to a single word: **math**. Porting an SDK onto a chip with 3 KB of RAM, the first step is not compiling — it's pulling out the budget table and deciding which features live and which die.

---

## 1. Goals and What You'll See

**Goal**: Port the Tuya low-power MCU SDK to the microcontroller — wire up the four integration points, fill in the product info, and trim features to fit the budget. Once the port is done, the "reply to heartbeat / answer work-mode query" code we hand-wrote in Part 8 is handled automatically by the SDK. The serial assistant plays the Wi-Fi module again, and the whole exchange runs with zero hand-written protocol code.

**What you'll understand**: what each of the SDK's three source files is responsible for, that porting is essentially filling in four "slots," and how to make trimming decisions when porting onto a resource-tiny chip.

## 2. Theory in 10 Minutes

### 2.1 The SDK's Three Files, Three Roles

The Tuya low-power MCU SDK core is just three .c files with clearly separated responsibilities:

| File | Role | What it does |
|------|------|--------------|
| `system.c` | **Protocol engine** | The frame-parsing state machine (the industrial-strength version of the one we hand-wrote in Part 8), command dispatch, data buffering |
| `protocol.c` | **Product dictionary** | Your product's DP definition table (DPID, type, length) and the up/downlink data handlers |
| `mcu_api.c` | **User API** | Interfaces for the application layer: `mcu_dp_value_update()` (reporting), DP download callbacks, etc. |

What porting means: getting this trio spinning on your hardware — **the SDK is a finished machine; we plug in the power, feed it raw material, and hand it the product blueprint**.

### 2.2 The Four Integration Points: Four Slots Between the SDK and the World

The SDK interacts with the outside world through four well-defined "slots" — all of them capabilities we hand-built in earlier parts:

**① Send a byte** — `uart_transmit_output(unsigned char value)`:

```c
void uart_transmit_output(unsigned char value)
{
    uart_putc(value);          // 第 2 篇的阻塞发送
}
```

**② Receive a byte** — `uart_receive_input(unsigned char value)`: you don't implement this one; it's provided by the SDK, and you call it inside the **UART interrupt**:

```c
void USART1_IRQHandler(void)
{
    if (USART1->SR & USART_SR_RXNE) {
        uart_receive_input((uint8_t)USART1->DR);   // 每字节直接喂给 SDK
    }
}
```

Notice anything? The ring buffer and parsing state machine we wrote ourselves in Part 8 — in the SDK version, **the receive side no longer needs our buffer**. The SDK has its own internal protocol buffer; a byte goes in and drops straight into the parsing pipeline. Our ring buffer retires with honors.

**③ Main-loop driver** — `wifi_uart_service()`: call it from the 10 ms tick (the `uart_service_tick()` in the PROCESS state from Part 7 is exactly where it lives). The SDK's parsing, timeout checks, and caching state machine all advance on this beat.

**④ Business callback** — `dp_download_handle()`: when the module sends down a DP (say the user changes the temperature upper limit in the app), the SDK calls this function, and you translate the command into a modification of your application variables:

```c
void dp_download_handle(unsigned char dpid, const unsigned char value[], unsigned short len)
{
    switch (dpid) {
    case 1:   /* 温度上限 */
        /* 从 value[] 解出数值，写进自己的变量，最好存 Flash（第 12 篇）*/
        break;
    default:
        break;
    }
}
```

With the four slots wired up, the machine spins. Everything left is configuration.

### 2.3 Product Info: Registering the Household

At the top of `protocol.c` there's a set of macros — the device's "household registration" on the Tuya platform:

```c
#define PRODUCT_KEY     "你的ProductKey"   // 涂鸦开发者平台上创建产品后获得
#define MCU_VER         "1.0.0"            // MCU 固件版本，OTA 用（第 16 篇）
```

There are also capability declarations specific to low-power products: Wi-Fi power control supported (the MCU decides when the module loses power), offline DP caching supported... These flags tell the module "the device on the other end is an MCU that knows the low-power rules," and the module cooperates at the low-power tempo.

## 3. Hands-On: Do the Math First, Compile Second

### Step 1: Get the SDK and Open the Ledger

Register on the Tuya developer platform (iot.tuya.com), create a product (category: "temperature and humidity sensor"), and the platform generates an SDK package containing `mcu_sdk` for you to download. Drop the three .c files into the project.

**Before compiling, open Keil's .map file and record the pre-porting ledger** (check "generate map" in the project's "Listing" options tab):

```
Image component sizes
  Code (inc. data)   RO Data    RW Data    ZI Data      Total
  当前工程：xxx        xxx        xxx        xxx
```

Record two numbers: **RW Data + ZI Data** (runtime memory footprint). That's your "account balance."

### Step 2: The Trimming Decision Table

The SDK's features are toggled by macros in the config file. Every macro you turn on means an expense of RAM or Flash. Decide against the product's real situation (3 KB SRAM, 1 KB already eaten by the stack):

| Macro | Feature | Keep or cut | Reason |
|-------|---------|-------------|--------|
| `WIFI_CONTROL_SELF_MODE` | MCU controls Wi-Fi power itself | **Must keep** | The lifeline of a low-power product — the premise of the event-driven architecture (Part 7) |
| `DO_CACHE_SUPPORT` | Offline DP caching | **Must keep** | Panel settings live in the cloud; the device must pull the cache to sync when it wakes (Part 11) |
| `SUPPORT_MCU_FIRM_UPDATE` | MCU OTA upgrade | **Keep** | Firmware must be sustainably maintainable (Part 16) |
| `WIFI_MODULE_UPDATE` | Wi-Fi module self-upgrade | Cut | Irrelevant to this product; module upgrades aren't the MCU's job |
| `SUPPORT_MCU_RTC_CHECK` | RTC clock check | Cut | The product has no clock display need; save the RAM |
| `WIFI_TEST_ENABLE` | SDK's built-in production test | Cut | Its command codes collide with something else; we rebuilt the production test ourselves later (Part 17 for the full story) |
| `WIFI_QUERY_ROUTE_RSSI` | Query router signal strength | Cut | A production-test need; revisit if ever required |

**The decision principle is a single line: every feature must be able to answer "what do I lose if I cut it, and what do I get in return for keeping it."** Can't answer? Cut it.

### Step 3: Compile and Check the Ledger

Compile after trimming, open the .map again, and compare: **how much did RW+ZI grow? Which buffers are the big-ticket items?** The SDK's UART RX/TX buffers, DP cache, and protocol parsing buffers will be sitting right there in plain sight.

The real ledger for this product: after trimming, SDK-related buffers totaled roughly 300+ bytes, and whole-system RW+ZI landed around 1.9 KB — within the 3 KB cap, but the margin was already down to "a few hundred bytes." **From here on, every new feature must pass a budget review first.** This habit runs through the entire series.

## 4. Flash and Acceptance Test: The Duo Act, Season Two

- [ ] After the port compiles with zero errors, have the serial assistant play the module and send a heartbeat `55 AA 00 00 00 00 00` — **this time you wrote no reply code at all**, yet the assistant receives the SDK's automatic reply `55 AA 03 00 00 00 03`;
- [ ] The assistant sends a work-mode query `55 AA 00 02 00 00 01`, and the SDK replies automatically (with the configured work mode);
- [ ] The application calls `mcu_dp_value_update(1, 250);` (report temperature 25.0 °C), and a logic analyzer or the assistant captures a frame `55 AA 03 07 ...` (0x07 = DP report command) — **you called a one-line API, and the SDK did for you the full job of the `tuya_send_frame` from Part 8**;
- [ ] The assistant forges a DP download frame (changing the app's temperature upper limit); a breakpoint stops inside `dp_download_handle()`, confirming the frame arrives with the correct dpid;
- [ ] In the updated .map, you can point at each buffer entry and say roughly who it is and why it's that big.

## 5. The Original Product (CIU32F003)

The full production form of the SDK integration has two productization details beyond the four integration points:

1. **Integration point ② goes deeper.** The product's UART RX interrupt does feed bytes straight into `uart_receive_input()`, but the firmware added a length defense line before feeding — oversized malformed frames are rejected outright without disturbing the SDK. The SDK trusts its input by default; real-bus input doesn't deserve that trust.
2. **Full-state reporting goes out as a single frame.** The SDK's per-DP reporting interfaces `mcu_dp_*_update()` send one DP per frame; for large batch reports the product didn't use them — instead it hand-assembled one big 0x07 frame carrying all 14 DPs. Why and how is the dedicated topic of Part 11 (behind it lies the real-world lesson "back-to-back frames get lost").
3. **Version number discipline.** `MCU_VER` must stay consistent with the version macro in the Bootloader (Part 16 will hammer this again at release time; we're just noting it in the ledger for now).

## 6. Bonus: A Three-Letter Macro Hiding a Silent Killer

After the SDK port was complete, everything worked: single-DP download, reporting, heartbeat, handshake... until a tester ran one particular test: **changing two settings simultaneously in the app** (say, temperature upper limit and humidity upper limit in one go). The result — the settings didn't take effect. No error, no abnormal frame, serial line dead quiet. Just "nothing happened." Change one setting: works. Two at once: silent failure.

Frame capture revealed the truth: the two DPs were merged into a single downlink frame, its length exceeded some threshold, and the SDK **silently discarded** the frame. Digging into the SDK source, we found the length guard doing the rejecting; following the trail up to the buffer definitions, the real culprit appeared — in the SDK porting config, one macro was **defined in the wrong place**:

```c
#if   (SUPPORT_MCU_FIRM_UPDATE == 1)
  #define 各种缓冲区 大
#elif (SUPPORT_MCU_FIRM_UPDATE == 2)
  #define 各种缓冲区 中
#else
  #define 各种缓冲区 小        ← 实际走了这里！
#endif

/* ……几十行之后…… */

#ifndef SUPPORT_MCU_FIRM_UPDATE
#define SUPPORT_MCU_FIRM_UPDATE    1
#endif
```

See it? **The check comes first, the definition second.** The C preprocessor scans top to bottom; when it reaches the `#if`, the macro doesn't exist yet, none of the conditions hold, and every buffer gets allocated as "small" — the effective receive buffer was only a couple dozen bytes, smaller than one two-DP downlink frame. The length guard dutifully rejected the oversized frame, and the truth behind the guard was that the buffer had been secretly shrunk on someone.

The fix takes nothing more than moving the macro definition **before** the check — but figuring out "why do multi-DP downloads silently fail" burned through an entire investigation chain: frame capture → no reply found → read SDK source → length guard → buffer definitions → macro ordering. Let go of any single link in that chain and this bug would have shipped in mass-production firmware, becoming the "sometimes settings don't stick" complaint on the customer hotline.

Two lessons, please carve them in:

1. **Macro dependency ordering is a real trap.** A macro used in an `#if` must be defined earlier — the compiler will not check for you whether "this macro was defined after it was used";
2. **"Silent failure" is the most expensive bug type in embedded.** Errors, exceptions, resets — all easy to chase. Quietly not working costs ten times the debugging effort. When writing code, actively ask yourself: "if this path fails, who sees it?"

## 7. Next Up

The SDK is spinning, and the feature trimming is settled. But a finished port doesn't mean peace — Part 10 is the series' "famous episode": *The Case of the Factory Reset Caused by 7 Bytes*. Returning to that empty frame with the mismatched checksum we buried back in Part 8, we'll reconstruct a real "case" in full: thresholds users set in the app kept mysteriously reverting; the team checked storage, checked the cloud, nearly lost faith in life — and the culprit was hiding in a single line of the SDK's empty-data-frame parsing. Next part: your turn to play embedded detective.

---

*This series is adapted from a real mass-production project; every pitfall recorded here comes from real development. Reading in order is recommended — the parts build on each other.*
