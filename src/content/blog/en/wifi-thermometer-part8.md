---
title: "Part 8: Tuya Protocol 101 — Anatomy of the `55 AA` Frame, and a Human-vs-Machine Showdown"
description: "Hand-write a Tuya protocol frame parser and frame builder: no Wi-Fi module purchase needed — use a PC serial assistant to play the module in a human-vs-machine duel with the MCU, covering the 55 AA frame format, checksum, and receive state machine."
pubDate: 2026-11-24
lang: en
translationKey: wifi-thermometer-part8
tags: [Embedded, STM32, Tutorial]
series: wifi-thermometer
seriesOrder: 8
category: embedded
---

> For seven posts now, the MCU has been a fully-equipped "lone hero". Starting with this post, it goes online and meets the outside world — but first it has to pass the protocol gate.
> Good news: you don't need to buy a Wi-Fi module. In this post we use a serial assistant on the PC to **play** the Wi-Fi module, staging a "human-vs-machine duel" against the MCU. Once the protocol is understood inside out, the module can be swapped for a real one at any time.

---

## 1. Goals and the Payoff

**Goal**: hand-write a Tuya protocol frame parser + frame builder, achieving:

1. The serial assistant sends a "work mode query" (`55 AA 00 02 00 00 01`); the MCU parses it correctly and replies with the agreed frame;
2. The serial assistant sends heartbeats, the MCU replies to heartbeats; if heartbeats stop for 3 seconds, the MCU raises the alarm "lost contact with the module";
3. Deliberately send a frame with a wrong checksum; the MCU rejects it and prints the reason.

**What you'll understand afterwards**: the job of every byte in the frame format, how the checksum is computed, how to write a receive state machine, and what the word "handshake" specifically means in a protocol.

## 2. Ten Minutes of Theory

### 2.1 Why "Frames": From Byte Stream to Messages

The serial port from Part 2 is a byte stream: you can't tell which bytes make up one complete message. The first job of a communication protocol is to **draw boundaries in the byte stream** — packaging bytes into "frames". The Tuya protocol frame structure:

```
┌────────┬────┬──────┬───────┬──────────┬───────┐
│ Header │Ver │ Cmd  │Length │  Data    │Checksum│
│ 55 AA  │ 1B │ 1B   │ 2B    │ 0~N bytes│ 1B    │
└────────┴────┴──────┴───────┴──────────┴───────┘

Checksum = (Ver + Cmd + LengthHigh + LengthLow + all data bytes) & 0xFF
```

Let's dissect a real frame byte by byte (the first thing the module asks the MCU after power-on — the **work mode query**):

```
55 AA 00 02 00 00 01
│  │  │  │  │  │  └─ Checksum: 00+02+00+00 = 02?  Hold on!
│  │  │  │  │  └──── Data length low byte = 0
│  │  │  │  └─────── Data length high byte = 0
│  │  │  └────────── Cmd = 0x02 (work mode query)
│  │  └───────────── Version = 0x00 (module-initiated frames use 0x00)
│  └──────────────── Header byte 2 (fixed AA)
└─────────────────── Header byte 1 (fixed 55)
```

The checksum accumulates **starting from the version byte**: here `0x00 + 0x02 + 0x00 + 0x00 = 0x02` — wait, the last byte of the frame is `0x01`?

...Hold on, keep that contradiction in mind. Section 2.3 of this post will give you the answer, and it's the first clue of a major case in Part 10.

Three rules to nail down first:

1. **The two fixed header bytes** `55 AA` — find the start of a frame;
2. **The length field has the final say** — how long the data area is gets declared by it, and the parser collects data according to it;
3. **The checksum is the bottom line** — if any single bit got corrupted in transit, the checksum won't match, and the frame must be dropped.

### 2.2 The Receive State Machine: "Eating" Bytes Field by Field

Bytes arrive one at a time, so the parser advances byte by byte with a small state machine:

```
WAIT_55 ──55──▶ WAIT_AA ──AA──▶ VER ──▶ CMD ──▶ LEN_H ──▶ LEN_L
   ▲                                  │
   │                                  └── collect DATA per len ──▶ CHKSUM
   └────────── any mismatch at any step: back to WAIT_55 ─────────┘
```

"If any step doesn't match expectations, go back to hunting for the header" — this single rule gives the parser **built-in immunity and self-healing against interference**: noise bytes and leftover fragments on the bus are discarded byte by byte, while it waits for the next clean `55 AA`.

### 2.3 Heartbeat and Work Mode Query: The Module's Two Opening Questions

In the Tuya low-power protocol, the module leads the handshake, with a two-question opening:

**① Work mode query (0x02)**: right after power-on, the module asks: "Between the two of us, who's in charge?" The MCU must reply with its work mode within the agreed time window; otherwise the module concludes nobody is home and re-asks in a loop (or even gets stuck in initialization).

