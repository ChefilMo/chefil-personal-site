---
title: "Part 3: Bit-Banging I2C — Reading Temperature and Humidity with Two GPIOs"
description: "I2C timing dissected bit by bit: from open-drain-plus-pull-up electrical rules to bit-banging the whole bus with two plain GPIOs to read the GXHT40 sensor — the first genuinely hard part of the series."
pubDate: 2026-11-24
lang: en
translationKey: wifi-thermometer-part3
tags: [Embedded, STM32, Tutorial]
series: wifi-thermometer
seriesOrder: 3
---

> In the last post the MCU learned to talk (UART). This post gives it a "sense of touch": wire up the GXHT40 temperature/humidity sensor and **bit-bang the whole I2C bus with two plain GPIOs**, read the temperature and humidity, and print them to the computer.
> Warning: this is the first genuinely hard article of the series. I2C timing is a chain of interlocking steps — get any single bit wrong and the bus will die on you in protest. But once you've chewed through it, your understanding of "bus protocols" will surpass most people who have only ever used hardware I2C.

---

## 1. Goals and the Payoff

**Goal**: wire the GXHT40 on a breadboard, have the MCU read temperature and humidity every 2 seconds, and print over the serial port:

```
temp=25.3C  hum=52.1%
temp=25.4C  hum=52.3%   ← breathe on the sensor and watch the numbers climb
```

**What you'll understand afterwards**: the electrical rules of the I2C bus (why open-drain plus pull-ups), the three critical signals — START, STOP, and ACK — the full timing puzzle of one complete read transaction, and the complete technique for bit-banging a bus with GPIOs.

## 2. Ten Minutes of Theory

### 2.1 The Electrical Foundation of I2C: Open-Drain + Pull-Up

I2C has only two wires: **SCL (clock)** and **SDA (data)**. Its electrical rules are completely different from UART's:

- Each wire has a **pull-up resistor** to 3.3V;
- Every device (including the master) can only drive the line with an **open-drain output**: either pull it low, or "let go" (high-impedance, leaving the pull-up resistor to drag the line high).

This design yields a beautiful property — **wired-AND**: if any device pulls the line low, the whole line is low; only when everyone lets go is the line high. This means:

1. Multiple devices can share one line without short circuits (there's never a fight between one output pushing high and another pulling low);
2. A slave can even hold SCL hostage (clock stretching) and force the master to wait — an advanced hardware-I2C feature that this series won't use, but you should know it exists.

**The key trick for GPIO bit-banging hides right here**: once a pin is configured as open-drain output, writing 0 = actively pull low, writing 1 = let go and hand the line to the pull-up resistor. To read the bus level, first write 1 to let go, then read the pin's input register. The entire bit-banging process **never needs to switch pin direction** — a single "open-drain output" mode handles everything.

### 2.2 Three Signals: START, STOP, ACK

I2C timing looks intimidating, but there are really only three "special moves"; everything else is plain bit-by-bit transfer. Burn this diagram into your memory (the direction of the SDA edge while SCL is high is the soul of it):

```
START:                 STOP:
  SDA ──┐                 ┌── SDA
        │╲                │ ╱
        │ ╲  SCL high     │╱  SCL high
  SCL ──┴──╱──            ───╱──┴── SCL
     falling edge          rising edge

ACK (acknowledge): after the master sends 8 bits, on the 9th clock
  SCL ──┐ ╔═╗ ╔═╗ ╔═╗ ╔═╗ ╔═╗ ╔═╗ ╔═╗ ╔═╗ ╔═╗
        └═╩═╩═╩═╩═╩═╩═╩═╩═╩═╩═╩═╩═╩═╩═╩═╩═╩═┘
  SDA  ──b7──b6──b5──b4──b3──b2──b1──b0──ACK
                                            ↑
                                     slave pulls low = ACK (received)
                                     slave lets go   = NACK (not received)
```

- **START**: SCL high, SDA goes high → low;
- **STOP**: SCL high, SDA goes low → high;
- **ACK/NACK**: every 8 bits, the receiver controls SDA on the 9th clock — pulled low means acknowledged (ACK), let go means not acknowledged (NACK). When the master is reading data, it must reply NACK after the last byte to tell the slave "that's enough."

**The rule for bit-by-bit transfer**: SDA is allowed to change only while SCL is low; while SCL is high, SDA must be stable (the other side samples it right in that high window). So the code skeleton is always:

```
set/clear SDA → raise SCL (other side samples) → lower SCL → next bit
```

### 2.3 One Complete Read Transaction

The I2C address is 7 bits, followed immediately by 1 read/write flag bit: 0 = write, 1 = read. The GXHT40's address is `0x44` (some batches are `0x45` — when you can't get a read through, suspect this first).

