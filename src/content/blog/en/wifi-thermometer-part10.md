---
title: "Part 10: Case Closed — The 'Factory Reset' Mystery Caused by 7 Bytes"
description: "Settings kept 'mysteriously reverting' hours after being changed. The culprit hid in a 7-byte empty frame sent within 1 second of Wi-Fi power-on — Part 8's checksum oddity strikes back, plus a complete embedded-debugging methodology."
pubDate: 2026-11-24
lang: en
translationKey: wifi-thermometer-part10
tags: [Embedded, STM32, Tutorial]
series: wifi-thermometer
seriesOrder: 10
category: embedded
---

> This is the only article in the series that doesn't talk about "how to do it right" — only about "how to track down what's wrong."
> The case really happened. The victim was a product test colleague, and suspects at various points included the Flash storage, the cloud server, and a single Dupont wire. You've actually already met the culprit — in that checksum-mismatched empty frame from Part 8.
> After this post you'll own a complete methodology for embedded troubleshooting: timeline alignment, the capture-frames-first principle, and "question every coincidence."

---

## 1. The Crime Scene: Settings That Keep "Mysteriously Reverting"

A test colleague reported the bug. Their exact words:

> "I changed the high-temperature alert threshold to 35 degrees in the app, and it was fine at the time. A few hours later I looked again, and **it had reverted to the default 30 degrees**. It happened every time I changed it."

Stable reproduction — not intermittent. This is one of the most terrifying bug types in embedded work: **it has a clear business symptom (settings lost) but no program symptom (no crash, no error, no reset).**

Case opened. First, record the facts that the on-site investigation can confirm:

- What's lost is the **user settings stored in Flash** (temperature/humidity thresholds, calibration values, etc.);
- The values after the loss happen to be the **factory defaults** — not random numbers, not zeros, but defaults;
- There is exactly one place in the code that "restores settings to defaults": **the factory-reset routine**.

In other words, the truth behind "settings lost" is "the device executed a factory reset." So the question becomes: who triggered it, when, and why?

## 2. Suspect #1: The Flash Storage Wasn't Written Correctly

The most intuitive suspicion: the storage code has a bug and never actually wrote the data, so on power-up you read back the factory image from Flash.

Verification is simple: add logging to the storage module, then write and immediately read back to verify. **Result: the write succeeded, and read-back matched.** And there's a powerful counter-argument — if the data simply "wasn't stored," the defaults should appear **at power-up**; but in practice the loss usually happens **after the device has been running for a while**, sometimes working fine all day and changing overnight.

The storage code is cleared. But it handed us a crucial clue: **the defaults are actively written in by the "factory reset routine"** — a clue we'll cash in later.

## 3. Suspect #2: The Cloud Pushed Down Default Values

The second intuition: is the cloud syncing down an old configuration? Low-power protocols have a DP caching mechanism — after the device connects to the cloud, it pulls a cached copy from the cloud and applies it. If the cloud cache holds an old value, the device "applying the cache" amounts to overwriting the user's settings.

Verify: capture frames on the serial port, watching the DP push direction. **Nothing.** The cache-application logs also showed the pulled values were exactly what the user had most recently set. Cloud cleared.

Note that by this point we had already spent half a day heading in the wrong direction. Reviewing that wasted half-day: **both suspects were plausible, but only "plausible" — not a single hypothesis had been verified by "capturing frames."** That's the case's first lesson; we'll note it on the ledger now and settle the account at the end.

## 4. The Turning Point: Drawing a Timeline of the Failure

Change tack. Instead of guessing "who did it," align "**when it happened**." Add logging at the entry of the factory-reset routine (one printf), and also record the moment of each Wi-Fi module power-on — let the device confess on its own.

Once the log came out, the case was half solved:

```
[12:03:14] wifi power on          ← Wi-Fi 模组上电
[12:03:15] FACTORY RESET!!!       ← 恢复出厂被触发
[12:03:15] 默认值写入 Flash
```

**Every single factory reset happened within 1 second of the Wi-Fi module powering on.** It's not "happening randomly hours later" — a low-power device sleeps most of the time with the module powered off; every time the user operates the app, the device wakes to report, the module powers up again — and power-up means factory reset. It only reproduced once every few hours simply because "the user operating the app" only happens once every few hours.

Timeline alignment is the Swiss Army knife of embedded troubleshooting: **timestamp every suspicious event and let the correlations surface on their own.**

## 5. The Culprit Revealed: Re-examining the 7-Byte Empty Frame

The culprit must be hiding somewhere inside this 1-second window. What does the module do in that window? Digging through the protocol documentation plus capturing frames on the serial port, the module's first words on power-up are exactly the frame we dissected in Part 8:

```
55 AA 00 02 00 00 01
```

We left a hook hanging back then: by the checksum rules it should have been `0x02`, but the frame carries `0x01`. Now let's hang the frame's anatomy diagram back on the wall and look at the four coincidences side by side:

```
字节:  55   AA   00    02    00   00    01
        │    │    │     │     │    │     │
      帧头  帧头  版本  命令字  长度=0  无数据 校验和
                                  │           │
                                  └── 巧合①：这是一条【空数据帧】
                                              │
                              巧合②：SDK 解析 0x02 时【不看长度】
                                       直接读"数据区第 1 字节"
                                       ──读到的就是 0x01
                                              │
                              巧合③：涂鸦协议里 0x01 恰好是
                                       【AP 配网状态】的编号
                                              │
                              巧合④：应用层收到"进入配网状态"
                                       的约定动作是【恢复出厂】
```

