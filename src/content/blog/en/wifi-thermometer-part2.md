---
title: "Part 2: Make the MCU Talk — UART, RXNE Interrupts, and Ring Buffers"
description: "UART frame format, the baud-rate register formula, RXNE interrupts, and ring buffers — give the MCU a mouth and gain an X-ray view into your program."
pubDate: 2026-11-24
lang: en
translationKey: wifi-thermometer-part2
tags: [Embedded, STM32, Tutorial]
category: embedded
series: wifi-thermometer
seriesOrder: 2
---

> Last time we made the LED blink, but an LED is "mute" — whatever happens inside the program, we can only guess. This time we give the MCU a "mouth": the UART serial port.
> From now on the MCU can print its internal state to the PC, and you own the single most important piece of embedded gear: **a window into your program's soul**.

---

## 1. Goals and Results

**Goal**: the MCU talks to the PC over the serial port — whatever the PC sends, it sends back (echo), and every second it proactively reports "system running, second N".

**What you'll understand by the end**: what a UART frame looks like, what the baud rate actually commits both sides to, why interrupts are non-negotiable, and why the ring buffer is standard equipment in every serial program.

## 2. Theory in 10 Minutes

### 2.1 UART: a two-wire conversation protocol

UART needs only two data lines: TX (I send, you receive) and RX (you send, I receive), plus a common ground. The reason it never dies comes down to one word: **simplicity**. A frame of data looks like this:

```
Idle ─┐                                          ┌─ Idle
      │ Start │ D0 │ D1 │ ... │ D7 │ Stop  │
      └───────┴────┴────┴─────┴────┴───────┘
       1 low bit   8 data bits, LSB first   1 high bit
```

There are only two things to agree on:

- **Baud rate**: how many *bits* per second. 9600 baud = 9600 bits per second. One frame is 10 bits (start + 8 data + stop), so **at 9600 baud one byte takes about 1.04 ms**. The Tuya module later runs at 9600 — memorize this number;
- **Data format**: 8 data bits, no parity, 1 stop bit, abbreviated **9600-8-N-1**. Sender and receiver must match on both of these; get either one wrong and everything is garbage.

Why do products pick a "snail's pace" like 9600? Because the other end is a Wi-Fi module, and the wire length, interference environment, and level matching are all mediocre — a low baud rate is the most reliable; plus temperature and humidity data is tiny, and 9600 is more than enough. **Good enough and stable always beats fast** — once again, the value system of a small-resource product.

### 2.2 Writing the baud rate into the register

The USART has a baud-rate register, BRR, and the formula is:

```
BRR = clock frequency / baud rate
```

With an 8 MHz clock at 9600: `8000000 / 9600 ≈ 833`; at 72 MHz it becomes `7500`. Note that this value **changes with the clock** — you just learned "the clock is global state" in Part 1, and here you use it immediately. For simplicity, this part does all experiments at the default 8 MHz.

### 2.3 The limits of polling: the CPU can't stand guard forever

The most naive way to send-then-receive is polling:

```c
// 发送：等发送数据寄存器空，再写入新字节
while ((USART1->SR & USART_SR_TXE) == 0) { }
USART1->DR = ch;

// 接收：等收到数据
while ((USART1->SR & USART_SR_RXNE) == 0) { }
ch = USART1->DR;
```

Polling is mostly fine for transmitting (you have to wait for it to finish anyway), but **polling for reception is a big problem**: when will the other side's byte arrive? Nobody knows. Your only option is a dead `while` loop — and then everything else in the main loop (blinking, sampling) grinds to a halt.

Worse, bytes arrive one at a time. By the time you wake up from the dead wait and finish handling one byte, the next may already be sitting in the receive register, and the one after that will **overwrite the byte you never read**. At 9600 baud, one byte gets overwritten every millisecond; the CPU takes a single nap and data is lost.

### 2.4 RXNE interrupt + ring buffer: the standard answer

The correct approach: every received byte triggers one **receive-not-empty interrupt (RXNE)** in hardware; the interrupt service routine (ISR) immediately moves the byte into a buffer and exits right away. Whenever the main loop has spare time, it comes back and processes the buffered data at leisure.

Do nothing in the interrupt, only move data — the buffer is the soul of this pattern. The most common buffer structure is the **ring buffer**: a fixed-length array plus two indices:

```
         tail (ISR writes)      head (main loop reads)
           ↓                       ↓
  [ ][ ][a][b][c][d][ ][ ][ ][ ][ ]
          └──── unread data ────┘
```

