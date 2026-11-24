---
title: "07 · Sensing (Part B): The HLW8110 UART Async State Machine and the Fight over UART0"
description: "Driving the HLW8110 to read phase-C data asynchronously: the A5 frame protocol, ring buffer, step-table state machine, and a post-mortem of a 14-hour power-freeze mystery."
pubDate: 2026-11-24
lang: en
translationKey: zigbee-meter-part7
tags: [Embedded, Zigbee, Tutorial]
series: zigbee-meter
seriesOrder: 7
category: embedded
---

> Goal: drive the HLW8110 to read phase-C data, understand why a UART driver must be an async state machine, and dissect a 14-hour "power freeze" cold case.
> ⚠️ This is the most technically dense post in the entire series.

---

## 1. HLW8110: The Single-Channel UART Hermit

The HLW8110 is the single-channel sibling of the HLW8112: it has only one current channel, dedicated to phase C. The register address table, conversion formulas, and coefficient region (0x70-0x77) are identical to the 8112 — everything you learned in Part 06 carries over. The real difference is the communication interface: **UART, 9600 bps, 8E1 (even parity)**.

Metering chips with a UART interface have a property that raises embedded engineers' blood pressure: **strict request-response, slow cadence, and no concurrency**. A complete interaction to read one register:

```
Device ──► HLW8110:  A5 <reg_addr>           (2 bytes, read request)
Device ◄── HLW8110:  <N bytes data> <1 byte CS>  (N+1 bytes, response)
```

At 9600 bps, each byte takes about 1.04 ms to transmit. Reading a 3-byte register: send 2 bytes (2 ms) + wait for the chip to process + receive 4 bytes (4 ms) — one round trip is close to 10 ms. A full acquisition reads 7 registers (current/voltage/power/energy/frequency/phase angle/PF) + 3 health-check registers = **10 interactions ≈ 100 ms**.

What does 100 ms mean? If you made synchronous blocking calls like we did for the 8112, the main loop and the Zigbee stack would freeze with you for 100 ms — and the watchdog would kindly reboot you for it. So the 8110 driver was doomed to be asynchronous from its very first line of code. **This is the question planted at the end of Part 06: why can SPI be synchronous while UART must be async? The answer is time — an SPI transaction takes 200 µs, a UART transaction takes 10 ms, two orders of magnitude apart.**

## 2. UART Frame Format: The A5 Header and the Asymmetric Checksum

The HLW8110's UART protocol:

**Read register** (2 bytes):

```
[0] = 0xA5              frame header
[1] = register address  bit7=0 means read
```

Response: `register data (N bytes, big-endian) + 1 checksum byte`, total length = N + 1.

**Write register** (2 + N + 1 bytes):

```
[0] = 0xA5
[1] = register address | 0x80   bit7=1 means write
[2..2+N-1] = data (big-endian, bytes manually reversed)
[2+N] = checksum
```

**The checksum algorithm has a detail that's extremely easy to get wrong — reads and writes are asymmetric**:

```c
/* 写校验和：只对发送帧自身求和 */
CS = ~(TxBuf[0] + TxBuf[1] + ... + TxBuf[len-2]) & 0xFF;

/* 读校验和：要把发送帧的前 2 字节（帧头+地址）也算进去！ */
CS = ~(RxBuf[0] + ... + RxBuf[N-1] + TxBuf[0] + TxBuf[1]) & 0xFF;
```

Why does the read checksum have to include the request frame? Because after receiving a read request, the HLW8110 treats the "request" and the "response" as one logical transaction for checksum purposes — it computes `~(request + response)`. If you only sum the response, the checksum will never pass. There is no "why" for this vendor-specific quirk; you just read the official example code or capture it on an oscilloscope.

**Special command frames** (fixed 4-byte format `A5 EA xx CS`, no response):

| Command | Frame | Function | Purpose |
|---------|-------|----------|---------|
| Enable write protection | `A5 EA E5 CS` | `Uart_HLW8110_WriteREG_EN` | Allow register writes |
| Disable write protection | `A5 EA DC CS` | `Uart_HLW8110_WriteREG_DIS` | Forbid register writes |
| Select channel A | `A5 EA 5A CS` | `Uart_HLW8110_Set_Channel_A` | Which channel PF/phase-angle calcs use |
| Soft reset | `A5 EA 96 CS` | `Uart_HLW8110_Reset` | Chip reset (unused in this project) |