The complete flow for one temperature/humidity read:

```
START
send [0x44<<1 | 0] = 0x88      ← address + write
wait for ACK
send 0xFD                       ← "start measurement" command
wait for ACK
STOP? No! Send START directly (repeated start)
send [0x44<<1 | 1] = 0x89      ← address + read
wait for ACK
read byte 1 (temp high 8 bits)     → reply ACK
read byte 2 (temp low 8 bits)      → reply ACK
read byte 3 (temp CRC)             → reply ACK
read byte 4 (humidity high 8 bits) → reply ACK
read byte 5 (humidity low 8 bits)  → reply ACK
read byte 6 (humidity CRC)         → reply NACK ← last byte!
STOP
```

After the measurement command is sent, the sensor needs about **10 ms** of internal conversion before the data is ready, so leave a 10 ms delay between "send command" and "read data". The raw-value conversion formulas (given in the datasheet):

```
Temperature = -45 + 175 × (t_raw / 65535)   unit: ℃
Humidity    =  -6 + 125 × (h_raw / 65535)   unit: %RH
```

Each data value is followed by a 1-byte CRC-8 check (polynomial 0x31, initial value 0xFF). You can skip the check while learning, but production firmware must verify it — for garbage data read from a noisy bus, the CRC is the last line of defense (Part 17, on production testing, will show its value).

## 3. Hands On: Writing the Code

### Step 1: Wiring

```
GXHT40 module      Blue Pill
  VCC   ────►  3.3V
  GND   ────►  GND
  SCL   ────►  PB6
  SDA   ────►  PB7
```

The module usually comes with 4.7K~10K pull-up resistors onboard. If you bought a bare sensor (a tiny black 4-pin block), add two 4.7K pull-up resistors to 3.3V yourself — both are non-negotiable.

### Step 2: The Bit-Banged I2C Core Code