- The ISR receives a byte: `buf[tail] = data; tail = (tail + 1) % SIZE;`
- The main loop reads: `data = buf[head]; head = (head + 1) % SIZE;`
- Empty check: `head == tail`; full check: `(tail + 1) % SIZE == head` (sacrifice one slot to distinguish "full" from "empty").

If the buffer size is a power of two (16, 32, 64...), the modulo can be replaced by a bitwise AND for speed: `tail = (tail + 1) & (SIZE - 1)`. The habit of a small-resource product: pinch pennies everywhere.

## 3. Hands-On Coding

### Step 1: Wiring

```
CH340 module       Blue Pill
  RX      ◄────────  PA9  (USART1_TX)
  TX      ────────►  PA10 (USART1_RX)
  GND     ────────►  GND
```

Note: TX goes to RX, RX goes to TX — **cross-connected**. This is the number one beginner fail. The CH340 module has a 5V/3.3V jumper; set it to **3.3V**.

### Step 2: GPIO and USART configuration

PA9/PA10 are USART1's default pins; configure them as **alternate-function push-pull output**（ Alternate Function — the pin is handed over to the USART hardware):

```c
#include "stm32f103xb.h"
#include <stdint.h>

#define BUF_SIZE   64
#define BUF_MASK   (BUF_SIZE - 1)

static volatile uint8_t  s_buf[BUF_SIZE];
static volatile uint16_t s_head = 0;
static volatile uint16_t s_tail = 0;

static void uart_init(void)
{
    RCC->APB2ENR |= RCC_APB2ENR_USART1EN;      // 开 USART1 时钟
    RCC->APB2ENR |= RCC_APB2ENR_IOPAEN;        // 开 GPIOA 时钟

    // PA9 = TX：复用推挽输出 50MHz → CNF=10, MODE=11
    GPIOA->CRH &= ~(0xF << 4);
    GPIOA->CRH |=  (0xB << 4);
    // PA10 = RX：浮空输入 → CNF=01, MODE=00
    GPIOA->CRH &= ~(0xF << 8);
    GPIOA->CRH |=  (0x4 << 8);

    USART1->BRR = 8000000 / 9600;              // 8MHz / 9600 ≈ 833

    USART1->CR1 = USART_CR1_TE                 // 使能发送
                | USART_CR1_RE                 // 使能接收
                | USART_CR1_RXNEIE             // 接收非空中断
                | USART_CR1_UE;                // USART 总开关（最后开）

    NVIC_EnableIRQ(USART1_IRQn);               // 在 NVIC 里放行 USART1 中断
}

static void uart_putc(char ch)
{
    while ((USART1->SR & USART_SR_TXE) == 0) { }  // 等发送寄存器空
    USART1->DR = ch;
}

static void uart_puts(const char *s)
{
    while (*s) uart_putc(*s++);
}

static int uart_getc(void)                        // 主循环用：取一个字节，无数据返回 -1
{
    if (s_head == s_tail) return -1;
    uint8_t d = s_buf[s_head];
    s_head = (s_head + 1) & BUF_MASK;
    return d;
}
```

The interrupt service function (the name must match the vector table in the startup file):

```c
void USART1_IRQHandler(void)
{
    if (USART1->SR & USART_SR_RXNE) {           // 确认是接收中断
        uint8_t d = (uint8_t)USART1->DR;        // 读 DR 会自动清 RXNE 标志
        uint16_t next = (s_tail + 1) & BUF_MASK;
        if (next != s_head) {                   // 缓冲区没满才存，满了丢弃
            s_buf[s_tail] = d;
            s_tail = next;
        }
    }
}
```

Three details must be emphasized:

1. **The ISR only moves data, never does business logic**. Running something loop-heavy like `uart_puts` inside an interrupt will at best drop bytes and at worst crash the system;
2. **Reading DR clears the RXNE flag** — that's a hardware convention; no manual clearing needed;
3. `s_buf/s_head/s_tail` are declared `volatile` — they get modified by the interrupt; without `volatile` the compiler may optimize away the checks in the main loop, and the program will "clearly receive data yet never see it". `volatile` is the amulet of interrupt-shared variables.

### Step 3: Main loop — echo + once-per-second heartbeat

