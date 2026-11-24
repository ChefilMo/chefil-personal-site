---
title: "Part 4: ADC — Measuring Battery Voltage and NTC Temperature"
description: "The last two senses: battery voltage and NTC external temperature, both built on the same recipe — a resistor divider plus the ADC — plus the production trick of powering the divider only while measuring."
pubDate: 2026-11-24
lang: en
translationKey: wifi-thermometer-part4
tags: [Embedded, STM32, Tutorial]
series: wifi-thermometer
seriesOrder: 4
category: embedded
---

> Parts 1 and 2 gave it a "mouth" (UART) and a "sense of temperature and humidity" (I2C). This post completes the last two senses: **battery voltage** (the product needs to know how much juice it has left) and **NTC external temperature** (that probe you can stick outside the window).
> Behind both is the same analog-circuit recipe: **resistor divider + ADC**. This recipe runs through almost every battery-powered product — learn it once and it's yours for life.

---

## 1. Goals and the Payoff

**Goals**:

1. Build a voltage divider with two resistors, measure the voltage of a "fake battery", and print it over serial;
2. Hook up an NTC thermistor, pinch the probe between your fingers, and watch the temperature value climb on the serial output.

**What you'll understand afterwards**: what an ADC actually measures, how to design a divider circuit, how an NTC's resistance turns into temperature, and one production-grade trick — **power the divider only while measuring, keep it unpowered the rest of the time**.

## 2. Ten Minutes of Theory

### 2.1 ADC: Translating Voltage into Numbers

An ADC (analog-to-digital converter) answers one question: **what fraction of 3.3V is the voltage on this pin?**

The STM32F103's ADC is 12-bit, meaning it outputs a number from 0~4095:

```
raw value = (V_pin / V_ref) × 4095
```

The reference voltage V_ref is 3.3V, so **each count represents about 0.806 mV**. Inverting:

```
V_pin = raw × 3.3 / 4095
```

This is the foundational formula of every ADC application. Memorize it — everything that follows is just this formula wearing different costumes.

### 2.2 Divider: What If the Voltage Is Too High

Here's the problem: battery voltage can exceed 3.3V (two fresh batteries in series can go above 3.3V), and an ADC pin cannot be connected straight to the battery. The fix is middle-school biology... no, middle-school physics: **the resistive voltage divider**.

```
 BAT+ ──┬── R_upper ──┬── R_lower ──┬── BAT-
        │             │             │
     (high)        ADC pin         GND
```

What the ADC pin measures is the midpoint voltage:

```
V_adc = V_bat × R_lower / (R_upper + R_lower)
```

This is exactly the setup in the product: a 270K upper resistor to the battery and a 3M lower resistor to ground, giving a divider ratio of about 0.92. The firmware recovers the real voltage with the **inversion formula**:

```
V_bat = V_adc × (R_upper + R_lower) / R_lower
```

Note that all resistor values are defined as macros. **Resistor values change** (different BOM batches may adjust them); hard-coding them into formulas is planting a landmine for yourself.

### 2.3 NTC: How Resistance Becomes Temperature

NTC (negative temperature coefficient thermistor): the higher the temperature, the lower the resistance. The 10K NTC we bought means **10KΩ at 25℃**, with a B value of 3950.

It also needs a divider to be measured — wire the NTC in series with a precision resistor:

```
 3.3V ──┬── NTC ──┬── 10K(fixed) ──┬── GND
        │         │                │
     (high)     ADC pin          (low)
```

First, invert the ADC voltage to recover the NTC resistance:

```
R_ntc = R_fixed × (3.3 / V_adc − 1)
```

Then convert resistance to temperature using the B-value formula from the datasheet:

```
T = 1 / ( 1/298.15 + (1/3950) × ln(R_ntc / 10000) )   unit: Kelvin
°C = T − 273.15
```

A formula with `ln` is fine on a PC, but in a product `logf()` is slow and eats Flash. **What products actually do is a 128-point lookup table + linear interpolation**: precompute the raw-to-temperature mapping and store it in Flash (a const array, so no RAM cost), then at runtime just look up the table and do one proportional interpolation — done in a few microseconds. This post uses the formula version first; in Part 18, when we tally up the resource budget, you'll see the value of the table version.

### 2.4 Production-Grade Trick: Power Only While Measuring

