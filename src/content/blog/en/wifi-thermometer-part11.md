---
title: "Part 11: DP Data Flow and the Cache State Machine — Pull the Cache or Report First?"
description: "Every time a low-power device wakes up, whose data is newer — the cloud's or the local copy? This part settles the pull-vs-report race with a DP cache state machine, and ships the series' biggest design: all 14 DPs merged into one report frame."
pubDate: 2026-11-24
lang: en
translationKey: wifi-thermometer-part11
tags: [Embedded, STM32, Tutorial]
series: wifi-thermometer
seriesOrder: 11
category: embedded
---

> The protocol runs, the SDK spins, and the big case is closed too. Now we hit a problem unique to low-power products: **every time the device wakes up, whose data is newer — the cloud's or the local copy?**
> The user just changed the temperature upper limit to 35°C in the app, while the device is sleeping soundly in Deepstop. After it wakes up and connects, should it ask the cloud "any new settings?" or push its local data up first? Get the order wrong, and stale values overwrite fresh ones — the user's change was for nothing.
> This part settles that race, and along the way implements the series' biggest design: **all 14 DPs merged into a single report frame**.

---

## 1. Goals and What You'll See

**Goal**: implement a simplified DP cache state machine that completes the full chain of "wake up → connect to cloud → pull cache → apply cache → single-frame full report", and use a serial-port assistant playing module + cloud to act out both endings:

1. The cloud has a cache (settings the user changed) — the device applies it before reporting, and the panel doesn't "snap back";
2. The cloud has no cache — a 2-second timeout catches it, and the device reports as usual.

**What you'll understand afterwards**: the essence of DPs, why offline cache exists, why the cache-vs-report ordering must be "pull first, report later", and the engineering rationale for the single-frame report.

## 2. The Theory in 10 Minutes

### 2.1 DP: The "Vocabulary" of Device-Cloud Conversations

DP (Data Point) is the core abstraction of the Tuya protocol: **every state on the device that can be reported or controlled is a numbered DP**. Here's an excerpt of this product's vocabulary:

| DPID | Name | Direction | Type |
|------|------|------|------|
| 1 | Temperature | Report | Value |
| 2 | Humidity | Report | Value |
| 3 | Battery level | Report | Value |
| 5 | External temperature | Report | Value |
| 101~104 | Temp/humidity upper & lower limits | **Bidirectional** | Value |
| 105 | High-temperature alarm | Report | Enum |
| 108 | Temperature unit switch (℃/℉) | **Bidirectional** | Bool |
| 111 | Alarm mute | **Bidirectional** | Bool |

Reporting goes through **0x07** frames (MCU → module → cloud), and downlink commands arrive in **0x06** frames (cloud → module → MCU, delivered into the `dp_download_handle` callback). Among the 14 DPs, the bidirectional ones are exactly the settings DPs — "user-changeable, device-must-store" — and they are the protagonists of this part.

### 2.2 Offline Cache: A Mechanism Born for Sleep

A low-power device spends 99.5% of its time in Deepstop, with Wi-Fi powered down and completely cut off from the cloud. Here's the problem: if the user changes the temperature upper limit in the app right now, they're changing **the cloud's data**. The device knows nothing about it — the copy in its local memory is still the old value.

If the device blindly reports its stale local values the moment it wakes up, the cloud will treat those as the device's latest state and sync them to the panel — **the user just finished changing it in the app, and the panel flashes and jumps back to the old value**. A UX disaster.

Tuya's solution is `DO_CACHE_SUPPORT` (the item marked "must keep" in Part 9's trimming table): after connecting, the device can send the **0x90** command to ask the module for "the cache accumulated while offline" — essentially, the module has been holding cloud downlinks on the device's behalf. The module fetches the cache from the cloud, the device **applies** the new values from the cache to its local state, and only then reports. The iron rule of ordering:

```
Pull the cache and apply it first → then the full report
```

### 2.3 The Cache State Machine: Three Exits, One Hard Rule

The state machine for the complete chain:

```
        Wi-Fi power on
            │
            ▼
   ┌── WAIT_ONLINE ──handshake done & online──▶ CACHE_REQUESTED ──cache received──▶ apply cache ──┐
   │      (waiting for module)                       │  2s timeout                           │
   │                                                 ▼                                       ▼
   │                                            timeout fallback                    REPORT (single-frame full report)
   └───────────────────────────────────────────────────────────────────────────────────────────┘
                               report done → update report baseline → end of cycle
```

Three exits (cache received / timeout / fallback), but **the full report has only this one trigger point** — this discipline is called "one single exit for reporting". It eliminates ten scattered `report_something()` calls fighting each other: whenever you want to know "did this wake-up cycle report, and when", there's exactly one place to check.

Two carefully chosen parameters, backed by measured data:

- **2-second cache timeout**: after the module receives 0x90 it has to fetch data from the cloud, and the reply measured **0.9–1.4 s** in practice. An early version used 500 ms — the cache was still in flight when the timeout misjudged "no cache", and settings that should have been applied were skipped. The timeout isn't a gut call; it's the slowest measured value plus margin;
- **Report baseline**: after the full report completes, record the current values of all 14 DPs as the baseline. On every subsequent wake-up (Part 7), compare current values against the baseline: only when the change is large enough does the next report cycle trigger. The baseline must be updated here for that judgment to mean anything.

### 2.4 Why Merge 14 DPs into a Single Frame

The SDK's conventional usage is to call the report API per DP — one frame per DP, 14 frames fired in a burst. The problem lives at the physical layer: at 9600 baud, a 14-frame burst takes over a hundred milliseconds, and if any Wi-Fi fluctuation or any single frame is lost, **the module receives an incomplete set of DPs**. On the panel: temperature updates, humidity doesn't, battery still shows the old value — this is exactly where "incomplete data" support complaints come from.

The product's solution: **assemble one big 0x07 frame yourself**, packing all 14 DPs into the data field in protocol encoding order, and send it in one shot. The transmit buffer is sized at 128 bytes for this (dictated by the largest frame, as accounted in Part 9). A single frame either arrives complete or gets retried whole — there's no "halfway state".

## 3. Hands-On Coding

### Step 1: The DP Cache and Single-Frame Packing

```c
typedef struct {
    int16_t  temp_x10, hum_x10, ext_temp_x10;
    uint8_t  battery;
    uint16_t temp_hi, temp_lo, hum_hi, hum_lo;
    uint8_t  unit_f;         // 0=℃, 1=℉
    uint8_t  mute;
    /* …共 14 项，双向 DP 也在其中… */
} dp_cache_t;

static dp_cache_t s_dp;               // 当前值（应用层维护）
static dp_cache_t s_report_ref;       // 上次上报基准

/* 单帧全量上报：手搓 0x07 大帧 */
static void report_all_single_frame(void)
{
    uint8_t buf[128];
    uint16_t n = 0;

    buf[n++] = 0x55; buf[n++] = 0xAA;
    buf[n++] = 0x03;                    // 版本
    buf[n++] = 0x07;                    // DP 上报命令字
    /* 数据区从 buf[7] 开始，先留 2 字节长度，填完回填 */
    uint16_t dstart = n + 2;

    n = dstart;
    buf[n++] = 1;  buf[n++] = 0x02;     // DPID=1 温度, 类型=数值(2字节)
    buf[n++] = (uint8_t)(s_dp.temp_x10 >> 8);
    buf[n++] = (uint8_t)(s_dp.temp_x10 & 0xFF);
    buf[n++] = 2;  buf[n++] = 0x02;
    buf[n++] = (uint8_t)(s_dp.hum_x10 >> 8);
    buf[n++] = (uint8_t)(s_dp.hum_x10 & 0xFF);
    /* …其余 12 个 DP 同法追加… */

    uint16_t dlen = n - dstart;
    buf[5] = (uint8_t)(dlen >> 8);
    buf[6] = (uint8_t)(dlen & 0xFF);

    uint8_t sum = 0;
    for (uint16_t i = 2; i < n; i++) sum += buf[i];
    buf[n++] = sum;

    for (uint16_t i = 0; i < n; i++) uart_putc(buf[i]);   // 单帧一次发出

    s_report_ref = s_dp;                // 更新上报基准
}
```

Each DP is encoded as a triple: `DPID + type/length + data`, exactly matching the SDK's byte-by-byte encoding rules — **so this frame is completely equivalent to per-DP reporting at the protocol level; only the number of transmissions is merged**.

### Step 2: The Cache State Machine

```c
typedef enum {
    CS_IDLE = 0,            // 本周期未开始
    CS_WAIT_ONLINE,         // 等握手 + 连云
    CS_CACHE_REQUESTED,     // 已发 0x90，等缓存或超时
    CS_REPORT,              // 缓存处理完（三出口汇合），执行全量上报
    CS_DONE                 // 本周期结束，等待下一个 Wi-Fi 上电周期
} cache_state_t;

static cache_state_t s_cs = CS_IDLE;
static uint16_t s_cs_tick = 0;
static bool s_online = false;           // 由"收到模组联网状态帧"置位

void cache_task_10ms(void)              // 挂在第 7 篇 PROCESS 状态的 tick 上
{
    switch (s_cs) {
    case CS_IDLE:
        if (wifi_power_is_on()) {       // Wi-Fi 上电周期开始
            s_cs = CS_WAIT_ONLINE;
            s_cs_tick = 0;
        }
        break;
    case CS_WAIT_ONLINE:
        if (s_online) {                 // 握手完成且连云
            tuya_send_frame(0x03, 0x90, NULL, 0);   // 请求离线缓存
            s_cs = CS_CACHE_REQUESTED;
            s_cs_tick = 0;
        } else if (++s_cs_tick >= 1000) {           // 10ms tick × 1000 = 10s
            s_cs = CS_DONE;             // 连云失败：本周期放弃，不白等
        }
        break;
    case CS_CACHE_REQUESTED:
        if (cache_received_and_apply()) {           // 出口①：缓存到达
            s_cs = CS_REPORT;
        } else if (++s_cs_tick >= 200) {            // 出口②：2s 超时
            s_cs = CS_REPORT;           // 超时兜底，照常上报
        }
        break;
    case CS_REPORT:
        report_all_single_frame();      // 出口③：全量上报唯一出口
        s_cs = CS_DONE;
        break;
    case CS_DONE:
        break;
    }
}
```