```c
int main(void)
{
    uart_init();
    uart_puts("UART ready. Echo mode.\r\n");

    uint32_t seconds = 0;
    uint32_t ms_cnt  = 0;

    while (1) {
        /* 回显：缓冲区里有啥吐啥 */
        int ch = uart_getc();
        if (ch >= 0) uart_putc((char)ch);

        /* 大约 1 秒的心跳（延时函数照第 1 篇的 SysTick 版）*/
        delay_ms(10);
        ms_cnt += 10;
        if (ms_cnt >= 1000) {
            ms_cnt = 0;
            seconds++;
            char msg[32];
            int n = 0;
            const char *p = "alive, tick=";
            while (p[n]) { msg[n] = p[n]; n++; }
            msg[n++] = (char)('0' + (seconds % 10) + 0); // 简化：只放个位
            msg[n++] = '\r'; msg[n++] = '\n'; msg[n] = 0;
            uart_puts(msg);
        }
    }
}
```

## 4. Flash and Acceptance Test

Open a serial assistant (SSCOM), pick the COM port corresponding to the CH340, set the parameters to **9600, 8, N, 1**, and open the port:

- [ ] After resetting the MCU, the tool receives `UART ready. Echo mode.`;
- [ ] Type characters in the tool and send; you receive an identical echo back;
- [ ] When you don't type, you receive one `alive, tick=...` line per second;
- [ ] (Advanced) Change the tool's baud rate to 115200 and send again — you get a stream of garbage. Change back to 9600 and it's normal again. **Garbage = baud-rate mismatch** — burn this reflex into muscle memory.

## 5. The Original Product (CIU32F003)

The product's UART module (talking to the Tuya Wi-Fi module) is exactly isomorphic in configuration, just wrapped into the BSP layer: `bsp_uart.c` centrally defines the UART instance, pins, and the **baud-rate macro (9600)**; initialization follows the same "enable clock → configure GPIO → configure baud rate → enable RXNE interrupt" sequence as this part.

Two product-grade differences worth mentioning:

1. **The receive buffer is wired directly into the Tuya SDK**. The product's RX interrupt doesn't maintain its own ring buffer; instead, every byte is fed straight into the SDK's `uart_receive_input()`, and the SDK internally maintains the protocol-parsing buffer. When we port the SDK in Part 9, we will be standing exactly at this integration point;
2. **The transmit buffer is 128 bytes**. The product has a requirement to send a "combined frame of 14 DPs in one shot" (detailed in Part 11); if the transmit buffer is too small, the frame gets truncated. The buffer size isn't picked out of thin air — it's dictated by the largest frame.

## 6. Bonus: Two send-related crash scenes

### 6.1 The last byte wasn't finished when the program moved on

Early in the product's life there was a spooky phenomenon: frames sent to the Wi-Fi module **occasionally lost their last byte**, the checksum no longer matched, and the module rejected the frame. The probability was low and hard to reproduce.

The culprit was the difference between the `TXE` and `TC` flags:

- `TXE` (transmit data register empty): you handed the byte to the USART, but it's still queued in the shift register waiting to go out on the wire — **TXE is already set at this point**;
- `TC` (transmission complete): the shift register is empty too; the last bit really made it onto the wire.

Back then, the "wait until done sending" waited on TXE. Most of the time nothing bad happened, but as soon as the main loop did something else right after the last byte (say, entered low-power sleep or shut down the USART), that byte still on its way was strangled on the wire. Once the wait was switched to `TC`, the failure vanished for good.

This lesson went into the team checklist: **"finished sending" means waiting for TC, not TXE.** Especially in low-power products — send, then sleep; sleep too eagerly and you'll eat the tail of your own frame.

### 6.2 The serial assistant's "invisible floor"

Another high-frequency beginner trap: the serial assistant shows received data, yet `uart_getc()` in the program just won't return anything — in the end it turned out that **the interrupt never fired**, and the interrupt never fired because USART was already receiving data before `NVIC_EnableIRQ`, so the overrun flag (ORE) got set first and jammed the state machine. Handling receive error flags (ORE/FE/PE) is also one of the ISR's responsibilities; the ISR in a real project usually opens with a line of defensive "clear error flags" code.

The lesson: **whatever defense the example code omits is the seed of a production incident.** It's fine to simplify error handling while learning, but be clear in your mind about exactly what was omitted and where.

## 7. Next Time

The MCU can talk now. Next we teach it to "sense" — Part 3, *Bit-Banging I2C, Reading the First Temperature and Humidity*: we'll hook up the GXHT40 sensor and **manually mimic an I2C bus waveform with two plain GPIOs** to read temperature and humidity out of it. This is also the most unusual aspect of the project: the product chip's I2C hardware only supports slave mode, so the entire bus is pried into existence in software. Logic analyzer, you may be unboxed.

---

*This series is adapted from a real mass-production project; every pitfall recorded here comes from actual development. Reading in order is recommended, as parts depend on each other.*