Each coincidence is perfectly harmless on its own; chained together, they form an accident: **the module sends an empty frame as a greeting → the SDK reads the checksum as data → 0x01 gets translated as "AP provisioning mode" → factory reset wipes the user's settings.**

Looking at the SDK source, the problematic code looks like this (simplified):

```c
case 0x02:                              /* 工作模式/状态处理 */
    state = received_data[0];           /* ★ 无长度检查，空帧时读到的是校验和 */
    if (state == AP_STATE) {
        mcu_reset_wifi();               /* 进而触发恢复出厂…… */
    }
    break;
```

The fix is also one line — **ask the length before using the data**:

```c
case 0x02:
    if (data_len >= 1) {                /* 空数据帧不许碰数据区 */
        state = received_data[0];
        ...
    }
    break;
```

## 6. Hands-On: Reproducing and Fixing the Bug Yourself

Hearing the story is no fun on its own — let's reenact the case on the learning board.

**Step 1: write a "sick" mini state handler** (that's the business layer of the Part 8 parser, plus a deliberately planted bug):

```c
static void on_frame_ready(rx_t *f)
{
    switch (f->cmd) {
    case 0x02: {
        /* 病句：不看 f 里记录的数据长度，直接读 data[0] */
        uint8_t state = f->data[0];        // 空帧时，解析器把校验和放进了这里
        if (state == 0x01) {
            uart_puts("!!! factory reset triggered\r\n");
        }
        break;
    }
    ...
    }
}
```

**Step 2: send `55 AA 00 02 00 00 01` with a serial-port assistant** — the serial port immediately prints `!!! factory reset triggered`. Case reproduced.

**Step 3: the fix.** Add a length check at the entry of `on_frame_ready` (`len = (lenh<<8)|lenl; if (len < 1) break;`), then send the same frame again — silence. No action taken.

A ten-minute experiment that walks you through the core conflict of a real case that took months to investigate: **before reading data, first confirm the data exists.** Extend this discipline one step further and it becomes the first rule of all parser code: **never assume there is data beyond what the input's length declaration promises.**

## 7. The Final Lesson: The SDK Is "Borrowed Code"

Case closed — but one loose end must be dealt with: **this fix was made inside the SDK source code**.

The SDK is third-party code, and it will be upgraded someday. If `system.c` is simply overwritten during an upgrade, this fix disappears quietly — the bug comes back, and no compiler error will remind you. So the project has developed the habit of maintaining an "**SDK modification list**" and checking it item by item on every upgrade:

| Change | Location | Reason |
|------|------|------|
| 0x02 empty-frame length check | Parser layer | This case: the empty frame's checksum was misread as the AP state |
| (Buffer macro order fix) | Porting config header | Part 9 bonus: multi-DP pushes silently rejected |
| (Production-test command compatibility) | Command dispatch | Covered in Part 17 |

Every borrowed line of code must be entered into your own ledger.

## 8. Methodology Summary: The Four Relics of This Case

Looking back at the entire investigation, the most valuable takeaway isn't that one-line fix — it's the four pieces of methodology:

**1. Timeline alignment.** Don't guess "who did it" — timestamp the events and align "when it happened." Correlations surface on their own. One line of logging beats a day of guessing.

**2. Capture frames before theorizing.** The half-day this case wasted went entirely into the "guess — verify — eliminate" loop. The correct posture is **to capture frames as the very first step**: nail down the facts with a serial port / logic analyzer first, then start thinking. Embedded-debugging intuition often fails at the protocol layer, because protocol bugs are all silent.

**3. Question every coincidence.** Why was the checksum exactly 0x01? Because the frame is empty — 0x01 is the inevitable result of the accumulation — and 0x01 happens to carry meaning. There are no "coincidences" in engineering; only "inevitabilities you haven't understood yet."

**4. Silent failures cost the most — logging is monitoring.** A high-risk operation like factory reset must have logging at its entry. When writing code, ask yourself one extra question: "If this path is taken, who can see it?" — the closing line of the Part 9 bonus, said once more here. It's worth saying twice.

## 9. The Original Product (CIU32F003)

The product lived through this case in full on its low-power module: on every Wi-Fi power-up, the module sends a 0x02 query with an empty data field, and the stock SDK implementation unconditionally reads the data byte, treating the checksum — always 0x01 — as the AP provisioning state, **mis-triggering a factory reset on every power-up**: erase Flash, write defaults, presenting as "settings saved, but the next report carries the old values again." The fix matches the experiment in this post: add a data-area length check at the parsing layer.

This fix is the first entry on the product's SDK modification list and the number-one item that "must be preserved when upgrading the SDK." The detours taken during the investigation (storage first, then the cloud) are also recorded as-is — **detours are kept in the team documentation so the next person doesn't have to walk them again**.

## 10. Next Up

The case is closed, but the protocol-layer training isn't over. The next topic is subtler: every time the device wakes from Deepstop and the Wi-Fi powers back up, the cloud cache may hold the **new settings the user just changed** — pull the cache first and then report, or report first and then pull the cache? Get the order wrong and the old value overwrites the new one. Next is Part 11, "DP Data Flow and the Cache State Machine": a timing-order debate unique to low-power products, plus the lost-frame history behind "14 DPs merged into a single frame."

---

*This series is adapted from a real mass-production project; every pitfall described comes from actual development. Reading in order is recommended, as the posts build on each other.*
