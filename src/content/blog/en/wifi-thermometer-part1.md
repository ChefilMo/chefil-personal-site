---
title: "Part 1: Blink Your First LED — Clocks, GPIO, and the Invisible Memory Budget"
description: "From reset vector to clock tree: configure GPIO to blink the onboard LED — and find out why this real product has a 1 KB stack and a 0-byte heap."
pubDate: 2026-11-24
lang: en
translationKey: wifi-thermometer-part1
tags: [Embedded, STM32, Tutorial]
category: embedded
series: wifi-thermometer
seriesOrder: 1
---

> In the previous post we set up the toolchain and got Keil to recognize the chip. Now we write our first line of code: make the onboard LED blink.
> Sounds simple? The blink code really is only a dozen lines, but this post covers three things properly: **what the chip does between power-on and executing main(), why the clock decides everything, and what's behind this product's "1 KB stack, 0-byte heap"**.

---

## 1. Goal and Result of This Post

**Goal**: Make the onboard LED (PC13) on the Blue Pill blink at 1 second on, 1 second off.

**What you'll understand afterwards**: the reset vector and stack pointer, RCC clock gating, GPIO operating modes, SysTick delays, and those two numbers in the startup file that decide your memory fate.

## 2. The Theory in 10 Minutes

### 2.1 From Power-On to main(), the Chip Secretly Does Three Things

The `main()` you write is not the first line of the program. After the chip resets, the hardware follows fixed rules and executes three steps:

1. **Read the stack-top address from Flash address 0x00000000** and load it into the SP register (stack pointer);
2. **Read the address of the reset handler from address 0x00000004** and jump there to execute;
3. The reset handler (in the startup file `startup_stm32f103xb.s`) does initialization: copies data, zeroes the BSS, and finally calls your familiar `main()`.

Note step one: **the stack-top address is "stored at the very beginning of the program"**. This leads to an important fact — **the stack size is hard-coded in the startup file**. Take a look at the startup file in your project:

```asm
Stack_Size      EQU     0x00000400      ; 1 KB
Heap_Size       EQU     0x00000200      ; 512 B
```

`EQU` is simply "define constant" in assembly. Remember these two numbers — we'll settle the account at the end of this post.

### 2.2 The Clock: The MCU's Heartbeat, and It Can Shift Gears

After power-on, the STM32F103 defaults to the internal high-speed clock HSI (8 MHz). To run faster, you switch the clock source: the external crystal HSE (8 MHz) goes through the PLL multiplier up to 72 MHz. The relationship looks like this:

```
HSI 8MHz ──┐
           ├─→ SYSCLK (system clock) ──→ divider ──→ core/HCLK/peripheral clocks
HSE 8MHz ──┘
              └── PLL ×9 ──→ 72MHz
```

Our CIU32F003 product follows the same idea: it powers up at RCH/6 = 8 MHz by default, and switches to RCH 48 MHz during initialization.

**Why does the product insist on 48 MHz?** Because later on it needs to bit-bang I2C in software and run a protocol stack, and 8 MHz struggles a bit; but there's no need to go to 100 MHz either — power consumption and cost would both go up. Clock selection for small-resource products is always a careful "just enough" calculation.

In this post we first blink the LED at 8 MHz, then switch the clock to 72 MHz and blink it again — **you will see with your own eyes that the delay slows down by 9x**, and thus understand the iron rule that "SysTick delays are married to the clock."

### 2.3 GPIO: It's Not "Just Wire It Up and It Works"

PC13 connects to the LED. To make this pin output high and low levels, you must first answer three questions:

**Question one: Is this pin's clock enabled?**

On the STM32, all peripheral clocks are off by default (a power-saving design). Before using GPIOC, you must first open its clock gate:

```c
RCC->APB2ENR |= RCC_APB2ENR_IOPCEN;   // 使能 GPIOC 时钟
```

`RCC->APB2ENR` is a 32-bit register, and bit 4 is GPIOC's switch. `|=` sets that one bit to 1 while leaving the rest untouched — the ancestral technique of register manipulation.

**Question two: What mode is the pin configured as?**

Each GPIO pin has two 4-bit control fields (8 modes in total). What we want is **push-pull output**: it can actively drive high and actively pull low, more than enough to drive an LED. PC13 belongs to the upper 8 bits of GPIOC, so its configuration lands in the `CRH` register:

