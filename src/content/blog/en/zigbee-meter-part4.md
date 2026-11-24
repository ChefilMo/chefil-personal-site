---
title: "04 · Joining the Network: Network Pairing Flow and the Network State Machine"
description: "A deep dive into network pairing and the network state machine on a TuyaOS smart meter: two ways to trigger pairing, why the meter never stops measuring offline, and hard-won lessons on delayed reporting."
pubDate: 2026-11-24
lang: en
translationKey: zigbee-meter-part4
tags: [Embedded, Zigbee, Tutorial]
series: zigbee-meter
seriesOrder: 4
category: embedded
---

> Goal: figure out "when the device should start network pairing, what to do when pairing fails, and how to recover from a dropped connection" — until the device shows "online" in the app.

---

## 1. What Is Network Pairing (Join)?

A Zigbee device leaves the factory as a "blank sheet" with no network (Factory New state). It must go through a **Join** before it can attach to a network. The process goes roughly like this:

```
设备                    网关（协调器）
  │                          │
  │──── Beacon Request ────→│  我找工作单位，有谁在招人？
  │←────── Beacon ──────────│  我这儿有网络，PAN ID 是 0xXXXX
  │                          │
  │──── Associate Request ─→│  我要加入
  │←─── Transport Key ──────│  这是网络密钥（加密通信的基础）
  │                          │
  │←── Simple Descriptor Req─│  你都有什么能力？（端点/簇清单）
  │──── Simple Desc Resp ──→│  端点1，簇 0x0003/0x0004/0x0005/0xEF00...
```

The first three steps are handled automatically by the Zigbee protocol stack (one call to `tal_zg_join_start()`), and the last two are exactly where the endpoint descriptors registered in Part 02 come into play.

To the user, all of this happens after pressing a button; to the developer, the real work is in **state management** — should the business logic pause during pairing? How should the LED behave when pairing fails? What if the gateway deletes the device? All of these answers are collected in a single callback: `tal_zg_nwk_status_changed_callback()`.

## 2. Two Ways to Trigger Network Pairing

This project supports two trigger styles, both pointing at the same entry point: `tal_zg_join_start(ZIGBEE_JOIN_MAX_TIMEOUT_MS)`.

### 2.1 Long-Press for 5 Seconds (Production/Debug Style)

As covered in Part 03: long-press for 5 seconds → `etimer_join_start_delay` (fires 50 ms later). There is a very important detail inside that callback:

```c
STATIC VOID_T __app_network_join_start_delay_cb(TIMER_ID timer_id, VOID_T *arg)
{
    /* Long-press triggers factory reset BEFORE re-joining, so the device
     * comes back online with all defaults and no stale calibration/energy. */
    app_meter_data_factory_reset();
    app_meter_read_factory_reset();
    app_meter_test_reset();

    tal_zg_join_start(ZIGBEE_JOIN_MAX_TIMEOUT_MS);
}
```

**Factory reset before pairing**. Why? Picture this scenario: the device ran under customer A's gateway for half a year, accumulating energy and calibration data, and has now been resold to customer B. If it joins a network without clearing that data, customer B's app will show a "new" device carrying 500 kWh of historical energy and someone else's calibration values — the complaint call is already on its way. So "re-pairing" = "a fresh start in life"; all local data gets zeroed.

### 2.2 Triple Power-On (User Style)

Crawling into the distribution box to find a button is not user-friendly, so the home-appliance industry has a time-honored interaction: **three quick power-off/power-on cycles = I want to pair**. The implementation hides inside `app_power_on_check_rst_cnt_proc()`, using a "KV counter + 5-second clear window" mechanism:

```c
VOID_T app_power_on_check_rst_cnt_proc(VOID_T)
{
    /* 看门狗复位不算——那是异常重启，不能触发配网 */
    if (tal_system_get_reset_reason() == TUYA_RESET_REASON_WATCHDOG) {
        return;
    }

    /* 读 KV：复位计数(0x00) 和 warm-start 标记(0x01) */
    tal_kv_flash_read(KV_ID_RST_CNT, ...);
    tal_kv_flash_read(KV_ID_WARM_ST, ...);

    if (v_warm_start != 0xA5) {          /* 冷启动：写魔数，计数归 1 */
        tal_kv_flash_write(KV_ID_WARM_ST, ..., 0xA5);
        tal_kv_flash_write(KV_ID_RST_CNT, ..., 1);
    } else {                              /* 暖启动：计数 +1，满 3 触发配网 */
        v_rst_cnt++;
        if (v_rst_cnt >= 3) {
            tal_sw_timer_start(etimer_join_start_delay, 20, TAL_TIMER_ONCE);
        }
        tal_kv_flash_write(KV_ID_RST_CNT, ..., v_rst_cnt);
    }

    /* 无论哪条路径：启动 5s 清零定时器 */
    tal_sw_timer_start(etimer_clr_rst_cnt_delay, 5000, TAL_TIMER_ONCE);
}
```

Three mechanisms interlock, and not one of them can be missing:

| Mechanism | Purpose |
|------|------|
| **The 0xA5 magic number** | Distinguishes "the very first power-on in this life" (cold start, counter resets to 1) from "yet another power-on" (warm start, counter +1). Without it, every power-on restarts counting from 1 and never reaches 3 |
| **The 5-second clear window** | `etimer_clr_rst_cnt_delay` writes the counter back to 0 five seconds later. Without it, three ordinary on/off cycles spread across a day would also falsely trigger pairing |
| **Watchdog exclusion** | When the chip reboots abnormally, the reset reason is the watchdog — triggering pairing in that situation would be a disaster |

This logic runs during the `tuya_init_second` phase — very early, because the user's "triple power-on" action window is only a few seconds, so we must race against the clock.

## 3. Core: The Network State Machine

`tal_zg_nwk_status_changed_callback(TAL_ZG_NWK_STATUS_E status)` is the single most important callback TuyaOS offers the application layer. Bar none. Every ripple in the network arrives here as a status code. This project handles 9 states, which I've reorganized along "business dimensions" into one decision table:

### 3.1 The Offline Family: LED Off, But the LCD Must Not Stop

```
POWER_ON_LEAVE  上电但未入网（等用户触发配网）
JOIN_TIMEOUT    配网超时
NWK_LOST        网络丢失（失去父节点）
REMOTE_LEAVE    被网关删除
LOCAL_LEAVE     本地退网
```

The common handling for these five states:

```c
case TAL_ZG_NWK_JOIN_TIMEOUT: {
    sg_nwk_online = FALSE;
    app_led_set_mode(LED_MODE_OFF);
    app_meter_read_resume();                                /* ★ 计量继续跑 */
    tal_sw_timer_start(etimer_periodic_report, PERIODIC_REPORT_INTERVAL_MS, TAL_TIMER_ONCE);
    break;
}
```

Note `app_meter_read_resume()` and the start of the periodic timer — **while offline, measurement acquisition and LCD refresh must never pause**. The meter lives in a distribution box; a broken gateway or a lost Wi-Fi link is everyday business. When the user glances at the LCD, they must still see live voltage and current. Only DP reporting is gated by `app_nwk_is_online()` (Part 08 covers the use of this flag in detail).

This is the crystallization of two fixes recorded in the project history. The early implementation was "offline = everything stops," which meant the LCD froze on its last frame as soon as the network dropped, with the WiFi icon still stupidly lit — looking exactly like a crash. The lesson: **there is no equals sign between offline and stopped. Reporting can be cached/skipped; acquisition and display must be autonomous.**

### 3.2 The Online Family: Delayed Reporting, Don't Jump the Gun

```
POWER_ON_ONLINE  上电且已入网（闪存里有网络信息，直接回网）
JOIN_OK          首次配网成功
REJOIN_OK        掉线后重连成功
```

Handling the first successful pairing (JOIN_OK):

```c
case TAL_ZG_NWK_JOIN_OK: {
    sg_nwk_online = TRUE;
    app_meter_read_resume();
    app_led_set_mode(LED_MODE_ON);                          /* 常亮 = 在线 */
    tal_sw_timer_start(etimer_report_all_delay, 6000, TAL_TIMER_ONCE);   /* ★ 等 6 秒！ */
    tal_sw_timer_start(etimer_periodic_report, PERIODIC_REPORT_INTERVAL_MS, TAL_TIMER_ONCE);
    break;
}
```

