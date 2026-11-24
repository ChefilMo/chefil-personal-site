---
title: "12 · Evolution: The Full OTA Upgrade Flow"
description: "Wire up the full OTA pipeline for a Zigbee device, and dissect four real production failures: heartbeat config, Flash contention, and identity checks."
pubDate: 2026-11-24
lang: en
translationKey: zigbee-meter-part12
tags: [Embedded, Zigbee, Tutorial]
series: zigbee-meter
seriesOrder: 12
category: embedded
---

> Goal: Get the over-the-air upgrade chain working, and dissect the debugging and fixes for real failures like “the app never sees the upgrade succeed” and “OTA bricked the device.”

---

## 1. How Does OTA Work in Zigbee?

What do you do when a bug shows up after the firmware ships? A Zigbee device lives inside a distribution box — there’s no way to bring it back to your desk and flash it over a cable. **OTA (Over-The-Air) is the only answer.**

Zigbee OTA is a two-hop “cloud → gateway → device” push:

```
涂鸦云（存储 UG 固件，决定给谁推）
   │
   │ ① 云端通知网关：设备 X 有新固件 1.0.1
   ▼
网关（Zigbee 协调器，OTA Server 角色）
   │
   │ ② OTA 簇（0x0019）命令：Image Notify / Query Next Image Response
   │ ③ 分块传输：固件切成 ~50-100 字节的 APS 帧，逐块发送
   ▼
设备（OTA Client 角色，SDK 内置状态机）
   │
   │ ④ 写 Flash（固件暂存区）→ 校验 CRC → 切换运行镜像
   ▼
重启运行新固件
```

The application layer actually has very little to do: **receiving and handling OTA cluster traffic is done by the SDK framework**. We only need to “cooperate” in four callbacks. But every detail of that cooperation can be a trap — this project hit four OTA traps in a row, all recorded in the project’s actual fix history. This post dissects each one.

## 2. The Application Layer’s Four Cooperation Moves

### 2.1 Message Dispatch: Hands Off the OTA State Machine

In the message callback you met in Part 02/05, there’s a special branch:

```c
case CLUSTER_OTA_BOOTLOAD_CLUSTER_ID: {     /* 0x0019 */
    /* OTA messages are handled by the SDK framework internally.
     * Log only; do not interfere with the OTA state machine. */
    TAL_PR_DEBUG("ota: framework handles cluster 0x%02x cmd 0x%02x", msg->cluster, msg->command);
    break;
}
```

OTA cluster messages are consumed by the SDK’s internal OTA state machine (automatic replies to Image Block Request, and so on). If the application layer also calls `tal_zg_send_data` here to answer with some frame, it collides with the state machine’s replies — at best you get double traffic, at worst the state machine goes haywire. **Rule: the OTA cluster is observe-only. No action.**

### 2.2 OTA Start: Pause All Flash Writes

`tal_zg_ota_start_callback`:

```c
VOID_T tal_zg_ota_start_callback(UINT_T image_size, VOID_T *argv)
{
    TAL_PR_DEBUG("ota: start, image_size=%d", image_size);

    app_meter_read_pause();                      /* 停计量采集 */
    app_meter_read_stop_timers();                /* 停 NV 存档 + 小时电量定时器 */
    tal_sw_timer_stop(etimer_periodic_report);   /* 停周期上报 */

    app_led_set_mode_force(LED_MODE_SLOW_BLINK); /* 慢闪 = 升级中 */
}
```

**Why stop every timer?** Flash is a shared resource: during the OTA download the firmware is continuously erasing and writing Flash (the TLSR8258 has a single-Flash architecture where program and data coexist). If the energy-data NV persistence fires a KV write at the same moment, the two erase/write cycles can interleave — at best the KV data gets corrupted, at worst the OTA image fails CRC and you brick the device. This isn’t a theoretical risk; it’s a real scenario this project actually had to fix.