```c
GPIOC->CRH &= ~(0xF << 20);   // 先清掉 PC13 的 4 个控制位
GPIOC->CRH |=  (0x2 << 20);   // CNF=00(推挽) MODE=10(2MHz输出)
```

**Question three: How do you change the pin level?**

Two choices: `ODR` (output data register, read/write the whole port) and `BSRR` (bit set/reset register, write-only). **Always prefer BSRR** — it's an atomic operation: set 1 and it's 1, clear 0 and it's 0, no fighting with operations on other bits:

```c
GPIOC->BSRR = GPIO_BSRR_BS13;   // PC13 = 1（置位）
GPIOC->BSRR = GPIO_BSRR_BR13;   // PC13 = 0（复位）
```

### 2.4 SysTick: An Alarm Clock Built Into the Core

How do you implement a delay? The STM32 core has a built-in 24-bit down-counter called SysTick: load an initial value and it decrements once per clock cycle, setting a flag when it hits zero. Load 8000 with an 8 MHz clock, and that's 1 millisecond:

```c
SysTick->LOAD = 8000 - 1;        // 8000 个 8MHz 周期 = 1ms
SysTick->VAL  = 0;               // 清当前值
SysTick->CTRL = SysTick_CTRL_CLKSOURCE_Msk | SysTick_CTRL_ENABLE_Msk;
while ((SysTick->CTRL & SysTick_CTRL_COUNTFLAG_Msk) == 0) { }
```

**Key point**: what you load into LOAD depends entirely on the current clock frequency. Change the clock from 8 MHz to 72 MHz, and the same 8000 only corresponds to 1/9 ms — this is the "delay slows down 9x" I warned about earlier.

## 3. Hands-On Coding

### Version 1: 8 MHz, Blink

`main.c`:

```c
#include "stm32f103xb.h"

static void delay_ms(uint32_t ms)
{
    SysTick->LOAD = 8000 - 1;                    // 8MHz: 8000 拍 = 1ms
    for (uint32_t i = 0; i < ms; i++) {
        SysTick->VAL  = 0;
        SysTick->CTRL = SysTick_CTRL_CLKSOURCE_Msk
                      | SysTick_CTRL_ENABLE_Msk;
        while ((SysTick->CTRL & SysTick_CTRL_COUNTFLAG_Msk) == 0) { }
        SysTick->CTRL = 0;
    }
}

int main(void)
{
    RCC->APB2ENR |= RCC_APB2ENR_IOPCEN;          // 开 GPIOC 时钟

    GPIOC->CRH &= ~(0xF << 20);                  // PC13 推挽输出 2MHz
    GPIOC->CRH |=  (0x2 << 20);

    while (1) {
        GPIOC->BSRR = GPIO_BSRR_BS13;            // 亮（蓝色药丸 LED 低电平点亮，
        delay_ms(500);                           //  所以这里亮灭可能反着，正常）
        GPIOC->BSRR = GPIO_BSRR_BR13;            // 灭
        delay_ms(500);
    }
}
```

Compile, download (using the ST-Link setup from the previous post), and observe the result.

**A foreshadowed "trap"**: the Blue Pill's onboard LED is lit by a low level. If your LED blinks "backwards" (off at BS13), the code isn't wrong — that's just how the hardware is wired. Measure the voltage of PC13 against ground with a multimeter and you'll see. In embedded work, **whether code is "right" often has to be checked against the schematic**.

### Version 2: Switch the Clock to 72 MHz

Add this at the beginning of `main()`:

```c
RCC->CR |= RCC_CR_HSEON;                        // 1. 开外部晶振
while ((RCC->CR & RCC_CR_HSERDY) == 0) { }      // 2. 等它稳定

FLASH->ACR |= FLASH_ACR_LATENCY_2;              // 3. Flash 加等待周期
                                                //    (72MHz 时 Flash 跟不上，要先说好)

RCC->CFGR |= RCC_CFGR_PLLSRC |                  // 4. PLL 源选 HSE
             (7 << RCC_CFGR_PLLMULL_Pos);       //    8MHz × 9 = 72MHz
RCC->CR |= RCC_CR_PLLON;                        // 5. 开 PLL
while ((RCC->CR & RCC_CR_PLLRDY) == 0) { }      // 6. 等 PLL 稳定

RCC->CFGR |= RCC_CFGR_SW_PLL;                   // 7. 系统时钟切到 PLL
while ((RCC->CFGR & RCC_CFGR_SWS_PLL) == 0) { } // 8. 确认切换成功
```

