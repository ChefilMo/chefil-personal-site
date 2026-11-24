---
title: "06 · Sensing (Part 1): Dual-Channel Metering with the HLW8112 over SPI"
description: "Drive the dual-channel HLW8112 metering chip with GPIO-bit-banged SPI: the three init registers, the fixed-point conversion formulas, RDATA mirror cross-validation against misreads, and the A/B phase cross-mapping left behind by the wiring."
pubDate: 2026-11-24
lang: en
translationKey: zigbee-meter-part6
tags: [Embedded, Zigbee, Tutorial]
series: zigbee-meter
seriesOrder: 6
category: embedded
---

> Goal: bit-bang SPI with GPIO to drive the HLW8112, read the voltage, current, power, and energy of phases A and B, and deal with a "cross-mapping" trap the hardware left behind

---

## 1. What Is the HLW8112?

The HLW8112 is a **dual-channel energy metering chip** from Holi (a domestic Chinese metering chip vendor in the Holtek family). It has two independent ADCs built in (current channels A/B plus one voltage channel) and can meter the current of two circuits simultaneously, along with active power, energy, power factor, frequency, and phase angle. One chip covers both our A and B phases.

It is the sibling of the HLW8110 from Part 07 (single channel, UART interface). The register maps are identical (same address table); only the communication interface differs: **the 8112 speaks SPI, the 8110 speaks UART**. The design of this chip family is elegant — learn one, and the second is just a driver diff.

First, what it gives us (register address table, shared by both chips):

| Register | Address | Bytes | Content |
|----------|---------|-------|---------|
| SYSCON | 0x00 | 2 | System config: channel enable, PGA gain |
| EMUCON | 0x01 | 2 | Metering control: energy accumulation, pulse output |
| EMUCON2 | 0x13 | 2 | Metering control 2: data update rate, clear-after-read |
| RMS_IA / RMS_IB | 0x24 / 0x25 | 3 | A/B channel current RMS |
| RMS_U | 0x26 | 3 | Voltage RMS |
| POWER_PA / POWER_PB | 0x2C / 0x2D | 4 | A/B channel active power |
| ENERGY_PA / ENERGY_PB | 0x28 / 0x29 | 3 | A/B channel energy pulse count |
| PF | 0x27 | 3 | Power factor |
| UFREQ | 0x23 | 2 | Voltage frequency |
| ANGLE | 0x22 | 2 | Current-voltage phase angle |
| RMS_IAC…ENERGY_BC | 0x70–0x77 | 2×8 | **Factory calibration coefficients** |
| CHECKSUM | 0x6F | 2 | Checksum of the coefficient region |

The philosophy of a metering chip: **it does no floating-point math — it only hands you fixed-point raw values**. The voltage RMS register is just a 24-bit integer; to turn it into "220.5 V" you must multiply by the factory calibration coefficient and apply a fixed-point conversion. The datasheet gives you the formulas, but you have to understand them to get them right.

## 2. Bit-Banged SPI: Hand-Cranked Timing on Four Pins

The TLSR8258 has hardware SPI, but pins are scarce (in this project the SPI pins PD7/PD3/PD4/PC1 also have to make room for the LCD and UART), so the driver **bit-bangs SPI mode 0 in plain GPIO** (CPOL=0, sampled on the rising edge):

```c
/* 写一个字节，MSB 先行 */
STATIC VOID_T HLW8112_SPI_WriteByte(UINT8_T x)
{
    for (UINT8_T i = 0; i < 8; i++) {
        if (x & (0x80 >> i))  HLW8112_SDI_H;  else HLW8112_SDI_L;   /* 数据先就位 */
        HLW8112_SCLK_H;
        delay_hlw(HLW_SPI_SPEED);               /* 32 个空循环 ≈ 几 us */
        HLW8112_SCLK_L;
        delay_hlw(HLW_SPI_SPEED);
    }
}
```