A divider circuit has a hidden cost: **as long as the battery is connected, the divider resistors keep sipping current** (3.3V / 3.27MΩ ≈ 1µA — looks tiny, but multiply by 24 hours and by battery capacity, and the bill comes due).

The product's solution is delightfully clever: **the bottom of the divider doesn't go straight to ground — it goes to a GPIO**. You might think this GPIO normally outputs low... no, the even slicker wiring is: the divider is strung between the battery and a GPIO. **Normally the GPIO outputs low, shorting the whole circuit out so it draws nothing; to measure, the GPIO switches to input (high impedance) or outputs high, and only then does the circuit get power.** Cut the power the moment the measurement is done.

In the product, the NTC path is "PA7 enable → PA6 sample", and the battery path is "PB1 enable → PB0 sample". Power on for a second, grab a few samples, zero current the rest of the time. This learning version simplifies things (always powered), but know that in real products this power-saving trick genuinely exists.

## 3. Hands-On: Writing the Code

### Step 1: Wiring (Two Channels)

**Fake battery** (the learning version uses the USB 5V as the "voltage to be measured"):

```
USB 5V ── 100K ──┬── 100K ── GND
                 │
                PA0 (ADC_IN0)
```

Divider ratio 1/2, so 5V → about 2.5V on PA0. Safe.

**NTC**:

```
3.3V ── NTC ──┬── 10K ── GND
              │
             PA1 (ADC_IN1)
```

Mind the direction: **NTC on top, fixed resistor on the bottom** — why harp on the direction? See the bonus section.

### Step 2: ADC Configuration and Reading (Bare-Register Version)

```c
#include "stm32f103xb.h"
#include <math.h>

static void adc_init(void)
{
    RCC->APB2ENR |= RCC_APB2ENR_ADC1EN | RCC_APB2ENR_IOPAEN;

    GPIOA->CRL &= ~((0xF << 0) | (0xF << 4));   // PA0/PA1 模拟输入 CNF=00 MODE=00

    ADC1->SMPR2 |= (0x7 << 0) | (0x7 << 3);     // 通道0/1 采样时间 239.5 周期
                                                // （高内阻源要慢采样，NTC 分压阻抗高，必须慢）

    ADC1->CR2 |= ADC_CR2_ADON;                  // 上电
    ADC1->CR2 |= ADC_CR2_CAL;                   // 启动自校准
    while (ADC1->CR2 & ADC_CR2_CAL) { }         // 等校准完成（别跳过，首次读数会漂）
}

static uint16_t adc_read(uint8_t channel)       // channel: 0=PA0 1=PA1
{
    ADC1->SQR3 = channel;                       // 规则组第 1 个转换 = 该通道
    ADC1->CR2 |= ADC_CR2_SWSTART;               // 软件触发开始转换
    while ((ADC1->SR & ADC_SR_EOC) == 0) { }    // 等转换完成
    return (uint16_t)ADC1->DR;                  // 读 DR 自动清 EOC 标志
}
```

One detail worth hammering home: **reading DR clears the EOC flag** — that's a hardware convention. Remember it: the Part 0 bonus incident where "the debugger's Live Watch killed the ADC" happened precisely because the debugger read DR on your behalf and cleared the flag, leaving the firmware dead-waiting right here.

### Step 3: Two Measurement Functions

```c
#define DIV_R_UPPER_KOHM   100.0f     // 分压上电阻（kΩ）
#define DIV_R_LOWER_KOHM   100.0f     // 分压下电阻
#define NTC_R_FIXED_OHM    10000.0f   // NTC 分压固定电阻
#define NTC_B_VALUE        3950.0f
#define NTC_R25_OHM        10000.0f

/* 模拟电池电压，单位 mV */
static uint32_t read_vbat_mv(void)
{
    uint16_t raw = adc_read(0);
    float v_adc = raw * 3300.0f / 4095.0f;
    return (uint32_t)(v_adc * (DIV_R_UPPER_KOHM + DIV_R_LOWER_KOHM)
                            / DIV_R_LOWER_KOHM);
}

/* NTC 温度，单位 0.1℃ */
static int16_t read_ntc_temp_x10(void)
{
    uint16_t raw = adc_read(1);
    if (raw < 2 || raw > 4093) return -999;     // 开路/短路保护（伏笔，见下文）

    float v_adc  = raw * 3.3f / 4095.0f;
    float r_ntc  = NTC_R_FIXED_OHM * (3.3f / v_adc - 1.0f);

    float t_k = 1.0f / (1.0f / 298.15f + (1.0f / NTC_B_VALUE)
                        * logf(r_ntc / NTC_R25_OHM));
    return (int16_t)((t_k - 273.15f) * 10.0f);
}
```

