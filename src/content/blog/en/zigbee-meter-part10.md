---
title: "10 · Face: VK1621 Segment LCD and NTC Temperature"
description: "Driving a VK1621 segment LCD over a three-wire bit-banged GPIO bus: command/data frame timing, glyph splitting and icon-bit masks, a post-mortem of the WiFi-icon desync bug, plus NTC temperature sensing via a 341-entry lookup table."
pubDate: 2026-11-24
lang: en
translationKey: zigbee-meter-part10
tags: [Embedded, Zigbee, Tutorial]
series: zigbee-meter
seriesOrder: 10
category: embedded
---

> Goal: drive a VK1621 segment LCD (three-wire GPIO bit-banging), implement 6-page rotation display; plus a field guide to NTC temperature sensing via lookup table

---

## Part 1. Why a Segment LCD?

The meter's "face" has several candidates: LED seven-segment displays (cheap but power-hungry, few digits), dot-matrix OLEDs (rich information but expensive, burn-in, heat-averse), and segment LCDs (microamp-level power draw, sunlight-readable, low cost, the industrial meter standard). A meter in a distribution box is powered around the clock, but its display barely needs to change — the segment LCD's "static display consumes almost nothing" property is a perfect match.

The price: segment LCDs have no standard protocol the way driver ICs do — every panel's segment map is customized. How SEG (segment) and COM (common) cross each other, which segment maps to which display-RAM bit, is entirely up to the panel maker's drawing. **Writing a segment LCD driver = writing a "pin-to-pixel" dictionary**, and that is the hardest-core part of this article.

## Part 2. VK1621: An HT1621-Compatible Segment Driver IC

The VK1621 is an LCD driver chip compatible with the Holtek HT1621: it supports 1/2 and 1/3 bias, 2/3/4 COM, and has a built-in RC oscillator plus buzzer/watchdog/time-base (we use none of them). It manages 32×4 = 128 segment bits; our panel uses only 17 SEG × 4 COM.

Wiring is, once again, GPIO bit-banging (scarce TLSR8258 pins, the same old story):

| VK1621 Pin | MCU Pin | Function |
|------------|---------|----------|
| CS | PC2 | Chip select, active low |
| WR | PC3 | Write clock (one low-high cycle per bit) |
| DATA | PD2 | Data line |

The three-wire write timing (`WriteClockVk1621`):

```c
void WriteClockVk1621(void)
{
    VK1621_WR_L();
    delay_nus(VK1621_CLK);      /* 每边 10us → 时钟约 50kHz */
    VK1621_WR_H();
    delay_nus(VK1621_CLK);
}
```

50kHz is painfully slow, but a segment LCD's refresh requirement is also extremely low (a human eye can't tell a 100ms refresh delay apart). A slow clock buys generous timing margin for bit-banged GPIO — a worthwhile trade.

### 2.1 Two Kinds of Frames: Command and Display RAM

Two frame types travel on the VK1621 (HT1621 protocol) wire, distinguished by the start code:

**Command frames** (`WriteCommandVk1621`): start code `100` + 8-bit command + 1 don't-care bit. The initialization command sequence (`Vk1621_Init`):

```c
/* 初始化命令序列 */
OSC_ON      0x01    /* 开 RC 振荡器 */
DISP_ON     0x03    /* 开 LCD 偏压输出 */
COM_1_3__4  0x29    /* 1/3 bias, 4 COM ← 本屏配置 */
BUZZ_OFF    0x08    /* 关蜂鸣器 */
IRQ_DIS     0x80    /* 关 IRQ */
TIMER_DIS   0x04    /* 关时基 */
WDT_DIS     0x05    /* 关看门狗 */
```

Turning off every unused peripheral is embedded etiquette — every running feature is both a power draw and an interference source.

**Display RAM frames** (`WritenDataVk1621`): start code `101` + 6-bit start address + N×4 bits of data (4 bits per SEG, one per COM), with auto-incrementing address:

```
CS 拉低
  → 送 101（3 bit 起始码）
  → 送 6 位地址（A5..A0，MSB 先行）
  → 送数据：每个 SEG 的 4 bit（bit0→COM0, bit1→COM1, ...）
  → 地址自动 +1，连续送 N 个 SEG
CS 拉高
```