Byte order is guaranteed big-endian by manually reversing bytes through a union: `u8_TxBuf[i+2] = Temp_u32_a.byte[len-1-i]`. This is a defense left in place for cross-platform porting — different MCUs lay out union bytes differently, but manually reversing bytes is always right.

## 3. The Battle over UART0 Ownership

Before we can talk about the async state machine, we must first resolve a resource conflict: **UART0 serves as both the debug log channel and the HLW8110 channel** (the TLSR8258 has only two UARTs, and UART1 isn't routed out).

This project's final solution:

```c
VOID_T app_uart_init(VOID_T)
{
    tal_uart_deinit(USER_UART0);            /* 第一步：释放 SDK 的占用 */

    TAL_UART_CFG_T uart_cfg = {
        .rx_buffer_size = 256,
        { .baudrate = 9600,
          .parity   = TUYA_UART_PARITY_TYPE_EVEN,    /* 8E1 */
          .databits = TUYA_UART_DATA_LEN_8BIT,
          .stopbits = TUYA_UART_STOP_LEN_1BIT,
          .flowctrl = TUYA_UART_FLOWCTRL_NONE, }};
    tal_uart_init(USER_UART0, &uart_cfg);            /* 第二步：重配为 9600 8E1 */
    tal_uart_rx_reg_irq_cb(USER_UART0, __app_uart_rx_irq_cb);  /* RX 直通环形缓冲 */
}
```

The call sequence: `tuya_init_last` → `app_meter_read_init()` → `app_uart_init()`. From that point on, **UART0 belongs entirely to the HLW8110**.

So what happens to the debug log? The TLSR8258 platform has a savior: `Tl_printf` — the Telink SDK's GPIO-bit-banged serial print, which goes out on **pin PC4** (Part 01 covered the `app_print_get_cfg` configuration). The final resource allocation:

| Channel | Purpose | Parameters |
|---------|---------|------------|
| UART0 | HLW8110 dedicated | 9600 8E1 |
| PC4 emulated UART | Debug log | 115200 8N1 |

> Historical anecdote: the earliest version of this project really did share UART0 between the log and the metering — the log was initialized at 115200 8N1, then deinit-ed and reconfigured to 9600 8E1 before metering. The consequence: as soon as metering started, the log turned into garbled noise, and debugging became pure guesswork. After moving the log to PC4, the world became a quiet place. **Lesson: when sharing a resource, look for an alternative channel first instead of time-multiplexing.**

## 4. The Async State Machine: Interrupts Collect Bytes, Timers Advance the Plot

### 4.1 Overall Architecture

```
UART RX 中断 ──► 环形缓冲（64 字节）        ← 生产者，只管存
                     │
                     ▼
              60ms 软件定时器（__on_etimer_step）  ← 消费者，状态机驱动
                     │  ① 取上一步的应答，解析
                     │  ② 发送当前步的请求
                     │  ③ 重启 60ms 定时器
                     ▼
              step 表（读哪些寄存器、收几个字节、怎么解析）
```

This architecture decouples two things: **when bytes arrive** (the interrupt decides) and **which step the protocol is at** (the timer decides). The UART response time is unpredictable (the chip may be busy; interference may cause retransmission), so you can't afford to wait inside an interrupt; but you can have the timer peek every 60 ms at "has the previous step's response arrived yet?"

### 4.2 Ring Buffer: The Most Classic Decoupling Structure

```c
#define HLW_RING_SIZE 64

STATIC UINT8_T sg_hlw_ring[HLW_RING_SIZE];
STATIC volatile UINT8_T sg_hlw_ring_head = 0;   /* 写指针（ISR 用） */
STATIC UINT8_T sg_hlw_ring_tail = 0;            /* 读指针（状态机用） */

/* UART RX 中断回调——只做一件事：存字节 */
STATIC VOID_T hlw8110_uart_rx_cb(UINT8_T *data, UINT16_T len)
{
    for (UINT16_T i = 0; i < len; i++) {
        sg_hlw_ring[sg_hlw_ring_head] = data[i];
        sg_hlw_ring_head = (sg_hlw_ring_head + 1) % HLW_RING_SIZE;
        /* 满则丢弃最旧（覆盖）——宁可丢新数据也不阻塞 ISR */
    }
}
```

Three design points of the ring buffer:

- **Zero processing in the ISR**: the interrupt callback only moves bytes; all parsing happens in the main context (the timer callback) — the shorter the ISR, the stabler the system;
- **Overwrite policy**: when full, drop the oldest. For metering, new data is always worth more than old data;
- **`volatile`**: mandatory for variables shared across ISR/main-loop boundaries, preventing the compiler from optimizing away re-reads in the main loop.

### 4.3 The Step Table: A Declarative State Machine

Instead of writing the state machine as one giant blob of switch-case, it becomes a **data table**:

```c
typedef struct {
    UINT8_T addr;               /* 要读的寄存器地址 */
    UINT8_T rx_len;             /* 期望应答长度（数据 + 1 校验和） */
    hlw_step_parse_t parse;     /* 这一步的解析回调，返回 BOOL */
} hlw_step_t;
```

Two static tables define two kinds of tasks:

**Verification table `g_verify_steps` (12 steps)**: 9 coefficient registers (0x70-0x77 + CHECKSUM 0x6F) + SYSCON/EMUCON/EMUCON2 write-back checks. It runs once 200 ms after power-on to confirm the chip is healthy.

**Acquisition table `g_calc_steps` (11 steps)**: RMS_IA → RMS_U → POWER_PA → ENERGY_PA (split into two steps: read energy first, then read HFCONST to verify) → UFREQ → ANGLE → PF → SYSCON → EMUCON → EMUCON2 (the last three are embedded health checks).

The scheduling core `__on_etimer_step` executes one round every 60 ms:

```c
STATIC VOID_T __on_etimer_step(TIMER_ID timer_id, VOID_T *arg)
{
    /* ① 取上一步应答：凑够字节则取走解析，不足则判 RX_SHORT 失败 */
    if (sg_cur_step > 0) {
        UINT8_T prev_idx = sg_cur_step - 1;
        UINT8_T expect = sg_steps[prev_idx].rx_len;
        if (__hlw_ring_count() >= expect) {
            UINT8_T buf[8];
            __hlw_ring_get(buf, expect);
            if (!sg_steps[prev_idx].parse(buf, expect)) {
                sg_all_ok = FALSE;                    /* 解析失败，记录 */
            }
        } else {
            sg_all_ok = FALSE;                        /* 超时：应答没凑够 */
        }
    }

    /* ② 所有步走完：收尾 */
    if (sg_cur_step >= sg_step_count) {
        sg_state_busy = FALSE;
        if (sg_done_cb) sg_done_cb(sg_all_ok);        /* 通知上层 */
        return;
    }

    /* ③ 发当前步的请求，重启 60ms 定时器 */
    UINT8_T tx[2] = {0xA5, sg_steps[sg_cur_step].addr};
    Start_Send_UartData(tx, 2);
    sg_cur_step++;
    tal_sw_timer_start(sg_etimer_step, HLW_STEP_INTERVAL_MS, TAL_TIMER_ONCE);
}
```

**The timeout handling has no dedicated timeout timer at all** — it relies on the natural check of the 60 ms step interval: if the previous step's response hasn't accumulated enough bytes within 60 ms, it's immediately judged RX_SHORT. At 9600 bps, 60 ms can carry 57 bytes — far larger than the maximum response (5 bytes) — so this "passive timeout" is both simple and sufficient.

The beauty of the declarative step table: **adding a new register = adding one row to the table + writing one parse function**, without touching the state machine skeleton. Part 06 said "to add a new register read, extend the existing step table; do not start a new synchronous blocking read" — this is exactly where that rule lands.

### 4.4 Race-Condition Prevention in the Startup Sequence

```c
OPERATE_RET hlw8110_async_run(VOID_T)
{
    if (sg_state_busy) {
        return OPRT_RESOURCE_NOT_READY;    /* 状态机忙，拒绝重入 */
    }

    __hlw_ring_clear();                    /* ★ 清空环形缓冲再出发 */
    sg_all_ok = TRUE;
    sg_cur_step = 0;
    sg_state_busy = TRUE;
    tal_sw_timer_start(sg_etimer_step, 1, TAL_TIMER_ONCE);   /* 1ms 后开跑 */
    return OPRT_OK;
}
```

Two defense points: `sg_state_busy` prevents re-entry (periodic acquisition and button triggers could collide); **clearing the ring buffer before starting** — this line was bought with blood and tears, as we'll detail shortly.

## 5. The 14-Hour Cold Case: power_c Frozen at 8000 W

This is the most brilliant debugging story in the project, fully recorded in the actual fix history.

### 5.1 Symptoms

After long-term operation (>14 hours), the cloud-side phase-C power suddenly became an absurd value (around 8000 W, while the real load was only a few hundred watts), and it **stayed frozen there forever, never updating again**. Even weirder: a power-cycle always restored it, but it inevitably recurred after another dozen hours or so.

### 5.2 Investigation

Step one, look at the log: `calc failed` from periodic acquisitions was appearing more and more frequently as uptime grew. But the "skip on failure" design means data should simply hold its previous value — how did it jump to 8000 W?

Step two, look at the code: on failure there *was* a "skip writing this acquisition's data" guard — **but it only guarded half the problem**. The trouble was in the ring buffer:

```
第 N 次采集：某一步应答超时（RX_SHORT），判失败。
            但芯片其实应答了，只是延迟超过 60ms——
            这些迟到的字节残留在了环形缓冲里！

第 N+1 次采集：状态机从第 0 步重新开始读，
            第 0 步取"上一步应答"时，从缓冲里取出的是
            上一次残留的错位数据——它居然通过了校验和！
            （残留字节的校验和是"真的"，只是属于错误的寄存器）

            → 电压寄存器的值被当成了功率 → 8000W
```

**Root cause: leftover data occasionally passed the checksum**. A checksum can only verify "the bytes weren't corrupted in transit" — it cannot verify "these bytes are actually the response to this step." A timing misalignment renders the checksum defense useless.

### 5.3 The Fix: Three Lines of Defense

That fix was textbook "defense in depth":

**Line 1 (the cure): clear the ring buffer before starting**. `__hlw_ring_clear()` inside `hlw8110_async_run()` — no leftover data gets a chance to survive into the next acquisition.

**Line 2 (the safety net): write data only if every step succeeded**. `if (!all_ok) return;` in `__on_calc_done` — if any step fails, the entire acquisition is discarded, and METER_DATA_T keeps the last good data. Rather no new data than wrong data.

**Line 3 (physical plausibility clamping)**: a low-power dead zone (<0.3 W / <30 mA treated as no-load and zeroed) and a ±50 kW hard clamp — even if the first two lines both leak, the values stay within physically possible bounds.

Plus two system-level reinforcements: `Init_HLW8110()` gets busy protection (re-initialization must not interrupt a running state machine); and if calc keeps failing for 5 minutes (30 times × 10 s), the device saves the energy count and resets the whole system (the `HLW_RESET_THRESHOLD` mechanism).

### 5.4 Lessons Learned

1. **Checksum ≠ semantic correctness**. A CRC can guard against transmission corruption, but not against timing misalignment. The protocol layer needs a mechanism to ensure "this step's data can only belong to this step" (such as a sequence number — unfortunately the HLW8110 has none).
2. **State leakage in async systems is harder to spot than in sync systems**. Synchronous code fails and returns, and the buffer is invalidated along with it; asynchronous code leaves its failure scene behind for the next execution. Cleaning up (clear buffer) matters just as much as checking in (busy check).
3. **Value clamping is the last insurance policy**. For any data coming from the outside world, ask "is this value physically possible?" before letting it into the system.

## 6. Health Checks: A Three-Level Failure-Recovery System

The 8110's reliability doesn't rest on a single mechanism, but on a cascading system:

```
Level 0: 单步校验和失败 / RX_SHORT        → 丢弃本步，all_ok=FALSE
Level 1: 连续 3 次采集失败 (HLW_INIT_FAIL_THRESHOLD)
          → Init_HLW8110() 重初始化芯片
          （且要 hlw8110_is_busy() 防竞态——状态机跑着时不准重入）
Level 2: 累计失败 30 次 ≈ 5 分钟 (HLW_RESET_THRESHOLD)
          → __energy_nv_save() 保存电量 → tal_system_reset() 整机复位
          （"用户观察到断电重启总能解决问题"的代码化）
```

The comment on Level 2 is refreshingly honest:

> This matches the user's observation that a power-cycle always fixes the issue — a software reset achieves the same effect without human intervention.

"A power-cycle fixes it" is the field engineer's ancestral folk remedy; once you turn it into code, it becomes: persist the critical data first, then reset yourself. 30 failures × 10 s period = 5 minutes — long enough to distinguish "temporary interference" from "genuinely broken".

Additionally, the **last three steps** of every calc run are SYSCON/EMUCON/EMUCON2 read-back checks: if these three registers equal the chip's default values (0x0A04/0x0000/0x0001), the chip has been unexpectedly reset (interference, voltage sag), and re-initialization is triggered immediately — catching the anomaly faster than waiting for the 3-failure counter.

## 7. Timing Arrangement of Initialization and Verification

The register configuration in `Init_HLW8110()` is similar to the 8112's (SYSCON=0x0F04 but with only channel A enabled, EMUCON=0x1183, EMUCON2=0x03FF), but it **does not verify after writing** — because the 15 ms-per-step write sequence has just finished and the chip may still be digesting. Verification is deferred by 200 ms and executed by the async state machine (`sg_etimer_verify_delay` in `app_meter_read_init`).

This 200 ms delay is also why the POWER_ON_ONLINE branch in Part 04 "does not trigger acquisition immediately": verification and the first acquisition share the same state machine, so task scheduling in the early startup phase must assign priorities explicitly.

The coefficient cross-check algorithm in `__on_verify_done`:

```c
/* 8 个系数之和 + 0xFFFF 取反，应等于 CHECKSUM 寄存器 */
UINT16_T sum = 0xFFFF;
for (int i = 0; i < 8; i++) sum += coeffs[i];
if ((~sum & 0xFFFF) == checksum_reg) → 校验通过
```

Unlike the 8112, every coefficient read on the 8110 carries a UART-level checksum verification (the 8112's SPI has no frame-level checksum) — different interfaces, different verification strategies, but the principle stays the same: "if the coefficients can't be trusted, nothing can."

## 8. Data Writing: Where Dead Zone, Clamping, and Calibration Meet

After a successful acquisition, `hlw8110_write_to_meter_data()` writes the phase-C data into `METER_DATA_T` — the intersection point of three business mechanisms:

```c
/* ① 空载死区：小信号噪声清零 */
if (F_AC_I_8110 < 0.03f && fabsf(F_AC_P_8110) < 0.3f) {   /* <30mA 且 <0.3W */
    F_AC_I_8110 = 0; F_AC_P_8110 = 0; ...
}

/* ② 应用层校准（加性偏移，校准篇详述） */
F_AC_V_8110  += meter->voltage_calibration * 0.1f;        /* DP 132: -50~50 → ±5V */
F_AC_I_8110  += meter->current_calib_c  * 0.001f;
F_AC_P_8110  += meter->power_calib_c    * 0.1f;

/* ③ 物理合理性钳位 */
if (F_AC_P_8110 > 50000.0f)  F_AC_P_8110 = 50000.0f;      /* ±50kW */
if (F_AC_P_8110 < -50000.0f) F_AC_P_8110 = -50000.0f;
```

The write order also matters: dead zone first (physical judgment) → calibration second (business correction) → clamping last (safety net). Calibration comes before clamping because a legitimate calibration shouldn't be clamped away; the dead zone comes before calibration because zero-drift calibration must not "resurrect" an unloaded channel.

## 9. Verification Methods

1. **Power-on verification**: 200 ms after boot, the serial log shows OK for each `verify` step; after all 12 pass, the first calc is triggered;
2. **Data comparison**: connect a known load on phase C and compare against a reference power meter, within ±2% error;
3. **Stress test**: run continuously for 48 h and watch the `calc failed` counter (it should stay 0);
4. **Fault injection**: unplug the HLW8110's UART wire — you should see `re-init` after 3 failures, and data recover automatically once the wire is reconnected;
5. **State machine race**: when a button short-press (triggers acquisition) and the 10 s periodic acquisition arrive simultaneously, the log should show `busy, calc skipped` instead of a hang.

## 10. Summary

- The asynchrony of the UART metering driver is forced by transmission time: 100 ms of synchronous blocking is unacceptable, and "interrupt collects bytes + timer drives the state machine" is the only way out;
- The step table turns the state machine declarative — extending to a new register takes only one new row;
- The "no dedicated timeout timer" passive-timeout design: the 60 ms step interval naturally provides the timeout window;
- The 14-hour cold case came down to ring-buffer leftovers + a checksum that can't guard against timing misalignment; the fix was three lines of defense: "clean the scene + write only on full success + value clamping";
- The three-level failure recovery (drop → re-init → full system reset) turns the "just power-cycle it" folk remedy into code.

With that, all three phases' data is in hand. But the data lives in RAM — lose power and it's all gone. The next post tackles the "memory" problem: data model design, KV persistence, energy carry-over across power loss, and the clever "terminal energy + NV offset" architecture.

---

*Previous: [06 Sensing (Part A)] · Series Index · Next: [08 Memory: Data Model, KV Persistence, and the Secret of Never Losing Energy]*