The main loop reads both channels every 2 seconds and prints:

```
vbat=4968mV  ntc=25.4C
vbat=4968mV  ntc=26.1C   ← 手指捏住 NTC，温度上升
```

Fingers are the officially designated heater for NTC experiments: free, a constant ~33℃ or so, and endlessly reusable.

## 4. Flash and Acceptance

- [ ] The printed `vbat` falls between 4900~5000 mV (USB 5V goes through the divider and gets reconstructed; a 1%~2% resistor tolerance error is perfectly normal);
- [ ] At room temperature the `ntc` reading is sensible (in the 20~30℃ ballpark; landing within 2℃ of a reference thermometer counts as excellent);
- [ ] Pinch the NTC for 10 seconds and the reading climbs past 30℃; let go and it falls back — **note that it reacts slowly; that's a physical property of thermistors, not a bug**;
- [ ] (Troubleshooting drill) Swap the two NTC wires (exchange the positions of the NTC and the fixed resistor), and you'll see the temperature reading invert: the more you heat it, the lower it reads. Remember this phenomenon — the bonus section explains it right away.

## 5. The Original Product (CIU32F003)

The product's ADC module is structurally the same as this post's, with three production-grade upgrades:

1. **Enable-pin power saving**: as described above, the NTC divider is enabled by PA7 and the battery divider by PB1; the measurement flow is "enable → delay a few ms for the voltage to settle → take N consecutive samples and average → disable";
2. **Lookup table instead of a formula**: a 128-point const table of raw→temperature plus linear interpolation — zero floating-point at runtime;
3. **Piecewise-linear battery percentage mapping**: voltage-to-percentage is not linear (a battery discharge curve is steep in the middle and flat at both ends); the product folds the voltage into a 0~100% charge level with piecewise linear segments, and shows a low-battery icon on the LCD below 20%.

There's one more thing: the product discards the first batch of samples after power-up — ADC readings need a settling period right after power-on, and the first few samples are garbage. That's the hidden motivation behind "take N consecutive samples and average", beyond simple noise reduction.

## 6. Bonus: The Backwards Divider

In real development, the NTC was initially soldered in **exactly the opposite orientation** from what the calculation code assumed — physically, the NTC was on the lower arm and the fixed resistor on the upper arm.

This mistake is easy to catch during bring-up: blow hot air on the probe and the serial temperature drops, steadily; toss it in the fridge and the reading climbs. Completely inverted. The fix is one line: change the inversion formula from `3.3/V_adc − 1` to `V_adc/(3.3−V_adc)` (or the more thorough cure: swap the resistors back).

The lesson of this story isn't the formula — it's **always keep a "known truth" reference at hand during bring-up**: a finger (33℃), an ice-water mixture (0℃), a cup of boiling water (steam means ~100℃). When a sensor reading doesn't even agree with the truth in direction, suspect the hardware wiring first and the code second.

There's also a production-grade epilogue worth noting now: that open-circuit guard `raw < 2 || raw > 4093` really did save the day once — 9 days after mass production started, a user unplugged the NTC probe, the ADC read an open-circuit fake value, and the math spat out **-55℃**. That value not only falsely triggered a low-temperature alarm; worse, it fell outside the valid range the cloud protocol allowed for external temperature, so **the entire data frame was rejected by the cloud, and every other data point died with it**. The firmware was later upgraded: an out-of-range raw value is now judged as "probe detached" — display 0, don't report, don't participate in alarms. You'll meet this guard again in Part 17 on production testing.

## 7. Next Up

All senses are complete: temperature/humidity, battery, external temperature. But this product is supposed to run for a year on a battery — keep it wide awake at full speed like this and the battery dies in a month. Next is Part 5, "Put It to Sleep": the LPTIM low-power timer waking it up every 10 seconds, PMU Deepstop deep sleep, and one of the most famous traps in the whole series — **the clock changes after wakeup, and suddenly everything is wrong**. From that post on, we officially enter the world of "low power".

---

*This series is adapted from a real mass-production project; every war story comes from actual development. Reading in order is recommended — the parts build on each other.*