## Part 3. Segment Mapping: The Most Brain-Burning Dictionary in the Driver

### 3.1 The Display RAM Model

Inside the VK1621 is a 32×4-bit display RAM; our buffer maps to 17 bytes of it:

```c
UCHAR vk1621_dispram[17];   /* 每个字节的低 4 位有效：bit0→COM0, bit1→COM1, bit2→COM2, bit3→COM3 */
```

This panel's quirk: **one "8" digit (seven-segment) spans two SEGs**. Take the first digit:

```
SEG0 的 4 bit：COM1=1D, COM2=1E, COM3=1F    （三个段）
SEG0 的 bit0(COM0)：1A
SEG1 的低 3 bit：1B, 1C, 1G                  （三个段）
SEG1 的 bit3(COM3)：留作图标位！
```

The seven segments are split "3+1+3" across two adjacent bytes, and the odd byte's top bit is occupied by an icon — **writing one digit means touching two bytes and dodging the icon bit**.

### 3.2 Glyph Table and Split Writes

Glyphs are encoded in seven bits A/B/C/D/E/F/G: the high 4 bits hold the segments of the even SEG byte, the low 4 bits the odd SEG byte. The splitting trick to display one digit (`disp_3num`):

```c
dat8 = dat/100%10;                            /* 取百位 */
vk1621_dispram[0]  = shuzi_zimo[dat8] >> 4;           /* 高 3 段 → 偶数 SEG（整体覆盖） */
vk1621_dispram[1] &= 0xf1;                            /* 清段但保留 bit0 和 bit3 图标位 */
vk1621_dispram[1] |= shuzi_zimo[dat8] & 0x0E;         /* 低 3 段 → 奇数 SEG */
```

Look at the bit-op design of the second operation: `&= 0xf1` keeps bit0 (icon) and bit3 (another icon/reserved bit), clears bit1-2 (old digit segments), and `|= & 0x0E` writes only the segment bits among bit1-3... which bits are segments and which are icons is entirely decided by this panel's drawing. **This code is literally "the drawing, translated into C"** — swap panels, and the glyph table, the `&` masks, and the `>>4` split all have to be redrawn.

Leading-zero blanking: the hundreds digit is cleared when the value is <100, the tens when <10 — a classic segment-LCD requirement, since "  5" reads far better than "005".

### 3.3 A Real Bug: The Global Array Detached from the Hardware RAM

The project's actual fix history contains a very "segment LCD" bug that deserves a full post-mortem:

**Symptom**: after the device lost network connectivity, the WiFi icon (P3) on the LCD refused to go away — clearly offline, still showing online.

**Investigation**: the P3 logic in `disp_4num` looked like this:

```c
/* 只在"在线"时点亮，离线时没有显式清除 */
if (is_online) {
    vk1621_dispram[10] |= 0x01;    /* P3 在 dispram[10] 的 bit0 */
}
/* 没有 else 分支！离线时不清 */
```

Offline, you'd expect dispram[10] to keep its old value (1), so the icon should stay lit — but wait, every `disp_4num` begins with a `Vk1621_DisAll(0x00)` full clear! After that clear, dispram is all zeros and the icon should die, right?

The problem: **`Vk1621_DisAll(0x00)` clears the LCD hardware's RAM, not the `vk1621_dispram[]` global array**:

```c
void Vk1621_DisAll(UCHAR flag)
{
    /* 直接操作硬件显存：全部地址刷成 flag */
    WritenDataVk1621(0, buf_all_flag, VK1621_SEGNUM);
    /* 注意：没有同步修改 vk1621_dispram[]！ */
}
```

And so you get "two copies of state": the hardware RAM is all zeros, but `dispram[10].bit0` in the software array is still 1. Since `WritenDataVk1621` writes from the software array, the next refresh writes the stale P3 value back to the hardware — the icon rises from the dead.

**Root cause: missing synchronization between hardware state and its software mirror.** Fix: add an offline branch with `vk1621_dispram[10] &= ~0x01;` (and, more thoroughly, make `Vk1621_DisAll` zero the software array too).