**Why wait 6 seconds before the full report?** This is the most valuable experience in this post, and the code comment spells it out clearly:

> Right after JOIN_OK, the Zigbee stack immediately generates a huge wave of management traffic (Device Annce, Node/Active/Simple Descriptor Request/Response...), and the SDK's QOS_1 send queue has only **15 slots**. If you blast all 38 DPs from the JOIN_OK callback, every frame comes back with `QUEUE_FULL_ERR`.

The 6 seconds let the stack finish its "new-hire onboarding paperwork." The first join takes longer than a rejoin (REJOIN_OK waits only 3 seconds), because the first join also has to do route discovery — the APS path simply doesn't exist yet, and early frames get silently dropped at QOS_0.

And even one full report isn't safe enough — the first join is too fragile, so `__app_report_all_delay_cb` reports one round after 6 seconds, then **reports a backup round 5 seconds later** (`etimer_report_all_retry`). Those occasional "the data finally looks right" flashes you see in the app are often rescued by this second backup report.

### 3.3 Pairing in Progress: Pause the Business, Fast Blink

```c
case TAL_ZG_NWK_JOIN_START: {
    tal_sw_timer_stop(etimer_periodic_report);
    app_meter_read_pause();                                 /* 采集暂停 */
    app_led_set_mode_force(LED_MODE_FAST_BLINK);            /* 快闪 = 正在找网 */
    break;
}
```

There are two reasons to pause metering during pairing: first, pairing is the busiest moment on the radio, and SPI/UART acquisition can be disturbed by interrupt latency; second, an earlier version stepped into a pit here — during pairing, the HLW8110's async state machine was still running and competing with the joining flow for software timers, and the state machine deadlocked (a later fix resolved this).

`set_mode_force` uses the forced mode covered in the previous post: the user might be holding the button right now, but the pairing fast-blink is the highest-priority signal.

### 3.4 The Deleted Family: Clear the Data, Walk Back Home Automatically

```c
case TAL_ZG_NWK_REMOTE_LEAVE: {     /* 网关上点了"移除设备" */
    sg_nwk_online = FALSE;
    app_led_set_mode(LED_MODE_OFF);
    app_meter_data_factory_reset();     /* 三重清零 */
    app_meter_read_factory_reset();
    app_meter_test_reset();
    app_meter_read_resume();
    tal_sw_timer_start(etimer_periodic_report, ...);
    break;
}
```

Note there is no call to `tal_zg_join_start` here — **reconnection is done automatically by the framework** (`auto_join_remote_leave_flag = TRUE` from Part 02). The application layer only needs to do the "become a new person" part: clear the data, resume metering, and wait for the framework to pull it back into the network.

### 3.5 The Complete State Machine in One Diagram

```
                    ┌─────────────┐
   三连上电/长按5s  │ JOIN_START  │  快闪，暂停计量
        ──────────→│  (配网中)    │
                    └──────┬──────┘
              成功          │           超时
        ┌─────────────────┼──────────────────┐
        ▼                 │                  ▼
  ┌──────────┐            │           ┌─────────────┐
  │ JOIN_OK  │  常亮      │           │ JOIN_TIMEOUT│ 灯灭
  │(首配网)   │            │           └──────┬──────┘
  └────┬─────┘            │                  │ 等下次触发
       ▼                  │                  ▼
  ┌──────────┐            │           (回到离线家族，
  │  ONLINE  │◄───────────┘            LCD 继续显示)
  │  (在线)   │
  └────┬─────┘
       │ 网络丢失
       ▼
  ┌──────────┐   自动重连    ┌───────────┐
  │ NWK_LOST │──────────────→│ REJOIN_OK │
  │  (离线)   │              │  灯亮,3s后 │
  └──────────┘              │  上报RW    │
                            └───────────┘
```

## 4. Three Engineering Details During Pairing

### 4.1 Don't Rush to Acquire When Already Joined at Power-On

The POWER_ON_ONLINE branch contains a comment worth copying into your own homework:

> Do NOT trigger immediate calc here: HLW8110 init verify runs 200ms after boot and occupies the async state machine. Immediate calc would race with verify and get accepted first (sg_state_busy starts FALSE), blocking verify entirely.

When two async tasks fight over the same state machine, **you must dictate who goes first**. The rule: the chip verification at power-on (200 ms, verify) takes priority, and the first real acquisition waits for the 10-second periodic timer to fire naturally. This kind of "initialization race" is extremely common in event-driven architectures — the symptom is "occasionally the first reading is all zeros," and the investigation direction is the task choreography of the early boot phase.

### 4.2 When to Configure Heartbeat and Time Sync

`tal_time_sync_period_set(60 * 1000)` goes in `init_second`, while `tal_heartbeat_period_set(60000)` goes in `init_last` — the former is a protocol-stack service, while the latter involves "reporting the version number to the cloud" and belongs to the business layer. We'll see in the later OTA post that this 60-second heartbeat is the last mile of a successful OTA upgrade.

### 4.3 In Status Callbacks, Only "Bookkeeping" — No "Heavy Lifting"

Look at the function list in every case: set a flag, switch the LED, start/stop timers, (at most) call factory reset. **Not a single case sends Zigbee data directly** — all sending is deferred to timers. The reason is the same as in Part 02: the status callback runs inside the protocol stack's context, and sending data from inside it tends to tangle with the stack's internal queue operations into bizarre timing issues.

## 5. Pitfall Chronicles

**Pitfall 1: Full report immediately in JOIN_OK → a screen full of QUEUE_FULL_ERR.**
Detailed above. Remember the numbers: **the SDK QOS_1 queue has 15 slots**, and the join management traffic lasts about 3–6 seconds.

**Pitfall 2: Stop acquisition when offline → LCD freezes, user thinks it crashed.**
The behavior before the fix. The corrected principle: **acquisition/display are autonomous; reporting is gated.**

**Pitfall 3: One full report on first pairing and calling it done → the app occasionally missing configuration.**
When the APS route isn't established, QOS_0 drops frames silently with no error callback. Countermeasure: one round 6 s after JOIN_OK, plus a backup round 5 s later.

**Pitfall 4: Triple power-on false triggering.**
Most likely the 5-second clear timer wasn't started, or the watchdog reset wasn't excluded. Check that both branches of the triple power-on handling start `etimer_clr_rst_cnt_delay`.

## 6. How to Verify

1. **First pairing**: long-press for 5 s → LED fast-blinks → steady on within 6 s → device appears in the app → `report_all_rw` shows up twice in the serial log (once at 6 s, once at 11 s);
2. **Triple power-on**: with the device normally powered, cycle power quickly three times within 5 s → after the 3rd power-on it automatically enters fast-blink pairing;
3. **Offline self-rescue**: while the device is online, turn off the gateway → log shows `nwk_lost---` → LED off but LCD data still refreshing → turn the gateway back on → `rejoin_ok---` → LED on, RW configuration re-reported 3 s later;
4. **Gateway deletion**: delete the device in the app → `remote_leave---` → the device rejoins the network automatically (no button press needed) → device reappears in the app with energy starting from zero.

## 7. Summary

- The pairing entry point is unified as `tal_zg_join_start`, but there can be many trigger styles (long-press, triple power-on, automatic reconnection after gateway deletion);
- Triple power-on = KV counter + 0xA5 cold-start magic number + 5-second clear window — not one of the three mechanisms can be missing;
- The network state machine is this project's "master scheduler": **keep measuring while offline, report with a delay while online, pause the business while pairing, and walk back home automatically after deletion**;
- The 6-second delay plus the 5-second backup report on the first join are experience bought with QUEUE_FULL_ERR and silently dropped frames;
- Status callbacks only do bookkeeping, never heavy lifting — all Zigbee sends are deferred to timers.

At this point the device can already show "online" in the app — but it still can't "speak." The next post dissects this project's data lifeline: the DP protocol of the Tuya private cluster 0xEF00, the byte-by-byte structure from ZCL frames to DP frames, and how to implement two-way communication between gateway and device.

---

*Previous: [03 Limbs] · Series Index · Next: [05 Language: Tuya Private Cluster 0xEF00 and the DP Protocol]*
