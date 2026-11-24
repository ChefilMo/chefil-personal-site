---
title: "Part 13: Segment LCD — VRAM, Driver Porting, and the “Address Placeholder” Setup Pays Off"
description: "The learning build drives an I2C 1602 to stand in for the product's segment LCD (VKL076): the VRAM model, the discipline of porting an unfamiliar driver chip, and the payoff of the “address placeholder” — both buses ride the bit-banged I2C."
pubDate: 2026-11-24
lang: en
translationKey: wifi-thermometer-part13
tags: [Embedded, STM32, Tutorial]
series: wifi-thermometer
seriesOrder: 13
category: embedded
---

> The data can be stored, reported, and slept on — but the user can't read temperature and humidity off a serial port. A product needs a face. This part builds the display: the product uses a segment LCD (the kind of screen that feels like a digital watch), while the learning build substitutes the I2C 1602 bought in Part 0.
> The driver chips are completely different, but one thread soldered them together: **both hang off the bit-banged I2C** — the bus craftsmanship hand-rolled in Part 3 makes its second appearance here.

---

## 1. Goals and Results

**Goal**: Drive the 1602 on the learning build, show temperature and humidity on it, and hook it into the main loop from Part 7 — refreshing the screen after every sample on wakeup.

**What you'll understand afterwards**: the working model of an LCD driver chip (the MCU only touches VRAM), the full process of porting an unfamiliar driver chip, and how many traps hide inside the words "reference driver".

## 2. Theory in 10 Minutes

### 2.1 Segment LCD vs. Character LCD: What the Product Chose and Why

LCD screens come in two major schools:

**Segment LCD**: Every stroke segment on the screen is an independent electrode (a digit "8" consists of 7 segments, plus custom segments like the temperature symbol and battery icon), and the driver chip (the product uses VKL076) generates the AC drive waveform the liquid crystal needs. The MCU's job is compressed to the bare minimum: **write a bitmap into VRAM over I2C** — set the bit corresponding to any segment that should light up, and the driver chip automatically translates VRAM into segments on the screen.

**Character LCD (1602)**: The screen has a built-in dot-matrix font; send it a character code and it displays the character. The learning build's 1602 adds one more layer: behind the screen is an HD44780 controller, and the I2C adapter board (PCF8574) merely "folds" an 8-bit parallel port into an I2C interface — every I2C write is, at its essence, simulating one parallel-port operation.

The product's reason for choosing a segment LCD is very much a product reason: **power consumption**. Segment LCD drive current is measured in microamps, and the UI the product needs is extremely simple (a few digits plus a few icons) — the segment LCD's "icon-as-segment" nature fits perfectly. As for the 1602's dot-matrix backlight, the backlight alone would blow this product's battery budget.

### 2.2 The VRAM Model: The Common Language of All LCD Drivers

Segment or dot-matrix, the core abstraction of every driver chip is **VRAM**: a block of memory that maps one-to-one onto the screen's physical structure. Your entire job boils down to two things:

1. Initialize the chip (tell it the screen's parameters and turn the driver on);
2. Change bits in VRAM to make the screen change.

So the layering of "LCD display" in the product stays remarkably clean: the upper layer says "show 25.3 °C", and the lower layer looks the number up in a "segment table" (which segments make up each digit), translates it into bits, and writes them into VRAM. **Business code never touches VRAM** — this isolation lets the buttons of Part 14 and the state machine of Part 7 call `app_display_show_value()` directly without caring about screen details.

### 2.3 The Liquid Crystal's Quirk: AC Drive

While we're at it, a bit of trivia unique to segment LCDs: **a liquid crystal must never see a DC voltage** — DC electrolyzes and ages the liquid crystal material. So what the driver chip outputs is an AC waveform whose polarity flips constantly (which also explains why a segment that looks "steadily on" is actually alternating between positive and negative on its electrodes). You won't use this knowledge often, but when you see a driver chip with a pile of bias/boost configuration items, you'll know they're all in service of this physical property.

## 3. Hands-On Code (Learning Build: 1602 @ Bit-Banged I2C)

### Step 1: Wiring and Protocol Orientation

The 1602 module has 4 wires: VCC, GND, SDA→PB7, SCL→PB6 — sharing the same bit-banged I2C bus as the GXHT40 from Part 3! That's the beauty of a bus protocol: multiple devices can hang on one line (different addresses, no interference). The module address is usually `0x27` (also seen as `0x3F`; there are solder pads on the back to change it).

Meaning of the PCF8574 adapter's 8-bit parallel port:

```
bit0=RS  bit1=RW  bit2=EN  bit3=backlight  bit4~7=upper data nibble (HD44780 in 4-bit mode)
```

RS=0 is a command, RS=1 is data; EN needs a "high pulse" to latch (unrelated to the I2C ACK — it's a leftover of the HD44780 parallel-port timing).

### Step 2: The Driver Code

```c
#define LCD_ADDR    0x27
#define LCD_BL      0x08
#define LCD_EN      0x04
#define LCD_RS      0x01

static void lcd_pulse(uint8_t val)          // EN 高脉冲锁存
{
    i2c_start();
    i2c_write_byte((LCD_ADDR << 1) | 0);    // 地址+写（第 3 篇的函数原样用）
    i2c_write_byte(val | LCD_EN | LCD_BL);
    i2c_stop();
    i2c_start();
    i2c_write_byte((LCD_ADDR << 1) | 0);
    i2c_write_byte(val | LCD_BL);           // EN 拉低
    i2c_stop();
    delay_ms(1);
}

static void lcd_write_nibbles(uint8_t data, uint8_t rs)
{
    lcd_pulse((data & 0xF0) | rs);          // 高 4 位
    lcd_pulse((data << 4) | rs);            // 低 4 位
}

static void lcd_cmd(uint8_t c)  { lcd_write_nibbles(c, 0); }
static void lcd_data(uint8_t d) { lcd_write_nibbles(d, 1); }

static void lcd_init(void)
{
    delay_ms(50);
    lcd_pulse(0x30); delay_ms(5);           // HD44780 规定的上电唤醒序列
    lcd_pulse(0x30); delay_ms(5);           // （4位模式下也要先发 3 次 8 位命令，
    lcd_pulse(0x30); delay_ms(1);           //  别问为什么，datasheet 就这么写）
    lcd_pulse(0x20); delay_ms(1);           // 切 4 位模式
    lcd_cmd(0x28);                          // 2行×16列，4位数据
    lcd_cmd(0x0C);                          // 显示开，光标关
    lcd_cmd(0x06);                          // 写入后光标右移
    lcd_cmd(0x01);  delay_ms(2);            // 清屏
}

static void lcd_set_cursor(uint8_t row, uint8_t col)
{
    lcd_cmd(0x80 | (row ? 0x40 : 0) | col);
}

static void lcd_print(const char *s)
{
    while (*s) lcd_data(*s++);
}
```

### Step 3: Hooking It Into the Main Loop

In the WAKEUP state from Part 7, after `app_do_measurement()`, add:

```c
char line[17];
/* 第一行：温度 */
lcd_set_cursor(0, 0);
sprintf-like 手工填充 → "T:25.3C   ";
lcd_print(line);
/* 第二行：湿度 + 电量 */
lcd_set_cursor(1, 0);
lcd_print(line2);   // "H:52% BAT:80%"
```

The 1602 has no ℃ symbol, so write "C" (the product has a custom ℃ segment — that's exactly where the segment LCD's custom-icon advantage lies). The refresh rate follows the LPTIM period — once every 10 seconds, plenty for the human eye; that rhythm was set back in Part 7.

## 4. Flash and Acceptance

- [ ] After power-on, the first line shows temperature and the second shows humidity + (simulated) battery level, matching the serial output;
- [ ] Breathe on the sensor, and the humidity on screen updates within 10 seconds (following the wakeup period);
- [ ] Capture the LCD's I2C frames with a logic analyzer: you can see the address byte `0x27<<1` and the GXHT40's `0x88` alternating on the same bus — **one bus, two slaves**, and the "bus" concept planted in Part 3 fully pays off;
- [ ] (Troubleshooting drill) Screen fully dark/fully blank with no characters at all: nine times out of ten the address is wrong (try `0x3F` instead of `0x27`); scan the bus with the ACK-detection method from Part 3 to confirm which address answers.

## 5. The Original Product (CIU32F003 + VKL076)

The product drives a VKL076 segment LCD; both capabilities from this part have counterparts there, in different forms:

1. **A second, independent bit-banged I2C**. The LCD uses PA1/PA0, completely separate from the sensor's PB3/PB4 — the two buses never hold each other back, and the sensor stays available while the LCD initializes. **The biggest advantage of bit-banged I2C cashes in right here: you can have as many buses as you want, copied in pure software**;
2. **VRAM = segment mapping table**. In the VKL076, every bit of VRAM corresponds to one physical segment on the screen. The product's display module maintains a "segment table": which segments make up each digit 0–9, which bits the ℃ symbol occupies, which bits each bar of the Wi-Fi signal occupies — the application layer reports a number, the lower layer looks it up and writes the bits;
3. **Switching temperature units is "swapping a table"**. When the user switches from ℃ to ℉ in the app, the display layer converts the value, then updates the VRAM bits for the decimal point segment and the ℉ segment together — one flag at the top, one table lookup at the bottom;
4. **Icons are a big part of the product experience**. Lighting the low-battery icon below 20%, the Wi-Fi signal bars, the alert bell... these "little things" make up the entirety of the user's sense of quality. A segment LCD makes every icon a free "pixel";
5. **Arrange standby before entering Deepstop**. The screen driver chip has a low-power standby mode: before entering Deepstop, put the VKL076 to sleep (VRAM retained, drive oscillator stopped) and wake it back up afterwards — the screen content keeps displaying during sleep while power consumption drops another notch. This is one more item on the "bedtime checklist" (Part 5).

## 6. Bonus: That Placeholder in the Config Is Finally Fixed

Remember the config from Part 2, when the framework landed? The LCD address was written as:

```c
#define VKL076_ADDR    0x3C    /* 占位：拿到 VKL076 datasheet 后修正 */
```

The datasheet hadn't arrived at the time, so I honestly wrote "placeholder" instead of making something up. Later, once the document was in hand, I checked — **the real address is 0x3E**. Off by two bits, and the consequence is a permanent NACK on the I2C and a screen that never initializes, ever.

Now this setup can be fully explained, because behind it lies a porting methodology: **the four "assume-it's-fine" killers of driver chips** — assuming the address, assuming the init sequence, assuming the VRAM mapping, assuming the electrical parameters. The troubleshooting cost of each starts at "half a day": wrong address, and the bus stays silent; wrong init sequence, and the screen is fully white or fully black; wrong VRAM mapping, and digits show up as stroke-missing gibberish (when the segment order in your table doesn't match the actual screen, you can even "display" symbols that don't exist in any dictionary).

So the discipline for porting an unfamiliar driver chip is: **every number in the datasheet is first-hand material; the reference driver is second-hand; your memory is worth nothing**. Check the init sequence line by line against the document, validate the VRAM mapping with an "all-segments-on test" (light up every segment once and eyeball it against the real thing), and confirm the address with an ACK scan. Only after these three axes are done do you get to write business code.

The product even kept this action in production testing: in factory-test mode, a short press of the button makes the screen **display every segment for 5 seconds**, so the line can visually check for missing segments — VRAM-mapping validation continues from the development phase all the way onto the production line (covered in Part 17, the factory-test part).

## 7. Next Part Preview

The screen is here, but the product is still missing a hand: how does the user interact with it? Next, Part 14, "Buttons and Gestures": debouncing, single click, double click, multi-click, long-press-5-seconds for provisioning, five-click OTA — and how pressing a button inside Deepstop wakes the device from its dreams. The "button EXTI wakeup" setup planted in Part 7 is officially paid off.

---

*This series is adapted from a real mass-production project; every pitfall recorded here comes from real development. Reading in order is recommended, as the parts depend on each other.*