**Lesson: in any "software mirror + hardware state" two-layer structure, writes must update both sides** — a chronic disease in LCD, LED shift-register, and IO-expander drivers alike.

## Part 4. disp_4num: The Product's Main Display Function

`disp_4num(up, down, is_online, up_down, abc)` is the only display interface the upper layers ever call; its five parameters carry the whole UI:

| Parameter | Meaning |
|-----------|---------|
| `up` / `down` | Upper/lower 4-digit numbers (already converted to fixed-point internally) |
| `is_online` | Online or not (controls the WiFi icon P3) |
| `up_down` | 1 = show V/A unit icons, 0 = show kWh/W unit icons |
| `abc` | Phase indicator: 1=A, 2=B, 3=C (lights one of P4/P5/P6) |

Internal layout:

```c
/* 上行 4 位数字：dispram[0..7]（4 个"8 字"各跨 2 SEG） */
/* 下行 4 位数字：dispram[9..16] */
/* 单位图标行：dispram[8] */
/* 小数点：P1=dispram[5].bit0, P2=dispram[14].bit0 */
/* 在线图标：P3=dispram[10].bit0 */
/* 相位图标：P4/P5/P6 = dispram[9/11/13].bit3（abc 参数选通） */
```

Automatic downgrade for big numbers: when the value is ≥1000 it is divided by 10 and the matching decimal point lights up — the compromise for showing 12345 on a 4-digit tube is displaying "1234.5". This "auto-normalization" frees the upper layers from worrying about range switching.

Finally, `WritenDataVk1621(0, vk1621_dispram, 17)` flushes all 17 bytes into the hardware in one go — a segment LCD refresh is a full display-RAM transfer; there is no partial update that "only changes one bit" (change whichever bit you like, the whole thing still gets re-flushed — and at 17×4=68 bits it costs only 1.4ms anyway).

## Part 5. Six-Page Rotation and the All-Segments Test

### 5.1 Page Scheduling

The metering/reading module defines 6 pages:

| Page | Upper | Lower | Phase Mark |
|------|-------|-------|------------|
| A_V_I | Voltage (V×10) | Phase A current (mA÷100=A×10) | A |
| A_E_P | Phase A energy (forward+reverse, kWh×10) | Phase A power (\|W×10\|) | A |
| Two pages each for B/C | Same as above | | B/C |

The refresh entry `app_lcd_refresh()` does one pure thing: fetch data for the current page from `METER_DATA_T` → divide each field by its own scaling factor to unify everything into the "×10" format → call `disp_4num`. The scaling relationships:

```c
/*   voltage : V×10   → 直接传 (div=1)
     current : mA     → A×10  (div=100)
     power   : W×10   → 直接传 (div=1)
     energy  : kWh×100→ kWh×10 (div=10)  */
```

The page-flip entry `app_lcd_page_next()`: `sg_lcd_page++`, wrap back to 0 at LCD_PAGE_MAX, then refresh. Note it first checks "are we in all-segments mode" — if so, it exits all-segments mode before flipping (interaction logic: a short press right after a triple click means "exit the test, and flip the page while at it").

### 5.2 All-Segments Test Mode

A triple-click triggers this production-line test (`app_lcd_all_segments_on`):

```c
VOID_T app_lcd_all_segments_on(VOID_T)
{
    sg_lcd_all_segments_mode = TRUE;
    Vk1621_DisAll(0x0F);        /* 所有 SEG 的所有 COM 点亮 → 全笔画 */
    tal_sw_timer_stop(sg_etimer_lcd_all_segments);
    tal_sw_timer_start(sg_etimer_lcd_all_segments, LCD_ALL_SEGMENTS_TIMEOUT_MS, TAL_TIMER_ONCE);  /* 5s 自动退出 */
}
```

Design intent: during factory inspection a worker triple-clicks the button and the whole screen lights up — a visual check for broken or missing segments — then automatically returns to normal display after 5 seconds. Meanwhile `app_lcd_refresh` returns immediately (no refresh), and on exit it restores the current page's data.