```c
/* 读一个字节 */
STATIC UINT8_T HLW8112_SPI_ReadByte(VOID_T)
{
    UINT8_T u8_data = 0;
    for (UINT8_T i = 0; i < 8; i++) {
        u8_data <<= 1;
        HLW8112_SCLK_H;
        delay_hlw(HLW_SPI_SPEED);
        if (IO_HLW8112_SDO_H) u8_data |= 0x01;   /* 时钟高电平期间采样 */
        HLW8112_SCLK_L;
        delay_hlw(HLW_SPI_SPEED);
    }
    return u8_data;
}
```

Timing essentials:

- **MSB first**: the metering chip's registers are all big-endian, consistent with UART/I2C habits;
- **Mode 0**: the clock idles low, and data is sampled by the peer on the rising edge (while SCLK is high); our transmitter places the data bit **before** raising the clock, and the receiver samples MISO **while the clock is high**;
- **Speed**: `HLW_SPI_SPEED=32` empty loops is a few microseconds per bit, about 50 us per byte, and reading a 3-byte register plus command takes ≈ 200 us — acceptable as a synchronous blocking call (this is the key divergence from the UART approach in Part 07).

A complete register read (`Read_HLW8112_RegData`):

```
CS low
  → write command byte (register address, bit7=0 means read)
  → read N consecutive bytes (MSB first into a union)
CS high
```

For a register write, set bit7 of the command byte (`addr | 0x80`) and follow with N data bytes. **An SPI frame has no checksum** — reliability comes from "write-then-read-back verification" (`Check_WriteReg_Success` reads back SYSCON/EMUCON/EMUCON2 and compares) and the 8112's unique RDATA mirror check (more on that later).

GPIO pin mapping: SDI (master-out-slave-in) = PD7, SCLK = PD3, SDO (master-in-slave-out) = PD4, CS = PC1. Note that the 8112's SDO is open-drain, so during initialization the corresponding MCU pin must be configured as an input.

## 3. Initialization: Three Registers Decide Everything

The full flow of `Init_HLW8112()`:

```
1. GPIO init (PD4 input, PD7/PD3/PC1 output, CS high)
2. Write enable: send EA E5 in an SPI frame (disables write protection)
3. Channel select: EA 5A (designates channel A for PF/phase angle/apparent power computation)
4. SYSCON ← 0x0F04     ← system config
5. EMUCON ← 0x1003     ← metering control
6. EMUCON2 ← 0x03FF    ← update rate + no clear-after-read
7. IE ← 0x0000         ← disable all interrupts
8. Write disable: EA DC
9. Read calibration coefficients 0x70-0x77 and run the CheckSum validation
10. Set_V_Zero()       ← voltage zero-crossing detection (INT1 output)
11. Set_underVoltage() ← undervoltage threshold at 180 V (INT2 output)
12. Read_HLW8112_State() reads back all status registers
```

Bit-by-bit meaning of the three core registers:

**SYSCON ← 0x0F04**:

```
0F 04 = 0000 1111 0000 0100
         ││││ ││││
         ││││ └┴┴┴── 电压 PGA = 1 倍增益（bit2-0 = 100 → PGA=1）
         ││└┴─────── B 通道电流 PGA = 16 倍增益（bit5-4 = 11）
         └┴──────── A 通道电流 PGA = 16 倍增益（bit7-6 = 11）

高字节 0x0F = 同时使能 A、B 两路 ADC
```

PGA (programmable gain amplifier) selection is part of the metering circuit design: current sampling uses a manganin shunt or a CT, the signal amplitude is small, and a 16× gain is needed to amplify it near the ADC's full scale for best accuracy; the voltage signal, after resistor-divider scaling, is already strong enough, so PGA=1 avoids saturation.

**EMUCON ← 0x1003**:

```
高字节 0x10：比较器关闭（计量模式和漏电检测模式互斥）
低字节 0x03：使能 A 通道 + B 通道的有功电能累加
```

**EMUCON2 ← 0x03FF** — this one bit changed the entire driver architecture:

```
bit0-1 (11) = 数据更新率 3.4Hz（每 294ms 刷新一次测量结果）
bit3   (1)  = 打开功率因数检测
bit8   (1)  = ZxEn 电压过零使能
bit9   (1)  = WaveEn 波形输出使能
bit10  (1)  = ★ EPA_CB：电量寄存器读后不清零
```

**`EPA_CB=1` is the cornerstone configuration of this project**. By default, the HLW8112's energy registers "clear on every read" — so each read returns only the increment between two reads, which is guaranteed to be lost on power failure and painful to stitch together. With this bit set, energy accumulates freely (paired with the NV offset mechanism at the software layer, Part 08 implements energy continuity across power loss).

The write-protect toggle commands (EA E5 / EA DC) are an old-school safety design: they prevent random SPI noise from a runaway program from overwriting the calibration coefficients. So the init flow is "open the door → configure → close the door".

## 4. Raw Values → Physical Quantities: Four Formulas

Once the coefficient checksum passes, the eight 16-bit coefficients go into global variables (`U16_RMSIAC/IBC/UC`, `U16_PowerPAC/PBC/SC`, `U16_EnergyAC/BC`). All conversions live in the `Read_HLW8112_*` family of functions; take channel A current as an example:

### 4.1 Current (A)

```c
F_AC_I_1 = (FLOAT_T)U32_RMSIA_RegData * U16_RMSIAC / 0x800000 / 0.2 / 1000 * D_CAL_A_I;
```

Step by step:

| Factor | Meaning |
|--------|---------|
| `RMSIA` | 24-bit ADC RMS raw count |
| `RMSIAC` | Factory coefficient: theoretical count ratio for a 1 A current |
| `/ 0x800000` (2²³) | Fixed-point normalization (Q23 format) |
| `/ 0.2` | K1: hardware constant related to the current sampling resistor / transformer ratio |
| `/ 1000` | Unit conversion (the formula yields mA; we want A) |
| `× D_CAL_A_I` | Application-layer calibration coefficient (default 1.0, tuned in the calibration part) |

**The bit23 trap**: if bit23 (0x800000) of `RMSIA` is set, the result is considered invalid (an out-of-range flag), and the driver zeroes the current value.

### 4.2 Voltage (V)

```c
F_AC_V = (FLOAT_T)U32_RMSU_RegData * U16_RMSUC / 0x400000 / 1 / 100 * D_CAL_U;
```

Note the denominator is **2²² = 0x400000**, not 2²³ — voltage and current use different normalization widths, the single easiest digit to get wrong when copying formulas.

### 4.3 Active Power (W) — A Signed Quantity

```c
if (U32_POWERPA_RegData > 0x80000000) {
    mag = ~U32_POWERPA_RegData;        /* 负功率：按位取反得幅值 */
} else {
    mag = U32_POWERPA_RegData;
}
F_AC_P_1 = (FLOAT_T)mag * U16_PowerPAC / 0x80000000 / 0.2 / 1 * D_CAL_A_P;
```

