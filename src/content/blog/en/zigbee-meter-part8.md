---
title: "08 · Memory: The Data Model, KV Persistence, and the Secret to Never Losing Energy Data"
description: "Designing a fixed-point data model that holds 38 DPs, plus KV persistence and the “NV offset + live chip accumulation” architecture that solves the meter industry's ultimate fear: energy resetting to zero after a power loss."
pubDate: 2026-11-24
lang: en
translationKey: zigbee-meter-part8
tags: [Embedded, Zigbee, Tutorial]
series: zigbee-meter
seriesOrder: 8
category: embedded
---

> Goal: Design a data model that can hold 38 DPs, and solve the meter industry's ultimate anxiety — “energy resets to zero after a power outage.”

---

## 1. Why does a meter's data model deserve its own article?

A mobile app's data model can be designed any way you like — run out of memory? Allocate more. Lost some data? Just fetch it again. A meter doesn't have that luxury:

- **Power loss is the norm**: a tripped distribution box, the user swapping batteries (if any), lightning-surge protection kicking in… none of these events may ever reset the accumulated energy to zero;
- **Flash has limited endurance**: the TLSR8258's Flash is rated for roughly 100,000 erase/write cycles. Writing energy data every 10 seconds means 3 million writes a year — **the naive “write to Flash every cycle” scheme would kill the chip within two years**;
- **Data has two faces**: the same energy figure must be reported along the “terminal” dimension (physical fact) and along the “phase” dimension (user's view), and the two must stay strictly consistent.

The three protagonists of this article: `METER_DATA_T` (the data model), KV Flash (persistence), and the aggregation layer (energy arithmetic).

## 2. METER_DATA_T: One Struct Holding the Entire Meter

The runtime values of all 38 DPs live in a single struct:

```c
typedef struct {
    /* ---- 累计电量（RO, scale=2, kWh）---- */
    INT32_T forward_energy_total;   /* DP 1   正向累计总电量 */
    INT32_T reverse_energy_total;   /* DP 2   反向累计总电量 */
    INT32_T forward_energy_1;       /* DP 56  A通道正向电量(按端子) */
    /* ... 共 14 个电量字段 ... */
    INT32_T forward_energy_a;       /* DP 125 A通道正向累计电量(按相) */

    /* ---- 实时数据（RO）---- */
    INT32_T power_total;            /* DP 9   总功率, W×10 */
    INT32_T cur_voltage;            /* DP 101 电压, V×10 */
    INT32_T current_a;              /* DP 102 电流, mA */
    /* ... 共 11 个实时字段 ... */
    INT32_T power_factor_a;         /* DP 108 功率因数, ×100 */

    /* ---- 每小时电量（RO）---- */
    INT32_T forward_energy_a_hour;  /* DP 117 */

    /* ---- 报警（RO, BOOL）---- */
    BOOL_T  power_alarm_a;          /* DP 114 */

    /* ---- 配置（RW）---- */
    BOOL_T  switch_state;           /* DP 16  继电器开关 */
    INT32_T power_setting_a;        /* DP 111 功率阈值, W */
    INT32_T voltage_calibration;    /* DP 132 电压校准 */
    /* ... 共 11 个 RW 字段 ... */
} METER_DATA_T;
```

The design decisions, one by one:

**① Everything is INT32_T / BOOL_T — no floating point.** The DP protocol is fixed-point integers through and through (Part 05), so the data model and the protocol layer are isomorphic, saving a whole conversion layer. Floating point exists only for an instant in the driver conversion; values must be converted to fixed-point before they enter the model (the `HLW_DBG_*` macro family: `(INT32_T)((v) * 10)` and friends). Bonus benefit: the struct can be read from and written to KV as a whole.

**② Single-instance global variable + accessor functions** — no malloc:

```c
STATIC METER_DATA_T sg_meter_data;

METER_DATA_T *app_meter_data_get(VOID_T)    /* 唯一访问入口 */
{
    return &sg_meter_data;
}
```

Dynamic memory is the root of all evil in embedded systems — fragmentation, leaks, nondeterminism. A meter's total data volume is only a few hundred bytes; static allocation + pointer access is simple and predictable.

**③ RO and RW zones.** The struct has 27 RO fields (cleared on power-up, waiting for the chips to fill them) + 11 RW fields (which must persist). This boundary dictates the KV strategy: any change to an RW field is written to disk immediately, while RO data is written only under specific conditions.

**④ Terminal energy (1/2/3) and phase energy (a/b/c) coexist.** `forward_energy_1/2/3` are the raw results of chip readings + NV offset (physical terminals); `forward_energy_a/b/c` are the phase view after cross-mapping (Part 06). Both sets are reported — the cloud can use whichever it prefers.

## 3. KV Flash: TuyaOS's Persistence Primitive

TuyaOS's KV (Key-Value) flash abstraction provides four primitives:

```c
tal_kv_flash_read(key_id, len, buf);     /* 读：不存在返回非 SUCC */
tal_kv_flash_write(key_id, len, buf);    /* 写：Wear-Leveling 由 SDK 负责 */
tal_kv_flash_delete(key_id);             /* 删除 */
```

This project uses 4 KV IDs:

| Key | Content | Size | Write policy |
|-----|---------|------|--------------|
| 0x00 | Reset count (triple power-up pairing) | 1B | Every boot |
| 0x01 | Warm-start magic 0xA5 | 1B | First boot only |
| 0x10 | **RW config block** | sizeof(METER_DATA_T) | **Immediately on any RW change** |
| 0x20 | **NV offsets for 6 energy channels** | 24B (6×INT32) | 60s period + change threshold |

Note the 0x10 trick: **the entire METER_DATA_T is persisted, but only the RW fields are read and written**:

```c
/* 保存：先清零临时结构体，只填 RW 字段，整体写入 */
STATIC VOID_T __meter_rw_save_to_kv(VOID_T)
{
    METER_DATA_T temp_data;
    tal_system_memset(&temp_data, 0, sizeof(METER_DATA_T));
    temp_data.switch_state    = sg_meter_data.switch_state;
    temp_data.power_setting_a = sg_meter_data.power_setting_a;
    /* ... 11 个 RW 字段 ... */
    tal_kv_flash_write(KV_ID_METER_RW_DATA, sizeof(METER_DATA_T), (UINT8_T *)&temp_data);
}

/* 加载：整体读出，只拷 RW 字段回来 */
STATIC BOOL_T __meter_rw_load_from_kv(VOID_T)
{
    METER_DATA_T temp_data;
    if (tal_kv_flash_read(KV_ID_METER_RW_DATA, sizeof(METER_DATA_T), (UINT8_T *)&temp_data) != TAL_KV_SUCC) {
        return FALSE;    /* 首次烧录/恢复出厂后没有数据 */
    }
    sg_meter_data.switch_state    = temp_data.switch_state;
    /* ... 只拷 11 个 RW 字段，RO 保持初始化时的 0 ... */
    return TRUE;
}
```

Why not store just the real size of the 11 fields (about 45 bytes)? Because **reading and writing the whole struct is the simplest approach** — no separate packed format to maintain; adding a field only means adding one copy line in each of the two functions. Trading a few dozen extra bytes of Flash for code robustness is a good deal.

## 4. Energy Survival Across Power Loss: The NV Offset Architecture

This is the core of this article. The difficulty: **the chip's internal energy register clears on power loss** (the HLW811x energy registers are not non-volatile), yet the accumulated energy may already be several hundred kWh. Why not just store the “total energy”? That doesn't work — energy keeps increasing while the device is running, so every Flash write holds a stale value, and a power loss loses the most recent stretch.

This project's solution is called **“NV offset + live chip accumulation”**:

```
                上电时                          运行中                    掉电前
                   │                               │                         │
┌──────────────────┼───────────────────────────────┼─────────────────────────┐
│ 读 KV 0x20:      │  芯片电量寄存器从 0 开始累加   │  每 60s 检查一次：       │
│ sg_nv_offset     │                                │  若 |当前总量 - 上次存档| │
│ = 123450 (kWh×100)│  meter->forward_energy_a      │  >= 1 (0.01kWh):        │
│                  │  = offset + chip_reg           │  存 KV 0x20              │
│ 显示 = 1234.50kWh│  = 123450 + chip累加           │  = 完整当前值           │
│                  │                                │                         │
└──────────────────┴───────────────────────────────┴─────────────────────────┘
   掉电最多丢 60s 内的增量（<0.01kWh 时连这 60s 都省了）
```

The aggregation layer's core code:

```c
/* 相位累计电量 = NV 偏移 + 芯片实时（端子）电量 */
meter->forward_energy_a = sg_nv_offset_fwd_a + meter->forward_energy_1;
meter->forward_energy_b = sg_nv_offset_fwd_b + meter->forward_energy_2;
meter->forward_energy_c = sg_nv_offset_fwd_c + meter->forward_energy_3;
```

The throttled persistence policy (`__energy_nv_save_check`):

```c
#define NV_SAVE_INTERVAL_MS   (60 * 1000)    /* 每分钟检查一次 */
#define NV_SAVE_THRESHOLD     1              /* 变化 ≥1 (0.01kWh) 才写 */

STATIC VOID_T __energy_nv_save_check(VOID_T)
{
    BOOL_T changed = FALSE;
    if (ABS(meter->forward_energy_a - sg_last_fwd_a) >= NV_SAVE_THRESHOLD) changed = TRUE;
    /* ... 6 路都查 ... */
    if (changed) {
        __energy_nv_save();                  /* 写 KV 0x20 */
    }
}
```

Three parameters, three layers of consideration:

- **60-second interval**: a Flash write blocks for milliseconds (interrupt latency during erase), and writing too often disturbs Zigbee timing; 100k cycles ÷ once per minute = 69 days… wait, no — **combined with the change threshold, the actual write frequency depends on the load**: at idle, energy doesn't move and you might not write once in an hour; at full load, roughly once a minute → about 520k writes per year? That won't do either!

  Hold on, recalculate: 100k ÷ 525,600 minutes/year ≈ 0.19 writes/minute — the endurance only lasts 5 months? That's the fatal flaw of the naive algorithm. TuyaOS's KV implementation has **Wear-Leveling**, spreading writes across the entire KV region (effective erase cycles × number of leveling blocks). What the developer sees as “one KV ID” physically rotates among multiple Flash pages. The SDK makes no specific promises, but engineering practice shows that minute-level single-point writes can sustain a product's lifetime. **If your SDK has no wear-leveling, you must design your own “write only when energy changes + minute-level throttling + dual-page rotation”** — which is exactly why this architecture keeps the “change threshold” and the “time interval” as separate controls, making it easy to tune per chip characteristics.

- **Threshold 1 (0.01 kWh)**: a 10W load takes a full hour to accumulate 0.01 kWh, so real household loads write far less often than once a minute;
- **Upper bound on power-loss data loss**: worst case you lose 60 seconds of energy increments — 10kW at full load for 60s is 0.167 kWh (0.1 degree). For a residential meter, this accuracy is entirely acceptable; billing-grade meters use a supercap to survive until the next write — that's a product at another level entirely.

## 5. The Aggregation Layer: The Arithmetic Hub After Every Acquisition

`__aggregate_meter_data()` runs after every “both chips have been read” event, and it is the traffic hub of the entire data flow:

```c
STATIC VOID_T __aggregate_meter_data(VOID_T)
{
    /* ① 相位电量 = NV 偏移 + 芯片实时 */
    meter->forward_energy_a = sg_nv_offset_fwd_a + meter->forward_energy_1;
    /* ... */

    /* ② 总功率 = 三相之和（带符号） */
    meter->power_total = meter->power_a + meter->power_b + meter->power_c;

    /* ③ 总电量 = 三相之和 */
    meter->forward_energy_total = meter->forward_energy_a + ..._b + ..._c;

    /* ④ 报警检查（功率 vs 阈值 → 继电器动作，第 11 篇详述） */
    app_meter_data_update_alarms();

    /* ⑤ NTC 温度 */
    INT32_T adc_val = app_adc_read_pb6();
    if (adc_val >= 0) {
        if (adc_val >= 3200) {
            meter->temp_current = 0;         /* NTC 开路：探头没接，报 0℃ */
        } else {
            meter->temp_current = (INT32_T)(app_adc_get_temperature(adc_val) * 10);
        }
    }
}
```

**Why aggregate after “both chips are read” instead of reporting as each chip finishes?** Because totals, alarms, and reporting all depend on complete three-phase data. The 8112 (SPI, synchronous) finishes first; the 8110 (UART, asynchronous) completes later, and the `__on_hlw8110_done` callback is the trigger point for aggregation — the async state machine from Part 07 completes its mission right here:

```c
STATIC VOID_T __on_hlw8110_done(BOOL_T all_ok)
{
    __hlw8110_health_check(all_ok);
    if (!all_ok) {
        app_lcd_refresh();          /* C 相坏了：A/B 数据仍有效，LCD 照常刷 */
        if (sg_done_cb) sg_done_cb();
        return;                     /* 跳过聚合与上报——数据不全不硬算 */
    }
    __aggregate_meter_data();       /* ★ 唯一的聚合入口 */
    app_meter_data_report_realtime();
    app_lcd_refresh();
    if (sg_done_cb) sg_done_cb();   /* 重启周期定时器 */
}
```

This callback also handles two graceful details: on the first successful acquisition, the LED flashes 5 times quickly (a visual “data ready” signal, tied to the `flash_times` from Part 03); on failure, the LCD still refreshes (the A/B phase data is still valid — user experience must not be buried along with phase C).

## 6. Hourly Energy: The Naive Differential Implementation

DPs 117-124 report “how much energy each phase used in the past hour.” The implementation is textbook differencing (`__hourly_energy_update`):

```c
/* 每小时定时器到点 */
meter->forward_energy_a_hour = meter->forward_energy_1 - sg_hour_start_fwd_a;
/* ... 6 路差值 ... */
meter->forward_energy_total_hour = a + b + c;

/* Baseline 推进到当前值 */
sg_hour_start_fwd_a = meter->forward_energy_1;
/* ... */

app_meter_data_report_hourly();
```

`sg_hour_start_*` is the baseline from the start of the hour; the difference is the hourly energy, and after reporting, the baseline advances to the current value. The one-hour timer is a single-shot software timer that re-arms itself (expires at 60 minutes → compute → restart itself).

Note that hourly energy is differenced on **terminal energy** (`_1/_2/_3`), not phase energy — because terminal energy is the chip's raw continuous count, giving the cleanest difference; phase energy adds the NV offset, which in theory yields the same difference but wraps an extra layer around it. This choice once again reflects the principle of “always use raw data for physical facts.”

## 7. Factory Reset: The Boundaries of Three Kinds of Clearing

“Clear the data” sounds simple, but it actually has three layers, each owned by a different module (these boundaries were drawn after stepping into the pit):

| Layer | Function | What it does | Owner |
|-------|----------|--------------|-------|
| Data model | `app_meter_data_factory_reset()` | Deletes KV 0x10, zeroes RW fields, restores default 500W threshold, opens the relay | Data model module |
| Metering accumulation | `app_meter_read_factory_reset()` | Deletes KV 0x20, clears NV offsets/hourly baselines, clears the chip's running accumulators, LCD back to home page | Metering read module |
| Self-test state | `app_meter_test_reset()` | Self-test channel pointer back to A | Self-test module |

The three functions are called together in the triple-power-up pairing trigger and the REMOTE_LEAVE branch from Part 04. The rationale for the boundaries: only the data model module knows how to parse KV 0x10's format; only the metering read module knows which driver API to call to clear the chip's accumulated count. **“Whoever owns the data clears it” is an iron rule of modularization** — if one function tries to do everything, you will inevitably miss something when a new module is added later.

## 8. Pitfall Log

**Pitfall 1: Energy lost after power loss (NV unreadable at boot).**
Symptom: energy resets to zero on every boot. Troubleshooting: the KV ID macros don't match between the definition and the read/write sites (0x20 written as 0x10, that kind of thing); or `len` is passed wrong on write (sizeof struct vs. sizeof pointer!). In `tal_kv_flash_write(key, sizeof(*ptr), (UINT8_T*)ptr)`, always write `sizeof(struct)`.

**Pitfall 2: Energy “decreases the longer it runs.”**
Difference overflow or sign error: the 6 energy values are `INT32_T` in units of 0.01 kWh, with an upper bound of about 21.47 million kWh — plenty. But **reverse energy is an independent accumulation path inside the chip**; if the driver layer adds reverse energy as a negative number into forward energy, the aggregation layer's addition will cancel itself out. Check the driver's “forward/reverse splitting” logic (the power sign-bit judgment from Part 06).

**Pitfall 3: Flash written to death.**
During development, someone changed `NV_SAVE_INTERVAL_MS` to 5 seconds “for easier debugging”; a few months later, the device's Flash was dead. Lesson: **throttling parameters are product-lifetime parameters** — keep debug configs and production configs separate.

**Pitfall 4: Cloud still shows old energy after factory reset.**
Only local KV was cleared, not the “change-detection cache” (`sg_last_fwd_*`). As a result, at the first periodic report, the difference “current value 0 vs. cached value 12345” exceeded the deadband — it should have reported 0 — but the cache still held the old value's report record, so the logic was actually correct; the real problem is **the cloud needs one full snapshot**. Fix: in `factory_reset`, set `sg_realtime_report_initialized = FALSE`, forcing the next periodic report down the full-report branch (this is exactly what the project's actual fix record did).