This mode also echoes the factory reset from Part 08: `app_meter_read_factory_reset` forcibly exits all-segments mode (`sg_lcd_all_segments_mode = FALSE`), preventing the bizarre state of "screen still in test mode after a factory reset".

### 5.3 Offline Display Strategy

As covered in Part 04: when the network drops, the LCD keeps refreshing as usual (`POWER_ON_LEAVE` / `JOIN_TIMEOUT` / `NWK_LOST` all restart the periodic timer) — only the WiFi icon goes dark. This is the fruit of two later fixes, and the basis for the judgment is the `app_nwk_is_online()` global flag — the junction where data model, network state machine, and display layer all meet.

## Part 6. NTC Temperature Sensing: 341-Point Lookup + Binary Search

The meter needs to measure ambient temperature (an input for overheat protection and accuracy compensation). The sensor is an NTC thermistor (negative temperature coefficient: temperature ↑, resistance ↓) wired between PB6 and 3.3V, with a 10kΩ pull-up divider.

### 6.1 The Hardware Chain

```
3.3V ── 10kΩ 上拉 ──┬── PB6 (ADC ch6)
                    │
                  NTC ── GND
```

ADC reads the voltage → the divider formula back-solves the NTC resistance → table lookup → temperature. Every step has its engineering details.

### 6.2 ADC Sampling

```c
#define ADC_SAMPLE_AVG_CNT  4

INT32_T app_adc_read_pb6(VOID_T)
{
    INT32_T sum = 0;
    for (int i = 0; i < ADC_SAMPLE_AVG_CNT; i++) {
        sum += tkl_adc_read(...);      /* 12 位，3.3V 参考 */
    }
    return sum / ADC_SAMPLE_AVG_CNT;   /* 4 次平均压噪声 */
}
```

Averaging 4 samples is the most primitive filtering — NTC signals change slowly, so extra averaging costs nothing. In noise-prone power setups you can go to 8 samples or a median filter.

### 6.3 Resistance Conversion and Boundary Handling

```c
/* ADC(mV) → NTC 电阻(kΩ) */
FLOAT_T __adc_to_ntc_resistance(INT32_T adc_val)
{
    if (adc_val <= 0)    return NTCTAB[0] + 1;        /* 对地短路：返回"极低温"值 */
    if (adc_val >= 3300) return NTCTAB[340] - 0.001f; /* 开路(满量程)：返回"极高温"值 */
    return PULLUP_RESISTANCE_K * adc_val / (3300 - adc_val);   /* R = 10k × ADC/(3300-ADC) */
}
```

The boundary design is genuinely interesting: **instead of returning an error code, it returns a resistance "beyond physical possibility"** — a short to ground yields a resistance larger than even -40°C's, an open circuit yields one smaller than even 300°C's — so the subsequent lookup naturally lands at the two ends of the table and gets clipped by `NTC_TEMP_MIN/MAX` (-40/300°C). Sentinel values instead of error propagation; the code flows better.

### 6.4 Lookup + Linear Interpolation

The NTC resistance-temperature relationship is an exponential curve (Steinhart-Hart equation), and floating-point math is too luxurious. The standard engineering solution: **precomputed resistance table + binary search + linear interpolation**.

```c
/* NTCTAB[341]：-40℃ ～ 300℃ 每 1℃ 一个阻值，降序排列（温度升 → 阻值降） */
STATIC CONST FLOAT_T NTCTAB[341] = { 191.21f /* -40℃ */, ..., 0.15f /* 300℃ */ };

/* 二分查找阻值所在的温度区间 */
STATIC INT32_T __ntc_find_index(FLOAT_T r)
{
    INT32_T low = 0, high = 340;
    while (low < high) {
        INT32_T mid = (low + high) / 2;
        if (r > NTCTAB[mid]) high = mid;      /* 阻值大 → 温度低 → 往左 */
        else               low  = mid + 1;
    }
    return low;
}

/* 查表 + 线性插值，输出 0.1℃ 精度 */
FLOAT_T app_adc_get_temperature(INT32_T adc_val)
{
    FLOAT_T r = __adc_to_ntc_resistance(adc_val);
    INT32_T idx = __ntc_find_index(r);
    /* temp = idx 基准温度 + (区间阻值差比例) × 1℃ */
    FLOAT_T temp = -40 + idx + (NTCTAB[idx] - r) / (NTCTAB[idx] - NTCTAB[idx+1]);
    if (temp < -40)  temp = -40;
    if (temp > 300)  temp = 300;
    return temp;
}
```