The power register is 32-bit signed fixed-point: **a value greater than 0x80000000 indicates reverse power** (current direction opposite to the voltage reference, i.e. the "generating" state). The magnitude is taken by bitwise inversion (the modulus of the two's complement), and the sign is recorded separately. This sign bit is the basis for splitting forward/reverse energy.

### 4.4 Energy (kWh)

```c
F_AC_E_1 = (FLOAT_T)U32_ENERGYA_RegData * U16_EnergyAC / 0x20000000 / 0.2 / 1 * D_CAL_A_E;
```

The denominator 0x20000000 = 2²⁹ × 4096: 2²⁹ is the fixed-point normalization, and 4096 is the merged-in default value of the HFCONST register (0x1000, the pulse constant). The result is **0.001 kWh per count** — so the energy reported via DP must be ×100 to fit the scale=2 format.

### 4.5 Frequency, Power Factor, Phase Angle

```c
/* 频率：内置 3.579545MHz 晶振分频 */
F_AC_FREQ = 3579545.0f / (8 * U16_UFREQ_RegData);

/* 功率因数：Q23 补码定点 */
if (PF_RegData > 0x800000) PF = (0x1000000 - PF_RegData) / 0x7FFFFF;  /* 容性 */
else                       PF = PF_RegData / 0x7FFFFF;                /* 感性 */
```

A PF engineering detail: below 1 W the PF register is pure noise, so the driver forces it to 0 — otherwise you'd see "ghost power factors" like 0.03 on the app at no load.

## 5. Guarding Against Bad Energy Reads: RDATA Mirror Cross-Validation

Energy reading on the 8112 has a textbook-grade reliability design (`Read_HLW8112_EA/EB`):

```c
/* 同时读 ENERGY_PA(0x28) 和 RDATA(0x44) */
Read_HLW8112_RegData(0x28, ...);   /* 主寄存器 */
Read_HLW8112_RegData(0x44, ...);   /* RDATA：上一个被读寄存器的镜像 */

/* 两者相等且不是 0x000000/0xFFFFFF 才采纳 */
if (energy_val == rdata_val && energy_val != 0x000000 && energy_val != 0xFFFFFF) {
    /* 有效 */
}
```

How it works: inside the HLW8112, the **value of the most recently read register** is mirrored into RDATA. Reading ENERGY_PA and then RDATA back-to-back, any frame misalignment in the SPI communication (a clock glitch causing the two sides to lose sync) makes the two values disagree; 0x000000 and 0xFFFFFF are the classic "bus stuck" values when communication breaks. Stacking the three conditions drives the probability of a misread energy value to nearly zero.

**Forward/reverse energy splitting** relies on the power sign bit (Section 4.3): if the current power is negative, the energy increment read this time goes into the reverse accumulator; if positive, into the forward one. Note this is an **increment judgment** — the register read is cumulative, and the ownership of the delta between two reads is decided by the current power direction.

## 6. Physical Channels ≠ Logical Phases: The Cross-Mapping Trap

Now for the most dramatic part of this project. During hardware wiring, the HLW8112's two physical channels were not connected to the terminals in the "channel A goes to phase A" order:

| HLW8112 physical channel | Actual terminal | Corresponding phase |
|--------------------------|-----------------|---------------------|
| Channel A | Terminal 1 | **Phase B** |
| Channel B | Terminal 2 | **Phase A** |

If the software does nothing, the app shows a surreal bug like "phase A current actually displays the wire of phase B". The fix lives in the aggregation write of `HLW8112_Measure()`:

```c
/* 相位交叉映射：物理 B 通道 → 逻辑 A 相，物理 A 通道 → 逻辑 B 相 */
sg_meter_data->current_a = HLW_DBG_CURR(F_AC_I_2);   /* I_2 是物理 B 通道 */
sg_meter_data->current_b = HLW_DBG_CURR(F_AC_I_1);   /* I_1 是物理 A 通道 */
sg_meter_data->power_a   = HLW_DBG_PWR(F_AC_P_2);
sg_meter_data->power_b   = HLW_DBG_PWR(F_AC_P_1);

/* 功率因数：A 相 PF 用物理 B 通道的 P/(V×I) 计算，
   B 相 PF 直接用物理 A 通道的 PF 寄存器（PF 寄存器只在选定通道上有效） */
```

**Energy, however, is tracked by terminal** (not by phase): `forward_energy_1` records the forward energy of terminal 1 (phase B), and `forward_energy_2` that of terminal 2 (phase A). This is exactly why the thing model has both a "by terminal" set (DPs 56-61) and a "by phase" set (DPs 125-130) of energy datapoints — the terminal dimension is physical fact, the phase dimension is the user's view, and the mapping is done in the aggregation layer (the data aggregation function, Part 08).

This cross-mapping was only fixed in a later repair — before that, the terminal energies of phases A and B were swapped. Lesson learned: **there must be a mapping table between the hardware schematic and the channel definitions in the driver code**; never assume "same name means the same thing".

## 7. Synchronous Sampling: The Full Timing of HLW8112_Measure

The full flow of one sampling pass (invoked by `app_meter_read_trigger_with_cb`):

```
HLW8112_Measure()
  ├─ Read_HLW8112_PA_I()   读 0x24   → F_AC_I_1（物理 A 通道电流）
  ├─ Read_HLW8112_PB_I()   读 0x25   → F_AC_I_2
  ├─ Read_HLW8112_U()      读 0x26   → F_AC_V
  ├─ Read_HLW8112_PA()     读 0x2C   → F_AC_P_1
  ├─ Read_HLW8112_PB()     读 0x2D   → F_AC_P_2
  ├─ Read_HLW8112_EA()     读 0x28+0x44 交叉验证 → 正/反向电量增量
  ├─ Read_HLW8112_EB()     读 0x29+0x44
  ├─ Read_HLW8112_PFA/PFB() 读 0x27 / 计算 → F_AC_PF_1/2
  ├─ Read_HLW8112_Linefreq() 读 0x23 → F_AC_FREQ
  └─ 写入 METER_DATA_T（交叉映射 + 死区 + 钳位）
```

Why synchronous blocking is fine: the whole pass is about 20 SPI transactions × 200 us ≈ 4 ms, perfectly acceptable inside a 10-second sampling task. **Synchronicity is the key difference between the 8112 and the 8110 — the 8110's UART approach uses an asynchronous state machine, and Part 07 will explain why the same idea simply doesn't work over UART.**

## 8. War Stories

**Pit 1: SDO direction in bit-banged SPI.**
The 8112's SDO is open-drain, so the MCU side must be configured as an input. Configured as an output, read operations cause bus contention, and you read all 0s or all 1s.

**Pit 2: init fails if the coefficient checksum doesn't pass.**
`Judge_CheckSum_HLW8112_Calfactor` verifies `~(0xFFFF + Σ8系数) & 0xFFFF == CHECKSUM(0x6F)`. Failure means the communication or the chip is abnormal, and every conversion result is untrustworthy at that point. The health check in the driver (Part 08) retries it 3 times.

**Pit 3: forgetting to disable clear-after-read energy mode.**
If the EPA_CB bit of EMUCON2 (already set in 0x03FF) isn't configured, the chip clears the ENERGY register after every read — the symptom is "energy is always a small number starting from 0". When debugging, read EMUCON2 first to confirm.

**Pit 4: PGA config not matching the hardware.**
Change the sampling resistor without changing the gain, and you get all-zero readings at small currents and saturation at large ones. The PGA bits of SYSCON must be worked out together with the hardware divider/shunt parameters.

## 9. How to Verify

1. After power-on, the serial port should print `Judge_CheckSum_HLW8112_Calfactor OK` (coefficient checksum passed);
2. Connect a known load (e.g. a 100 W bulb), compare `F_AC_P_1/P_2` against the theoretical value — the error should be within ±2%;
3. Compare voltage readings against a calibration source or a reference meter;
4. Run for an extended period (24 h) and watch whether energy accumulation is continuous with no jumps (the real-world test of the RDATA cross-validation).

## 10. Summary

- Dual-channel metering with the HLW8112 = read raw register values × factory-coefficient fixed-point conversion, with SPI bit-banged in mode 0;
- Three registers at init decide everything: SYSCON (channels + PGA), EMUCON (accumulation enable), EMUCON2 (update rate + **no clear-after-read**);
- In the conversion formulas, watch the denominator differences 2²³/2²²/2²⁹ and the power sign bit (forward/reverse);
- RDATA mirror cross-validation is a low-cost, high-reliability anti-misread design;
- The cross-mapping between physical channels and logical phases must be handled explicitly in the driver layer.

We now have data for phases A and B. But a three-phase meter is still missing one phase — and the C-phase HLW8110 talks UART, competing with our only debug serial port for territory. The next part is the most technically dense of the entire series: UART communication, asynchronous state machines, ring buffers, and a 14-hour "frozen power" whodunit.

---

*Previous: [05 The Language] · Series Index · Next: [07 Sensing (Part 2): The HLW8110 UART State Machine and the Battle for UART0]*