```c
#include "stm32f103xb.h"

#define I2C_SCL_H   GPIOB->BSRR = GPIO_BSRR_BS6     // 写1=松手（开漏）
#define I2C_SCL_L   GPIOB->BSRR = GPIO_BSRR_BR6     // 写0=拉低
#define I2C_SDA_H   GPIOB->BSRR = GPIO_BSRR_BS7
#define I2C_SDA_L   GPIOB->BSRR = GPIO_BSRR_BR7
#define I2C_SDA_IN  ((GPIOB->IDR >> 7) & 1)         // 读 SDA 电平

static void i2c_init(void)
{
    RCC->APB2ENR |= RCC_APB2ENR_IOPBEN;
    // PB6/PB7 开漏输出 2MHz：CNF=01, MODE=10 → 0x6
    GPIOB->CRL &= ~((0xF << 24) | (0xF << 28));
    GPIOB->CRL |=  ((0x6 << 24) | (0x6 << 28));
    I2C_SCL_H; I2C_SDA_H;                        // 初始都松手，总线空闲为高
}

static void i2c_delay(void)                      // 半周期 5us → 100kHz
{                                                // （8MHz 主频下 SysTick 数 40 拍）
    SysTick->LOAD = 40 - 1; SysTick->VAL = 0;
    SysTick->CTRL = 5;
    while ((SysTick->CTRL & SysTick_CTRL_COUNTFLAG_Msk) == 0) { }
    SysTick->CTRL = 0;
}

static void i2c_start(void)
{
    I2C_SDA_H; I2C_SCL_H; i2c_delay();
    I2C_SDA_L; i2c_delay();                      // SCL高时 SDA 下降沿
    I2C_SCL_L; i2c_delay();
}

static void i2c_stop(void)
{
    I2C_SDA_L; i2c_delay();
    I2C_SCL_H; i2c_delay();                      // 先拉高 SCL
    I2C_SDA_H; i2c_delay();                      // 再释放 SDA → STOP
}

/* 发 1 字节，返回 0=收到ACK, 1=收到NACK */
static int i2c_write_byte(uint8_t data)
{
    for (int i = 7; i >= 0; i--) {               // MSB 先行
        if (data & (1 << i)) I2C_SDA_H; else I2C_SDA_L;
        i2c_delay();
        I2C_SCL_H; i2c_delay();                  // 高电平窗口对方采样
        I2C_SCL_L; i2c_delay();
    }
    I2C_SDA_H;                                   // 释放 SDA，交出第 9 拍控制权
    i2c_delay();
    I2C_SCL_H; i2c_delay();
    int nack = I2C_SDA_IN;                       // 采样 ACK
    I2C_SCL_L; i2c_delay();
    return nack;
}

/* 读 1 字节，ack=1 回ACK(还要读), ack=0 回NACK(读完了) */
static uint8_t i2c_read_byte(int ack)
{
    uint8_t data = 0;
    I2C_SDA_H;                                   // 松手，让从机驱动 SDA
    for (int i = 7; i >= 0; i--) {
        i2c_delay();
        I2C_SCL_H; i2c_delay();
        data |= (uint8_t)(I2C_SDA_IN << i);      // 高电平窗口采样
        I2C_SCL_L;
    }
    if (ack) I2C_SDA_L; else I2C_SDA_H;          // 第 9 拍：我们当接收方，回 ACK/NACK
    i2c_delay();
    I2C_SCL_H; i2c_delay();
    I2C_SCL_L; i2c_delay();
    I2C_SDA_H;
    return data;
}
```

### Step 3: Reading the GXHT40

```c
#define GXHT40_ADDR   0x44
#define CMD_MEASURE   0xFD

static int gxht40_read(int16_t *temp_x10, int16_t *hum_x10)
{
    uint8_t t_msb, t_lsb, h_msb, h_lsb;

    i2c_start();
    if (i2c_write_byte((GXHT40_ADDR << 1) | 0)) goto fail;   // 地址+写
    if (i2c_write_byte(CMD_MEASURE))             goto fail;   // 测量命令
    i2c_stop();

    delay_ms(10);                                // 等传感器换算

    i2c_start();
    if (i2c_write_byte((GXHT40_ADDR << 1) | 1))  goto fail;   // 地址+读
    t_msb = i2c_read_byte(1);                    // 温度高8位，ACK
    t_lsb = i2c_read_byte(1);                    // 温度低8位，ACK
    (void)i2c_read_byte(1);                      // 温度CRC，先不校验
    h_msb = i2c_read_byte(1);                    // 湿度高8位，ACK
    h_lsb = i2c_read_byte(1);                    // 湿度低8位，ACK
    (void)i2c_read_byte(0);                      // 湿度CRC，NACK 收尾
    i2c_stop();

    uint32_t t_raw = ((uint32_t)t_msb << 8) | t_lsb;
    uint32_t h_raw = ((uint32_t)h_msb << 8) | h_lsb;
    *temp_x10 = (int16_t)(((-45 + 175.0 * t_raw / 65535) + 0.05) * 10);
    *hum_x10  = (int16_t)(((- 6 + 125.0 * h_raw / 65535) + 0.05) * 10);
    return 0;
fail:
    i2c_stop();
    return -1;
}
```

Call it once every 2 seconds from the main loop, and print using the `uart_puts` from Part 2 together with a simple integer-to-string routine (`*_x10` is "an integer scaled up 10×": 25.3℃ is stored as 253 — no floating point, which is also standard practice in production firmware).

## 4. Flashing, Acceptance, and the Cheat-Code Moment