## 9. Verification Methods

1. **Power-loss test**: run at load, accumulating 0.5 kWh, power off for 10 seconds, power back on — energy should continue from 0.5 kWh with error ≤0.01 kWh (one 60s save-cycle increment);
2. **Write frequency**: count how often `energy NV saved` appears in the UART log; at idle it should hardly appear once an hour;
3. **Factory reset**: triple power-up pairing → local energy cleared → cloud energy resets to zero after the next full report;
4. **Struct changes**: after adding a field to METER_DATA_T, old devices read a stale-length KV 0x10 — `tal_kv_flash_read` returns an error on length mismatch, and the code should take the “use defaults” branch rather than crash. This is the meaning of `__meter_rw_load_from_kv` returning BOOL.

## 10. Summary

- Data model = single-instance static struct, all fixed-point integers, RO/RW zones, terminal + phase dual views;
- RW config is written to KV 0x10 immediately on any change (whole-struct write, only RW fields read/written); energy uses the “NV offset + live chip” architecture, throttled by the dual conditions of 60s + change threshold to KV 0x20;
- The aggregation layer is the hub of the data flow: energy synthesis, totals, alarms, and temperature all come together here, triggered by the 8110 async acquisition-done callback;
- Hourly energy = differencing, with the baseline advanced once per hour;
- Factory reset's three kinds of clearing belong to three modules: “whoever owns the data clears it.”

The data problem is solved, but one performance bomb remains: when all 38 DPs report together, the SDK's 15-slot send queue can't hold them. Next article: the application-layer send queue — and a real “queue deadlock” incident.

---

*Previous: [07 Sensing (Part 2)] · Series Index · Next: [09 Blood Vessels: The DP Send Queue and a Deadlock Incident]*
