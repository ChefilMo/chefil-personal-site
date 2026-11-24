---
title: "11 · The Referee: Calibration, Power Alarm, and Relay Protection"
description: "Why a meter needs whole-unit calibration, why an additive offset is the pragmatic choice, plus power alarms, relay latching trips, and factory self-test pitfalls."
pubDate: 2026-11-24
lang: en
translationKey: zigbee-meter-part11
tags: [Embedded, Zigbee, Tutorial]
series: zigbee-meter
seriesOrder: 11
category: embedded
---

> Goal: make the data trustworthy (calibration), make over-limit load disconnectable (alarm + relay trip), and explain the full story behind the pragmatic "additive offset" calibration scheme

---

## 1. Why must a meter be calibratable?

The metering chip ships with factory calibration coefficients (the 0x70-0x77 registers from Part 6), but that is calibration at the **chip level** — it only guarantees that the "ADC counts → standard physical quantity" conversion is accurate. Once the whole unit is assembled, error comes from the entire signal chain:

```
电网电压 → 分压电阻(±1%) → 芯片 ADC → 换算值
负载电流 → 分流器/CT(±1%) → 芯片 ADC → 换算值
```

Resistor temperature drift, solder impedance, and PCB layout all introduce 1%~5% of systematic error. Chip-level calibration cannot fix these — there must be a **whole-unit** calibration mechanism: take a standard source (or a reference meter) as the ground truth, measure the deviation, store it, and subtract it at runtime.

This project supports 7 whole-unit calibration items:

| DP | Name | Range | Unit semantics |
|----|------|------|---------|
| 132 | Voltage calibration | -50 ~ +50 | ±5V (scale=0, code ×0.1) |
| 133-135 | A/B/C current calibration | -200 ~ +200 | ±200mA |
| 136-138 | A/B/C power calibration | -50 ~ +50 | ±5W |

The user enters the deviation value in the App (e.g., the reference meter reads 221.5V, the device reads 220.8V, deviation +0.7V → enter 7). The gateway delivers the DP, the device persists it, and applies it after every conversion.

## 2. Implementing calibration: the pragmatic choice of additive offset

### 2.1 Why not multiplicative calibration?

Textbook calibration is usually multiplicative (`actual value = reading × calibration coefficient`), which can correct proportional error. This project chose an **additive offset** (`actual value = reading + offset`). Here is the write-in point for phase C:

```c
F_AC_V_8110  += meter->voltage_calibration * 0.1f;    /* DP 值 ±50 → ±5.0V */
F_AC_I_8110  += meter->current_calib_c  * 0.001f;     /* ±200 → ±0.2A */
F_AC_P_8110  += meter->power_calib_c    * 0.1f;       /* ±50 → ±5.0W */
```

The reasons for the additive scheme:

1. **The dominant error source is zero-point offset.** The ratio error of the divider resistors (multiplicative) is usually <1%, while zero drift, ADC offset, and rectifier voltage drop are fixed additive terms — for a residential meter, additive calibration covers the main errors;
2. **Multiplicative calibration amplifies noise at small signals.** A reading of 0.3A × 1.05 = 0.315, reasonable; but with the additive scheme 0.3 + 0.05 = 0.35 — zero drift is handled more intuitively and controllably;
3. **Simplest to implement, safest to debug.** An additive offset is understandable at a glance. A wrongly entered multiplicative coefficient (say 0 instead of 1) zeroes out the reading outright, while entering 0 for an additive offset just means "no calibration" — inherently safe.

The cost is that proportional error cannot be corrected. If field tests show "accurate at 220V but 5% off at 110V", that's a proportional problem — you have to go back to the chip coefficient layer (writing 0x70-0x77 — this project's code keeps the generic write primitive but does not implement that flow; it's an enhancement item for mass production).

### 2.2 Calibration persistence and immediate effect