The three pause actions cover everything: metering collection (`pause`) prevents write operations inside the collection callback; the NV/hourly timers (`stop_timers`) block periodic disk writes; the periodic report is stopped to prevent KV writes on the reporting path (alarm latching writes KV — see Part 11). **The rule of OTA is one sentence: Flash belongs to OTA alone.**

The slow LED blink (1500 ms period) is user semantics: “the device is upgrading — don’t cut the power.” The blink period was tuned from 750 ms to 1500 ms — too fast looks like an alarm, too slow looks like breathing; 1500 ms is “clearly visible but not anxious.”

### 2.3 OTA End: On Success Wait for Reboot, On Failure Restore Everything

```c
VOID_T tal_zg_ota_end_callback(UINT8_T result)
{
    if (result == 0) {
        /* 成功：LED 常亮后由 SDK 框架重启 */
        app_led_set_mode(LED_MODE_ON);
    } else {
        /* 失败：恢复正常业务 */
        app_meter_read_resume();
        app_meter_read_start_timers();
        tal_sw_timer_start(etimer_periodic_report, PERIODIC_REPORT_INTERVAL_MS, TAL_TIMER_ONCE);
        app_led_set_mode(LED_MODE_OFF);
    }
}
```

The success path deliberately “does nothing”: the reboot is executed by the SDK after the callback returns; the application layer only turns the LED solid to give the user one last visual confirmation. The failure path is the exact inverse of the pause actions — `resume` / `start_timers` / restart periodic reporting. Not one can be missing.

### 2.4 Version Heartbeat: The Last Mile of a Successful Upgrade

This is the biggest trap in this project’s OTA history (the final fix of the three-part OTA saga: *the app never receives the upgrade-success status*).

**Symptom**: OTA clearly succeeded — the device rebooted, the new features worked, the log showed the new version number — yet the app forever displayed “upgrading,” and eventually timed out into “upgrade failed.”

**Debug chain**:

1. The device rejoins the network after rebooting — no problem there;
2. After joining, the SDK automatically reports the application version to the gateway — **but only if the heartbeat mechanism is configured correctly**;
3. Check the code: is `tal_heartbeat_period_set(60000)` actually called? — In the early version that line existed but was commented out; after uncommenting it, the parameter was written as `30*000`... which is a perfectly legal C expression made of `*` and `000` (30 × 000 = 0). A heartbeat period of 0 = never heartbeat!

**Root cause: the heartbeat wasn’t configured, so the cloud never learns the device’s new version, and the upgrade flow stays stuck at “waiting for confirmation” forever.**

The fix is those two lines from `tuya_init_last` in Part 02:

```c
tal_heartbeat_period_set(60000);         /* 每 60s 报一次 */
tal_heartbeat_type_set(HEARTBEAT_APP_VERSION);   /* 报的是应用版本 */
```

**Lesson: C expression errors don’t always error out.** `30*000` compiles and “runs fine” (heartbeat period 0), yet the semantics are completely wrong. This kind of “syntactically correct, semantically absurd” code is the easiest to miss in code review — anyone seeing `30*000` will assume it’s a typo and skip right past it.

## 3. Case Review: Full Files on the Four OTA Failures

### Case File 1: The App Never Sees Upgrade Success
Detailed above. Keywords: heartbeat, version reporting, `30*000`.

### Case File 2: Flash Contention During OTA
Symptom: OTA fails intermittently; after reboot the device is still running the old firmware (or worse: it won’t boot at all).
Root cause: energy-data NV persistence writing Flash concurrently while the OTA download is in progress.
Fix: `app_meter_read_stop_timers()` in `tal_zg_ota_start_callback`; `start_timers()` in the failure callback to restore.

### Case File 3: OTA Never Starts at All
Symptom: the cloud kicked off the upgrade, the device does absolutely nothing — there isn’t even an `ota: start` log.
Root cause: the endpoint’s device type was reported as `ZG_DEVICE_ID_ON_OFF_PLUGIN_UNIT`, which doesn’t match the Tuya cloud product configuration (smart plug), so the cloud never issues the OTA task.
Fix: change the device type to `ZG_DEVICE_ID_SMART_PLUG` when registering the endpoint.
Lesson: **every hop of the OTA chain has an “identity check”** — PID (cloud product), model (Basic cluster), device type (endpoint descriptor). If any of them doesn’t match, the task never reaches the device. When debugging “OTA does nothing” issues, check identity hop by hop, from cloud down to device.