## 4. Flash and Verify: The Serial-Assistant Show, Season Three (a Scripted Performance)

The serial-port assistant keeps playing the module, and this season it also plays the cloud. Follow the script:

- [ ] **Act 1 (cache present)**: the assistant sends, in order — heartbeat → working-mode query → **network status frame** (sets `s_online`) → receives the MCU's automatic `55 AA 03 90 00 00 93` (the 0x90 request; hand-verify the checksum) → the assistant replies with a cache frame containing DP101=35 → the MCU applies it (prints "cache applied: temp_hi=35" over UART) → the MCU **sends one big 0x07 frame** (the logic analyzer shows all 14 DPs complete, head to tail);
- [ ] **Act 2 (no cache)**: run it again, and after the 0x90 the assistant plays dead. Two seconds later (±10 ms precision) the MCU still sends the full report frame — **the timeout fallback works**;
- [ ] **Act 3 (cloud connect fails)**: the assistant never sends the network status frame. Within the 10-second window the MCU never sends 0x90, never throws an error, and goes back to sleep normally when the window ends — **give up quietly, and bound your failures**;
- [ ] **Act 4 (order verification)**: compare the timestamps of the "cache applied" log and the 0x07 frame from Act 1 — **apply first, report after**: the iron rule of ordering, visible to the naked eye.

## 5. The Original Product (CIU32F003)

The learning version's skeleton is a faithful miniature of the product logic. The real product has four deeper productization details:

1. **0x90 is sent exactly once, and only after the cloud connection is up**. Sending 0x90 while the module isn't connected gets ignored, so the state machine strictly waits for the double condition "handshake complete + network status confirmed";
2. **The module's 0x08 query ("report all your DPs") is an empty implementation** — no reply. That's because the single exit for full reports belongs to the cache state machine; if 0x08 triggered a report directly, it could fire **before** the cache is applied, letting stale values overwrite the user's new settings (the disaster from section 2.2);
3. **During Wi-Fi power-down, the network status is explicitly set to an "unknown" placeholder**. Once the module loses power its network status is meaningless, so the application layer sets it to 0xFF to stop the LCD from showing status icons based on stale state;
4. **The first report after provisioning also goes through the same chain**. It doesn't get a second path just because it's "special" — the single-exit discipline treats first power-up, post-provisioning, and ordinary wake-ups exactly the same.

## 6. Bonus: Three Encounters with the Cache

The cache state machine is one of the most-reworked modules in the project. Here are three real encounters, briefly:

**Round 1: the wrong command byte.** The command originally used to request the cache didn't match the standard documentation — the module simply didn't recognize it, never replied, and the state machine took the timeout fallback every time. On the surface "everything worked" (it did report), but the cache had never actually taken effect, and user settings occasionally got stomped by stale values. Lesson: **for protocol command bytes, check them one by one against the official documentation — don't trust your memory** (this bug only surfaced when we did a dedicated pass over the protocol docs).

**Round 2: the 500 ms timeout's friendly fire.** The initial timeout was 500 ms, which felt "more than enough". In practice, the module takes 0.9–1.4 s to fetch the cache from the cloud — the cache frame kept dying right on the timeout line, the state machine forever took the fallback branch, and it ended up in the same place as Round 1 by a different road. **"Feels like enough" is the least reliable measurement in embedded engineering; the oscilloscope and the logs are the real judges**.

**Round 3: burst-send frame loss forced the single-frame merge.** Per-DP reporting succeeds forever in the lab — good signal, close range, wide-awake module. It wasn't until a full regression test produced "the panel occasionally misses one data item" that we realized the loss rate of 14 back-to-back frames on a real link. After merging into a single frame, "incomplete data" complaints disappeared completely.

The common theme of the three rounds: **"it works in the lab" just means the bug hasn't met its weather yet.** Every fix nudges up the team's weighting of three phrases: "slowest measured value", "worst-case link", "real environment".

## 7. Next Up

The cache can be applied now, but there's still a hole: the user's settings currently live only in RAM — the device dips into Deepstop… no wait, RAM actually survives that — but the moment it **resets** (battery swap, watchdog, OTA), the settings are gone. Next up, Part 12, "Flash Persistence": the erase/write rules of internal Flash (erase-before-write, page-granular erasure), why "store each setting in its own slot" would wear the Flash through, and the product's unified storage block design.

---

*This series is adapted from a real mass-production project; every pitfall described comes from actual development. Reading in order is recommended — the parts build on each other.*