Calibration values are RW configuration, following the standard flow from Part 8: DP delivered → `app_meter_data_set_dp` → immediately written to KV 0x10. After a reboot, `__meter_rw_load_from_kv` restores them.

**"Show the calibration effect immediately" is a real UX requirement** (the project's actual fix log contains exactly this entry): the user changes a value on the calibration screen, then looks back at the realtime data panel — the data hasn't changed! Why?

Part 8 explained that periodic reporting has a **deadband filter** (voltage only reports when it changes by ≥10V). A calibration tweak of 1-2V gets swallowed by the deadband. The fix:

```c
/* 校准类 DP 写入后，重置 first-report 标志 */
switch (dpid) {
case DP_ID_VOLTAGE_CALIBRATION:
case DP_ID_CURRENT_CALIBRATION_A: ... case DP_ID_POWER_CALIBRATION_C:
    sg_realtime_report_initialized = FALSE;    /* 下一次周期上报走全量分支 */
    break;
}
```

With the flag cleared, the next `app_meter_data_report_realtime` enters the "first full snapshot" branch and reports all realtime data unconditionally — the user sees the calibration effect in the App within 10 seconds. **Reusing an existing mechanism is the most elegant fix**: no new reporting path was added, only a flag was reset.

## 3. Power alarm: threshold comparison and relay trip

### 3.1 Alarm determination

Each phase alarms when its own power exceeds its own threshold (`app_meter_data_update_alarms`):

```c
VOID_T app_meter_data_update_alarms(VOID_T)
{
    sg_meter_data.power_alarm_a = (abs(sg_meter_data.power_a) > sg_meter_data.power_setting_a * 10) ? TRUE : FALSE;
    /* B、C 同理 */
    ...
}
```

Two details:

- **Absolute-value comparison**: reverse power (generation) also counts as over-limit. In the era of user-side PV grid connection, reverse over-limit protection is a hard requirement;
- **Unit conversion**: `power_setting_a` is integer watts (scale=0), while `power_a` is W×10 (scale=1), so the threshold is multiplied by 10 to align. Inconsistent units are this project's hidden complexity — every comparison point must align the scale first.

The derivation location of the alarm deserves explanation: `update_alarms` is called in the **aggregation layer** (step ④ of `__aggregate_meter_data`) and recomputed on every new sample. Why not put it at the DP delivery point (compute once when the threshold is modified)? Because power changes dynamically — it can cross the line even when the threshold hasn't changed — so it must be re-judged every acquisition cycle.

### 3.2 Tripping: a software implementation of circuit-breaker semantics

What should happen after an over-limit? This project's choice is **force the relay open + latch the state**:

```c
BOOL_T any_alarm = power_alarm_a || power_alarm_b || power_alarm_c;

/* 断路器跳闸语义：任一相超限且继电器当前闭合 → 锁存断开 */
if (any_alarm && sg_meter_data.switch_state) {
    sg_meter_data.switch_state = FALSE;      /* 锁存：用户必须手动重新合闸 */
    __meter_rw_save_to_kv();                 /* 掉电也保持跳闸状态 */
    if (app_nwk_is_online()) {
        /* 跳闸状态必须到达云端：QOS_1 + 立即发送 */
        app_dp_transmit_report_immediate(TUYA_PRIMARY_ENDPOINT, (UINT8_T *)"\x00", 1,
                                          DP_ID_SWITCH, DP_TYPE_BOOL, QOS_1);
    }
}

app_meter_data_switch_apply();               /* 依据最终状态驱动 GPIO */
```

The final output driving the relay:

```c
VOID_T app_meter_data_switch_apply(VOID_T)
{
    BOOL_T any_alarm = power_alarm_a || ...;
    TUYA_GPIO_LEVEL_E lvl;
    if (any_alarm) {
        lvl = TUYA_GPIO_LEVEL_LOW;           /* 报警期间强制断开（不管 switch_state） */
    } else {
        lvl = switch_state ? HIGH : LOW;
    }
    mo_write(SWITCH_RELAY_PIN, lvl);         /* PC0 */
}
```

This design mimics the semantics of a real circuit breaker:

| Circuit breaker behavior | Software counterpart |
|-----------|---------|
| Overload trip | Alarm → relay opens |
| Stays open after tripping (prevents auto-reclose injury) | `switch_state` latched FALSE; must be manually reclosed from the App |
| Trip state survives power loss | `__meter_rw_save_to_kv` writes KV immediately |
| Closing not allowed while the fault persists | In `switch_apply`, alarm takes priority over `switch_state` — the user taps "on" in the App, but as long as the alarm persists, the relay won't pull in |

That last item is the key to the safety design: **the priority check in `switch_apply` makes a "remote reclose" ineffective while an alarm exists.** The user can flip the switch back to ON in the App (the cloud-side switch_state becomes TRUE), but the relay only pulls in after the alarm clears — consistent with a real circuit breaker's "clear the fault before reclosing".

### 3.3 Reliability design of the trip report

The trip frame uses `app_dp_transmit_report_immediate` + QOS_1, double insurance:

- **immediate**: delay_time=0, no queuing — alarms are a race against time; it cannot wait for the periodic frames ahead of it in the queue;
- **QOS_1**: APS-layer ACK + automatic in-stack retransmission — a safety-critical state must reach the cloud.

The offline handling is equally pragmatic: skip the report (`if (app_nwk_is_online())`), but **the KV has already been written** — local state is correct, and the next full report after rejoining will correct the cloud. Better the cloud learns late than the local state be wrong.

## 4. Linkage when the threshold changes

The threshold itself is also an RW DP (111-113). Its delivery path is the same as any RW DP, but after landing it performs one extra action:

```c
case DP_ID_POWER_SETTING_A:
    if (len >= 4) {
        sg_meter_data.power_setting_a = /* 大端解析 */;
        app_meter_data_update_alarms();    /* ★ 新阈值立即重判报警 */
    }
```

Why must a threshold change immediately call `update_alarms`? Imagine the user lowering the threshold from 500W to 100W while the current power is 200W — without an immediate re-judgment, the alarm would have to wait for the next 10-second acquisition cycle, during which the relay stays closed and protection arrives 10 seconds late. **Any input change that affects a safety decision must trigger an immediate re-judgment** — it cannot wait for the cycle.

## 5. Factory self-test: the companion mechanism for production-line calibration

For calibration and alarms to be trustworthy, the premise is "the measurement chain itself is not broken". The meter self-test triggered by a double-click (the entry point was mentioned in Part 3) is exactly this premise check:

```c
/* 从 METER_DATA_T 取当前值，与标准值比对 */
#define TEST_STD_VOLTAGE   220    /* V */
#define TEST_STD_VOLTAGE_TOL   15 /* ±15V */
#define TEST_STD_CURRENT    392   /* mA */
#define TEST_STD_CURRENT_TOL    50
#define TEST_STD_POWER     89     /* W */
#define TEST_STD_POWER_TOL    15

/* 三相逐次测：A → B → C，测完 C 后 done（非循环） */
```

Self-test flow:

```
双击 → 取当前相的 V/I/P
     → |V - 220| ≤ 15 且 |I - 392| ≤ 50 且 |P - 89| ≤ 15 ?
        ├─ 是 → LED 快闪 5 次（app_led_flash_times(5,250,250)）→ 下一相
        └─ 否 → LED 强制熄灭（set_mode_force(OFF)）→ 停在该相
```

Design intent: on the production line, connect a standard load (220V, ~400mA resistive load), then double-click and watch the LED — 5 flashes = this phase passes. Three consecutive double-clicks test all three phases. The standard values are the expected values for the **fixed load** (89W ≈ 220V × 0.4A × PF), and the tolerances ±15V/±50mA/±15W cover component variance.

After `TEST_CHANNEL_DONE`, further double-clicks are ignored — preventing line workers from rapid-firing clicks and messing up the state. Factory reset (Part 8) calls `app_meter_test_reset` to pull the channel pointer back to phase A, preparing for the next round of production testing.

## 6. Pitfall chronicles

**Pitfall 1: calibration takes effect but the App shows nothing (deadband swallowed it).**
Explained above: reset the first-report flag after a calibration DP write.

**Pitfall 2: inconsistent units in the power alarm.**
In the early version, the threshold in watts was compared against the W×10 power value — a 200W load with a 500W threshold would never alarm. Fix: unify the ×10 alignment inside `update_alarms`. **Lesson: mixing two scales of the same data in one code block is a ticking time bomb.**

**Pitfall 3: the relay doesn't reset after the alarm clears.**
In the early version, the alarm wrote `switch_state = FALSE` directly, and after the alarm cleared the relay stayed open — the user got "powered off" without ever doing a trip operation. Fix: distinguish `switch_state` (user intent) from `any_alarm` (physical force); in `switch_apply` the alarm takes priority but does not rewrite `switch_state`... wait, look at the code — the trip does write `switch_state = FALSE` (latch semantics). So where does "auto-recovery after alarm clears" come from? Nowhere — this project chose a **latching trip** (circuit-breaker semantics); after the alarm clears, the user must reclose manually. This is a product decision, not a bug: automatic reclosing is a safety risk while the fault is un-cleared. **Decide the product semantics — "auto-recover or manual-recover after a trip" — before writing code**, otherwise the code gets rewritten back and forth.

**Pitfall 4: threshold boundary chatter.**
When power fluctuates near the threshold, the alarm state flips at high frequency (the relay chatters). This project's mitigation: power itself has a ±30W deadband report (Part 8), and only alarm *state changes* are reported — the flip frequency is capped by the 10s acquisition cycle. Stricter scenarios could add a hysteresis comparator (alarm threshold and clear threshold offset by 5%); this project did not implement it.

## 7. Verification methods

1. **Calibration closed loop**: the standard source outputs 220.0V, the device reads 219.2V → enter voltage calibration +8 in the App → the device reports 220.0V (±0.1V) within 10 seconds;
2. **Alarm trip**: set the threshold to 100W, connect a 150W load → relay opens within 10 seconds + the App switch turns OFF + alarm DP 114 is TRUE; after removing the load, the alarm DP becomes FALSE but the relay stays open (latch verification);
3. **Reclose ineffective during an alarm**: with the alarm active, flip the App switch to ON → the cloud shows ON but the relay does not pull in → after the alarm clears, the relay pulls in automatically (`switch_apply` priority verification);
4. **Trip state survives power loss**: power-cycle in the tripped state → the relay stays open, and the switch DP reports FALSE;
5. **Production-line self-test**: double-click with the standard load connected → LED flashes 5 times; unplug one phase's current channel and double-click again → LED goes off.

## 8. Summary

- Whole-unit calibration uses an **additive offset** (7 DPs persisted in KV 0x10, applied after conversion), pragmatically covering zero-point-type errors; proportional error is the boundary of the additive scheme;
- After calibration, reset the first-report flag, reusing the existing mechanism to make "calibration effect visible immediately";
- Alarm = per-cycle absolute-value comparison (units aligned to scale first); trip = alarm priority over switch state + state latching + immediate KV persistence + QOS_1 immediate report — four layers of protection corresponding to circuit-breaker semantics;
- Threshold changes trigger an immediate re-judgment, not waiting for the cycle;
- Double-click self-test = standard-load comparison + LED language feedback, completing three-phase inspection on the production line in 30 seconds.

The feature set is now complete: it can measure, display, report, and disconnect. The last big thing is **how the firmware itself evolves** — the next part covers OTA upgrades, including all the pitfalls this project hit with OTA: heartbeat version reporting, device-type mismatch, and Flash erase/write conflicts.

---

*Previous: [10 The Face] · Series index · Next: [12 Evolution: The Full OTA Upgrade Flow]*