- [ ] After power-on, the serial port prints one temperature/humidity line every 2 seconds, with sensible values (room-temperature magnitude);
- [ ] Breathe on the sensor and watch humidity spike above 70% within 2 seconds — the sensor is alive;
- [ ] **Cheat-code moment**: connect the logic analyzer's CH0 to SCL and CH1 to SDA, set the sample rate to 1MHz, and set the decoder to I2C in PulseView. You'll see crisp waveforms on the screen: START, the address byte `0x88`, the ACK notch, `0xFD`, the repeated START, `0x89`, 6 data bytes, and finally the NACK and STOP. **Software code and hardware waveforms line up before your eyes for the first time** — that instant alone is worth the logic analyzer's twenty-five yuan;
- [ ] (Troubleshooting drill) Unplug the SDA jumper wire and plug it back in — most likely `gxht40_read` will return failure. Watch closely how the ACK detection saves your life.

**The three-step routine when nothing prints** (in order): use a multimeter to check that SDA/SCL are both pulled up to 3.3V when idle → check the logic analyzer for any START waveform → check whether the ACK bit of the address byte is low (a NACK means the address is wrong — suspect the 0x45 variant).

## 5. The Original Product (CIU32F003)

The product's situation is harder-core than the learning build: **the CIU32F003's I2C hardware only supports slave mode**. To act as a master and read the sensor, bit-banging I2C isn't "for learning" — it's the only way out. The product runs two independent bit-banged I2C buses: the sensor on PB3/PB4, the LCD on PA1/PA0, with master/slave addresses, speed (100 kHz), and timeout macros all centralized in the board-level config header.

Another difference: the product's bit-banged implementation takes the "**SDA direction switching**" route (push-pull output when transmitting, switching to input when receiving/releasing), rather than the open-drain route used in this post. Both routes are legitimate: the open-drain route has simpler code; the direction-switching route is more robust on chips whose pin drive is weak. But direction switching has one fatal timing window — saved for the Bonus section.

## 6. Bonus: An SDA Held Hostage

During product bring-up there was once a "sudden bus death": after power-on the first sensor read was fine, but at some point afterwards **all I2C operations timed out and failed**, software reset didn't help, and only a power cycle could recover it.

One multimeter measurement later: SDA was clamped hard at low level. Who was pulling it? Following the trail: the sensor. Why would it do that? Look at the timing — right after the master finishes reading the last byte and has just sent the NACK, **the sensor is still immersed in the state of "I need to put the next data bit on the line at the next clock"**, actively driving SDA low. If at this moment the master's software has already rushed to switch SDA back to push-pull output and is eager to drive a high level... the master outputs high, the slave outputs low, and they fight head-on. On STM32-class IOs the push-pull drive usually wins over the sensor, so it looks fine; but the CIU32F003's IO drive is weak, it loses this round, the timing goes haywire, and the sensor thinks the transaction never ended — it keeps gripping SDA and won't let go. Bus locked.

The fix: strictly gate the moment SDA is switched back to output direction to only after the STOP condition has been fully sent, and add to the bus initialization an unlock sequence of "if SDA is clamped low, manually clock out 9 pulses to help the slave exit its send state" (a standard first-aid technique of the I2C protocol, worth copying into your toolbox).

Two lessons:

1. **When multiple masters share one line, "when to let go and when to take over" is the core of timing design** — being off by half a clock is an accident waiting to happen;
2. When the bus locks up, don't only know how to cycle the power — the software unlock of "clock 9 pulses + send STOP" is a life-saving skill for every I2C practitioner.

## 7. Next Up

Temperature and humidity are read, but a battery-powered product must also know how much charge it has left and what the external probe's temperature is — both are "analog voltage" problems. Next up, Part 4: "ADC: Measuring the Battery and NTC Temperature": the principles of analog-to-digital conversion, resistor dividers, and the lookup-table-plus-interpolation algorithm that appears in every piece of NTC code. Once that's done, the product's entire "sensory capability" is complete.

---

*This series is adapted from a real mass-production project; every pitfall recorded here comes from real development. Reading in order is recommended, as the parts depend on each other.*