### Case File 4: Upgrade Status Is Imperceptible (UX Level)
Symptom: during the upgrade the user has no idea anything is happening; when it finishes there’s no feedback either.
Fix: an LED language system — slow blink (in progress) → solid on (before the successful reboot).

## 4. Generating OTA Firmware and Version Management

The division of labor between the two build artifacts (covered in Part 01):

| File | Contents | Purpose |
|------|----------|---------|
| `*_QIO_1.0.0.bin` | Bootloader + application (full image) | BDT flashing |
| `*_UG_1.0.0.bin` | Application portion (OTA payload) | Cloud OTA push |

**The version number is the core of OTA comparison**: the third parameter `1.0.0` of the build command is compiled into the firmware (`FW_VERSION_HEX`), the device reports it via heartbeat, and the cloud compares it against the target version to decide whether to upgrade.

Three rules of version management:

1. **Version numbers only go up.** The cloud always pushes to devices whose version is below the target; devices with an equal or rolled-back version number never receive the task. For hotfixes, increment with `1.0.1`, `1.0.2`, and so on;
2. **The UG bin must be built from the same source as the QIO bin.** Don’t mix a 1.0.0 QIO with a 1.0.1 UG — the version the device reports won’t match the code actually running, and the OTA state machine falls into an “upgrade forever” loop;
3. **Run a “power-cut drill” in your dev environment before shipping an OTA**: cut power mid-upgrade, and the device should roll back to the old firmware (the SDK’s dual-image mechanism) or at least enter a retryable state. OTA on the TLSR8258 uses “staging area + verify-then-switch,” so the worst case after a power cut is staying on the old version, not a brick — but you must verify this by actually testing it.

## 5. OTA Regression Test Checklist

Before releasing an OTA version, walk through every item:

- [ ] **Happy path**: 1.0.0 → 1.0.1, LED slow-blinks during upgrade, auto-reboots when done, app shows “upgrade successful” (relies on the heartbeat, up to 60 s delay);
- [ ] **Failure path**: artificially create a weak signal (shield the antenna), interrupt the upgrade, `ota: end, result!=0`, and the device returns to normal operation (timers restarted, collection resumed, LED normal);
- [ ] **Mid-upgrade power cut**: cut and restore power at 50% of the upgrade → device runs the old firmware and works fine → the cloud can push again successfully;
- [ ] **Business interruption check**: KV write count during the upgrade must be 0 (`stop_timers` took effect);
- [ ] **Heartbeat config check**: a `heartbeat: ...` line appears in the log every 60 s (printed by `tal_heartbeat_report_callback`);
- [ ] **Version consistency**: after the upgrade, the `Application version` log matches the target version.

## 6. Summary

- Zigbee OTA = cloud pushes to gateway, gateway transfers in blocks to the device, the SDK writes to a staging area, verifies, and switches; the application layer only makes four cooperation moves (dispatch, pause, restore, heartbeat);
- In `ota_start`, stop **every** Flash write source — Flash is an exclusive resource during OTA;
- The culprit behind “the app never sees upgrade success” is the missing heartbeat version reporting — plus a `30*000=0` C expression trap;
- For “OTA never starts,” check the identity triangle: PID, model, device type;
- The LED’s slow blink / solid on forms the user-facing language of the upgrade process;
- Version numbers only go up, QIO and UG come from the same build, and always run the power-cut drill before release.

With that, the meter’s entire chain — from hardware drivers to cloud communication to self-evolution — is fully connected. The final post wraps things up: whole-system bring-up methodology, full-stroke testing, mass-production flashing and authorization, and the complete evolution story of this project.

---

*Previous: [11 The Referee] · Series Index · Next: [13 Finale: Whole-System Bring-Up, the Road to Mass Production, and a Project Retrospective]*