**② Heartbeat (0x00)**: after the handshake, the module periodically sends heartbeat frames, and the MCU must reply to them exactly as received. The meaning of the heartbeat is two words: **staying alive**. If either side fails to receive a heartbeat several times in a row, it can declare the other side offline — for a low-power product, the MCU uses the heartbeat to monitor "is the module still doing its job properly", and the module uses the heartbeat to decide "can I safely go to sleep".

The version byte of the MCU's reply frame is **0x03** (different from the 0x00 of module-initiated frames — this is the protocol's role convention). Take the heartbeat reply as an example and compute the checksum by hand:

```
Ver   Cmd   LenH  LenL      Sum
 03 + 00 +  00  +  00   =  03   → frame: 55 AA 03 00 00 00 03
```

## 3. Hands On: Writing the Code

### Step 1: The Frame Builder (for Transmitting)

```c
static void tuya_send_frame(uint8_t ver, uint8_t cmd,
                            const uint8_t *data, uint16_t len)
{
    uint8_t sum = 0;
    uart_putc(0x55); uart_putc(0xAA);
    uart_putc(ver);  sum += ver;
    uart_putc(cmd);  sum += cmd;
    uart_putc((uint8_t)(len >> 8)); sum += (uint8_t)(len >> 8);
    uart_putc((uint8_t)(len & 0xFF)); sum += (uint8_t)(len & 0xFF);
    for (uint16_t i = 0; i < len; i++) {
        uart_putc(data[i]); sum += data[i];
    }
    uart_putc(sum);
}
```

### Step 2: The Receive State Machine (Driven in a 10 ms Tick)

```c
typedef enum {
    RX_55 = 0, RX_AA, RX_VER, RX_CMD, RX_LENH, RX_LENL, RX_DATA, RX_SUM
} rx_state_t;

typedef struct {
    rx_state_t state;
    uint8_t  ver, cmd, lenh, lenl, sum;
    uint8_t  data[32];
    uint16_t idx;
} rx_t;

static rx_t s_rx;

static void rx_reset(void) { s_rx.state = RX_55; s_rx.sum = 0; s_rx.idx = 0; }

/* 每收到一个字节喂进来 */
static void rx_feed(uint8_t b)
{
    switch (s_rx.state) {
    case RX_55:  if (b == 0x55) s_rx.state = RX_AA; break;
    case RX_AA:  if (b == 0xAA) { s_rx.state = RX_VER; s_rx.sum = 0; }
                 else rx_reset(); break;
    case RX_VER: s_rx.ver = b; s_rx.sum += b; s_rx.state = RX_CMD; break;
    case RX_CMD: s_rx.cmd = b; s_rx.sum += b; s_rx.state = RX_LENH; break;
    case RX_LENH:s_rx.lenh = b; s_rx.sum += b; s_rx.state = RX_LENL; break;
    case RX_LENL:{
        s_rx.lenl = b; s_rx.sum += b;
        uint16_t len = ((uint16_t)s_rx.lenh << 8) | s_rx.lenl;
        if (len == 0)      s_rx.state = RX_SUM;
        else if (len > 32) rx_reset();              // 超长帧：不可能，丢弃
        else               { s_rx.idx = 0; s_rx.state = RX_DATA; }
        break;
    }
    case RX_DATA:
        s_rx.data[s_rx.idx++] = b; s_rx.sum += b;
        if (s_rx.idx >= (((uint16_t)s_rx.lenh << 8) | s_rx.lenl))
            s_rx.state = RX_SUM;
        break;
    case RX_SUM: {
        uint8_t frame_sum = s_rx.sum;               // 本地累加值
        if (frame_sum == b) on_frame_ready(&s_rx);  // 校验通过，交业务层
        else uart_puts("[rx] checksum error, dropped\r\n");
        rx_reset();
        break;
    }
    }
}
```

### Step 3: Business Dispatch + Heartbeat Monitoring

```c
static uint32_t s_last_heartbeat_ms = 0;

static void reply_work_mode(void)
{
    uint8_t mode = 0x00;                 // 0x00 = MCU 配合处理模式（语义见原版对照）
    tuya_send_frame(0x03, 0x02, &mode, 1);
    uart_puts("[tx] work mode reply\r\n");
}

static void on_frame_ready(rx_t *f)
{
    switch (f->cmd) {
    case 0x00:                                  // 心跳
        tuya_send_frame(0x03, 0x00, NULL, 0);
        s_last_heartbeat_ms = s_now_ms;
        uart_puts("[rx] heartbeat\r\n");
        break;
    case 0x02:                                  // 工作模式查询
        reply_work_mode();
        break;
    default:
        uart_puts("[rx] unknown cmd\r\n");
        break;
    }
}
```

In the main loop (inside the window tick from Part 7), add the lost-contact monitor:

```c
if (s_now_ms - s_last_heartbeat_ms > 3000) {
    uart_puts("!! heartbeat lost\r\n");
    /* 产品里这里会触发 Wi-Fi 状态置为未知（第 11 篇展开） */
}
```

## 4. Flashing and Acceptance: The Human-vs-Machine Duel Opens

Wiring: cross-connect the CH340 module's TX/RX to PA10/PA9 (same as Part 2), and set the serial assistant to **9600-8-N-1, with hexadecimal display and send**.

- [ ] **Opening**: the assistant sends `55 AA 00 02 00 00 01` (make sure "hex send" is checked), the MCU's serial prints `[tx] work mode reply`, and the assistant receives the reply frame `55 AA 03 02 00 01 00 06` — **verify the reply frame's checksum with a calculator yourself** (03+02+00+01+00 = 06);
- [ ] **Heartbeat**: the assistant sends `55 AA 00 00 00 00 00`, the MCU replies `55 AA 03 00 00 00 03`;
- [ ] **Lost-contact alarm**: stop sending heartbeats; 3 seconds later the MCU prints `!! heartbeat lost`;
- [ ] **Checksum defense**: change the last byte of the first query frame to `02` and send it again — the MCU prints `checksum error, dropped` and doesn't reply at all;
- [ ] **Logic analyzer bonus**: capture the waveform of this whole conversation, and you'll see the `55 AA` start with your own eyes, one bit at about 104µs at 9600 baud — every number in the protocol documentation becomes three-dimensional for the first time.

**Troubleshooting tip**: the MCU replied but the assistant shows garbage → check whether the assistant is set to 9600 (muscle memory from Part 2). The assistant sent something but nothing happens → nine times out of ten you forgot to check "hex send", and the assistant transmitted the ASCII codes of the string "55 AA...".

## 5. The Original Product (CIU32F003)

The product talks to a real Tuya module, and every element of this post has a counterpart there — the difference is depth:

1. **Version number 0x03 is a hard requirement**. We genuinely stepped on this during product debugging: the version byte of an MCU reply frame was written wrong once, the module couldn't match the "accent", the handshake failed forever, and the module frantically re-sent 0x02 — the symptom was "the serial port is full of query frames, the MCU is replying too, but it never ends". Every fixed field in a protocol is a secret code; get one wrong and you're in two different worlds;
2. **The content of the 0x02 reply is not arbitrary**. The product chose "MCU coordinated-processing mode" — behaviors like the Wi-Fi status LED and reset are controlled in coordination with the MCU, which is the standard posture for low-power products (the whole "stay awake during provisioning" logic relies on it);
3. **The product has an extra "handshake-complete flag"**. The parsing layer sets this flag only after receiving confirmation that the 0x02 reply succeeded; **before the flag is set, reporting any DP data is forbidden** — otherwise the module hasn't entered its working state yet, the frames are sent in vain, and the two sides even interfere with each other. One piece of "flag + checkpoint" discipline eliminated a whole class of timing bugs;
4. **The heartbeat monitoring goes deeper**. The product uses the heartbeat to decide whether the module is alive; once contact is lost, the connectivity status icon is treated as "unknown" (the Wi-Fi icon doesn't display stale states) — Part 11 will expand on this detail.

## 6. Bonus: That Checksum That Wouldn't Add Up Was a Setup

Back to the contradiction planted in Section 2.1: `55 AA 00 02 00 00 01` — by the rules the checksum should be `0x00+0x02+0x00+0x00=0x02`, yet the frame says `0x01`.

This frame isn't my typo — **it was captured from a real product log, a frame the module genuinely sends after power-on**, and the value `01` is not a coincidence: it happens to be the code of the "AP provisioning state" in the Tuya protocol.

A frame whose checksum doesn't match, whose content hides a semantically meaningful state value... what happens if, in the product code, you directly read out "the byte at the checksum position" and use it as data?

I'll keep you in suspense. In Part 10, "Case Closed: The 'Factory Reset' Caused by 7 Bytes", we will fully reconstruct this real-life "major case": settings changed by users in the App kept reverting to defaults, the team suspected storage, suspected the cloud, and the murderer turned out to be this unremarkable empty frame. By then you'll understand why this post keeps hammering "the checksum is the bottom line" — **every rule in a protocol is a monument to some past accident**.

## 7. Next Up

Hand-writing a protocol parser is great for learning, but a real product won't keep hand-writing everything — Tuya officially provides an MCU SDK that wraps up framing, parsing, and DP management. Next up, Part 9: "Porting the Tuya SDK": what the SDK looks like, how the four integration points connect, and why porting to a chip with 3 KB of RAM starts with **doing the math first** — which features to mercilessly cut.

---

*This series is adapted from a real mass-production project; every pitfall recorded here comes from real development. Reading in order is recommended, as the parts depend on each other.*