A 341-point descending table, 9 comparisons of binary search to locate the interval, one linear interpolation for 0.1°C precision — the entire temperature chain (ADC sampling + conversion + lookup) takes under 1ms, with only a handful of floating-point divisions in total. Lookup tables are the classic trade-off on resource-constrained systems: 341×4=1364 bytes of Flash in exchange for zero complex math.

### 6.5 The Semantics of Open-Circuit Detection

We saw this line back in Part 08:

```c
if (adc_val >= 3200) {
    meter->temp_current = 0;    /* NTC 探头没接：报 0℃ 而非 300℃ */
}
```

Why report 0 on open circuit instead of the maximum temperature? Because "probe not connected" is a common state on production lines and installation sites (the NTC is optional), and displaying 0°C is an unambiguous "invalid" signal (a meter's interior can never be 0°C), whereas 300°C would be a false "it's on fire" alarm. Semantic design: **an invalid value must be a number that cannot possibly be mistaken for a real one**.

## Part 7. Pitfalls in the Trenches

**Pitfall 1: The segment table doesn't match the actual panel.**
Symptom: digits show missing or misplaced segments. Cause: the panel vendor changed and the glyph table wasn't updated. Countermeasure: run `Vk1621_Test()` first (all-on → all-off → point-by-point scan) to confirm the SEG/COM mapping, then match the glyph table.

**Pitfall 2: The WiFi icon won't disappear offline.**
Dissected above: the software array and hardware RAM fell out of sync as two copies of state.

**Pitfall 3: NTC readings jump around.**
The ADC reference voltage sags when Wi-Fi/Zigbee transmits (shared 3.3V rail). Countermeasure: 4-sample averaging (already in the code); the more brutal option is sampling in the gaps between transmissions, but unnecessary for a meter.

**Pitfall 4: Large values overflow the display.**
When energy exceeds 999.9 kWh, the 4-digit tube can't hold it. The ≥1000 auto-÷10 mechanism in `disp_4num` solves the numeric layer, but at the product-definition level, "the energy page maxes out at 9999 kWh" must be noted in the thing model (beyond that, check the app).

## Part 8. How to Verify

1. **Display integrity**: triple-click for all-segments, eyeball every segment; use `Vk1621_Test` point-by-point scan to locate dead segments;
2. **Six pages of data**: short-press to flip pages, cross-check each page against the app (voltage ×0.1V, current ×0.001A, power ×0.1W);
3. **Offline display**: after cutting the network, the LCD keeps refreshing and the WiFi icon goes dark; it relights after recovery;
4. **Temperature accuracy**: hook the NTC to a standard resistance box (or roughly calibrate with ice water at 0°C and boiling water at 100°C); error within ±1°C;
5. **Open-circuit detection**: unplug the NTC — the temperature should read 0.0°C.

## Part 9. Summary

- VK1621 three-wire GPIO timing (CS/WR/DATA), command frames starting with `100`, display RAM frames with `101`, 4 bits per SEG in RAM mapping to the 4 COMs;
- The core of a segment driver is the "SEG-COM-pixel" dictionary: glyph splits and icon-bit masks all come from the panel drawing;
- Software mirror and hardware state must be updated in lockstep (the WiFi icon bug);
- Six-page rotation + all-segments test + offline-persistent display together form the meter's human-machine interaction loop;
- NTC temperature = divider back-solve for resistance + 341-point binary-search lookup + linear interpolation, with sentinel values handling open and short circuits.

The device can now be seen, pressed, and can measure temperature. The next article covers the mechanism that makes the data "trustworthy": the calibration system, power alarms, and relay protection — in other words, what makes this meter valuable as a "protection device."

---

*Previous: [Part 9 · Blood Vessels] · Series Index · Next: [Part 11 · The Judge: Calibration, Power Alarms and Relay Protection]*