**Watch out**: that `8000` in the delay function is still there! Now the clock is 72 MHz, so 8000 cycles is only about 0.11 ms, and the LED will flash at a frequency the naked eye can't distinguish (it will just look constantly, slightly dim).

Change `8000` to `72000` and the blinking returns to normal.

**This little accident is the most important lesson of this post**: clock configuration is global state, and SysTick, UART baud rates, and timers all depend on it. In real projects it ends up managed across multiple files — which brings us right to the bonus below.

## 4. Flash and Acceptance Check

- [ ] After downloading version 1: the LED blinks at about 1 Hz;
- [ ] After adding the clock switch without changing the delay: the LED looks almost constantly lit (9x faster);
- [ ] After changing `8000` to `72000`: 1 Hz blinking is restored.

If you see all three phenomena, the core knowledge chain of this post (reset → clock → GPIO → SysTick) has truly clicked for you.

## 5. The Original Product (CIU32F003)

The product code uses the HDSC standard library (`std_`-prefixed APIs, in a style similar to the STM32 HAL/LL), and the clock configuration looks like this:

```c
std_rcc_rch_config(STD_RCC_RCH_FREQ_48M);   // RCH 切 48MHz
std_delay_init();                           // 必须在时钟配好之后调用延时初始化
```

Two differences worth remembering:

1. The CIU32F003's delay function `std_delayms()` is based on SysTick, but internally relies on a global variable recording the current system frequency — **so you must configure the clock first and then call `std_delay_init()`**; get the order wrong and every delay is off;
2. Its startup file has `Stack_Mem EQU 0x400` (1 KB) and `Heap_Size EQU 0x0` (0-byte heap) — the product simply chopped the heap off. Why? See the bonus section below.

## 6. Bonus: The 0-Byte Heap and the "Two Clock Macros" Trap

### 6.1 Why Is the Product's Heap 0 Bytes?

The stack and the heap are RAM's two big consumers. The stack handles function calls and local variables, and the compiler accounts for it automatically; the heap handles `malloc`, and the programmer accounts for it manually. The product has only 3 KB of SRAM in total. Look at the finished `.map` file: stack 1 KB, and once the global variables and protocol buffers are laid out, **there's simply no room left for a heap**.

So just set `Heap_Size EQU 0x0` — let the linker throw a link error as soon as someone calls malloc, **strangling memory overruns at compile time instead of leaving them to mysteriously crash at runtime**.

A small tip for beginners: during the learning phase you can keep the heap (the default 512 B does no harm), but keep this string in your mind — every time you write a big global array, go check the `Image component sizes` section of the `.map` file and see how much RW/ZI grew. Building this habit from day one is ten thousand times better than hunting memory overflows late at night later.

### 6.2 One Clock, Defined in Two Places

A very "embedded" trap from a real project: the CIU32F003's clock frequency macro **was defined twice — once in the standard library config header and once in CMSIS's `system_xxx.c`** (things like `RCH_VALUE`). The person changing the clock only updated one place, and the result was:

- The code actually ran at 48 MHz;
- But the protocol stack and delay functions computed time as if it were 8 MHz.

The symptoms were wonderfully surreal: UART baud rates all wrong, delays uniformly 6x too slow, watchdog periods off. After tracing everything, the root cause was simply that the same number in two files didn't agree.

The lesson in one sentence: **whenever "the same fact has two sources of truth," something will go wrong sooner or later.** Either merge them into one, or when changing it, search to confirm every reference point. This principle applies far beyond clocks — pin definitions, buffer sizes, version numbers, all of it.

## 7. Next Up

The LED is blinking, but it's "mute" — when something goes wrong you can only guess from its blinking language. In Part 2, "Making the MCU Talk": UART serial communication, plus RXNE interrupts and a ring buffer, so the MCU can print its internal state line by line to your computer. From then on, you have an "X-ray machine" for embedded development.

---

*This series is adapted from a real mass-production project; the pitfalls described come from actual development. Reading in order is recommended, as the posts build on each other.*
