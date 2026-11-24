---
title: "Part 12: Flash Persistence — How Settings Are Stored, the Endurance Math, and the \"Unified Storage Block\""
description: "Settings only live in RAM and vanish on every reset. This post stores them in the chip's internal Flash: the 1-to-0-only physics, the write-endurance arithmetic, and why one unified storage block is the standard answer for small-resource products."
pubDate: 2026-11-24
lang: en
translationKey: wifi-thermometer-part12
tags: [Embedded, STM32, Tutorial]
series: wifi-thermometer
seriesOrder: 12
category: embedded
---

> The DP cache works, but the settings live only in RAM: one reset (battery swap, watchdog bite, OTA upgrade) and every threshold the user ever changed evaporates.
> This post stores the settings in the chip's internal Flash. It sounds like a "call the library, read and write" job, but it hides three hard problems: **the physics of Flash (bits can only go 1 → 0), the arithmetic of write endurance, and how to store multiple settings without wearing holes in each other**.

---

## 1. Goals and the Payoff

**Goal**: implement settings storage — change the temperature upper limit via a serial command and save it, and **after pressing the reset button or power-cycling, the setting is still there**.

**What you'll understand afterwards**: the write/erase rules of internal Flash (unlock first, erase before write, halfword writes), how to do the endurance math, and why "pack all settings into a single block" is the standard answer for small-resource products.

## 2. Ten Minutes of Theory

### 2.1 The Physics of Flash: Bits Can Only Go 1 → 0

The Flash inside an MCU is NOR type, and it has one counterintuitive iron rule:

> **Each bit can only be written from 1 to 0, never from 0 back to 1.**

Want to turn a 0 back into a 1? The only way is to **erase** — and erasing has a minimum granularity (the STM32F103 erases by "page", 1 KB per page): one erase wipes the entire page back to all 0xFF.

So the standard Flash write procedure is always: **unlock → erase the whole page → write → lock**. Want to change a single byte? Sorry — erase the whole page and rewrite it.

The other deadly property is **endurance**: each page of the F103 is rated for roughly **10,000 erase/write cycles**. Ten thousand sounds like a lot, but do the math and you wake up fast (section 2.3 does it in detail).

### 2.2 The Five-Step Register Dance

```c
#define FLASH_PAGE_ADDR   0x0800FC00    // F103C8 64KB, 用最后一页(1KB)做存储

static void flash_unlock(void)
{
    FLASH->KEYR = 0x45670123;           // 钥匙 1
    FLASH->KEYR = 0xCDEF89AB;           // 钥匙 2（顺序不能错，错一次锁死到复位）
    while (FLASH->CR & FLASH_CR_LOCK) { }
}

static void flash_erase_page(uint32_t addr)
{
    FLASH->CR |= FLASH_CR_PER;          // 页擦除模式
    FLASH->AR = addr;                   // 选页
    FLASH->CR |= FLASH_CR_STRT;         // 开擦
    while (FLASH->SR & FLASH_SR_BSY) { }
    FLASH->CR &= ~FLASH_CR_PER;
}

static void flash_write_halfword(uint32_t addr, uint16_t data)
{
    FLASH->CR |= FLASH_CR_PG;           // 编程模式
    *(__IO uint16_t *)addr = data;      // F103 只能 16 位（半字）写
    while (FLASH->SR & FLASH_SR_BSY) { }
    FLASH->CR &= ~FLASH_CR_PG;
}

static void flash_lock(void) { FLASH->CR |= FLASH_CR_LOCK; }
```

The real product has the exact same unlock sequence — **forget to unlock before writing Flash and the write is silently discarded**: no error, no interrupt. (The OTA flavor of this trap in Part 16 is even nastier — noted on the ledger for now.)

### 2.3 The Endurance Math: Why "One Page per Setting" Wears Holes

Say the product has 6 two-way settings: temperature/humidity upper and lower limits, temperature unit, mute, calibration... **If each setting gets its own Flash page**, the wear becomes wildly unbalanced:

- A threshold like the alarm limits can get changed dozens of times a day during debugging;
- The temperature-unit toggle, a user might flip two or three times in their entire life.

With one page each: the hot page takes 50 erase cycles a day → 10000 ÷ 50 = **worn through in 200 days**; meanwhile 99.9% of the cold page's lifespan is sacrificed for nothing. An early version of the project looked exactly like this — every cached DP erased its own page, adding up to over a thousand erase cycles a day, and a few months later that was the end of Flash's life.

**The standard answer: the unified storage block.** Define a struct that packs all the settings together, and **any** setting change rewrites the whole block. Page-lifetime consumption goes from "counted per setting" to "counted for all settings combined":

```
With a unified block: even 20 setting changes a day means only 20 erase cycles
10000 ÷ 20 ÷ 365 ≈ 1.4 years → still not enough? Keep squeezing:
Save "only when a setting actually changes" instead of periodically →
real users change settings a few times a day at most → lifetime now measured in decades
```

Turning "save" from a **periodic action** into an **event-driven action** (store only when something changed) is the single biggest saving in the endurance ledger.

### 2.4 Data Layout: Magic Number + Payload + Checksum

You've stored a page of data — how do you know it holds valid settings and not factory 0xFF garbage? A three-piece kit:

```
┌─────────┬──────────────────────┬────────┐
│ magic    │ settings struct      │ checksum│
│ 2 bytes  │ N bytes              │ 2 bytes │
└─────────┴──────────────────────┴────────┘
magic   = 0xA55A (a custom password — 0xFF can never be it)
checksum = accumulate/XOR the payload, verify it on read
```

On read: wrong magic → treat as first power-up, load defaults; wrong checksum → the data was damaged (say, power lost mid-save), fall back to defaults as well. **Power loss during a save** is a real scenario, and the checksum is the insurance policy bought for it.

## 3. Hands-on Coding

```c
typedef struct {
    uint16_t temp_hi_x10;
    uint16_t temp_lo_x10;
    uint16_t hum_hi;
    uint16_t hum_lo;
    uint8_t  unit_f;
    uint8_t  mute;
} settings_t;                                // 全设置打包

static settings_t s_settings;

#define SET_MAGIC   0xA55A

static void settings_save(void)
{
    flash_unlock();
    flash_erase_page(FLASH_PAGE_ADDR);

    uint16_t magic = SET_MAGIC;
    flash_write_halfword(FLASH_PAGE_ADDR, magic);

    uint16_t *src = (uint16_t *)&s_settings;             // 结构体按半字写
    for (uint32_t i = 0; i < sizeof(settings_t) / 2; i++) {
        flash_write_halfword(FLASH_PAGE_ADDR + 2 + i * 2, src[i]);
    }

    uint16_t sum = 0;                                    // 校验和：内容累加
    for (uint32_t i = 0; i < sizeof(settings_t) / 2; i++) sum += src[i];
    flash_write_halfword(FLASH_PAGE_ADDR + 2 + sizeof(settings_t), sum);

    flash_lock();
}

static int settings_load(void)
{
    uint16_t magic = *(volatile uint16_t *)FLASH_PAGE_ADDR;
    if (magic != SET_MAGIC) return -1;                   // 没存过

    uint16_t *dst = (uint16_t *)&s_settings;
    for (uint32_t i = 0; i < sizeof(settings_t) / 2; i++) {
        dst[i] = *(volatile uint16_t *)(FLASH_PAGE_ADDR + 2 + i * 2);
    }
    uint16_t sum = *(volatile uint16_t *)(FLASH_PAGE_ADDR + 2 + sizeof(settings_t));
    uint16_t calc = 0;
    for (uint32_t i = 0; i < sizeof(settings_t) / 2; i++) calc += dst[i];
    return (sum == calc) ? 0 : -1;                       // 校验失败
}

void settings_init(void)
{
    if (settings_load() != 0) {                          // 读不出 → 出厂默认
        s_settings.temp_hi_x10 = 300;
        s_settings.temp_lo_x10 = 100;
        s_settings.hum_hi      = 60;
        s_settings.hum_lo      = 20;
        s_settings.unit_f      = 0;
        s_settings.mute        = 1;                      // 告警默认静音（产品定义）
    }
}
```

In `dp_download_handle()` (Part 9), add one `settings_save();` at the end of every settings-type DP branch — the moment a setting changes, it hits the disk. The main loop does no periodic saving at all (the endurance ledger of section 2.3).

## 4. Flash and Verify

- [ ] Use the serial command to set the temperature upper limit to 35 and print to confirm;
- [ ] **Press the dev board's reset button**: after reboot the setting is still 35 — Flash persistence works;
- [ ] **Unplug the USB to kill power, then power back on**: the setting is still 35 — it survived a real power loss;
- [ ] A fresh chip flashed for the first time: reads back the defaults (the magic-check path kicks in);
- [ ] (Advanced experiment) Change the save policy to "unconditionally save every 10 seconds", run it for an hour, and print the accumulated erase count over the serial port — then come back and work out how many days it would take to wear through a page. Do the math once with your own hands, and the numbers in section 2.3 actually become yours.

## 5. The Original Product (CIU32F003)

The product's storage module is the productized, hardened version of this post's approach, with four upgrades:

1. **Unified block + event-driven save**: all settings-type DPs merge into one storage block, saved only when a setting actually changes — the ledger in section 2.3 is the product's real ledger;
2. **The storage page lives outside the OTA partition**. This is a scar-tissue point: when the product planned OTA (Part 16), we realized that if the settings page sat inside the App partition, **every firmware upgrade would erase the user's settings along with it** — the user finishes the upgrade to find every threshold restored to factory, a customer-complaint appointment booked. In the end the storage page is pinned to a reserved region that neither Bootloader nor App touches: OTA can upgrade freely, settings don't move;
3. **Save timing cooperates with the DP cache**. The application layer saves only when "cache application" or "user issue" causes a setting to change, strictly decoupled from the cache state machine of Part 11 — the state machine owns timing, the storage module only owns "changed → store";
4. **Chip address-aliasing details**. The Flash space of the chip in the product has a 0x0000 alias mapping, and erase/write operations impose specific requirements on the address window — there is no universal knowledge for details like this; **the only authority is the Flash chapter of the chip's datasheet**, checked line by line when porting.

## 6. Bonus: A Worn-Out Flash and "Why Won't It Take My Changes Anymore"

Let's turn the endurance math into a full accident postmortem: a certain product (a common shape of real industry cases) stored its Wi-Fi provisioning counter in Flash, writing once per cloud connection. The lab couldn't catch the problem — a week of testing wrote a few hundred times, nowhere near 10,000. Then it shipped and reached users' hands: the device connected to the cloud every 10 minutes, 144 erase cycles a day, hot page worn through in 69 days. **What does a worn-out page look like?** It won't erase clean, won't take writes, reads back shifting data — the symptom is "the device acts weird after running a while, then a reset makes it fine for a bit," and it's a debugging nightmare, because the scope on the bus shows everything perfectly normal: **what's broken is the storage medium itself**.

What's terrifying about this class of accident is its **time-delayed nature**: the bill for a design mistake arrives months later. The defenses are this post's three-piece kit: consolidate the wear (unified block), lower the frequency (event-driven save), and budget clearly (page lifetime ÷ daily erase cycles > product lifetime). **Before you write a single line of Flash storage code, do that division first** — this number arrives earlier than any code review.

## 7. Next Up

Data can be stored, reported, and the device can sleep — but the user can't read temperature and humidity off a serial port forever. Next is Part 13, "Segment LCD": the product doesn't use a graphical screen but a segment display (the kind on digital watches), driven by the VKL076 over I2C. We'll put the bit-banged I2C craft from Part 3 to work a second time — writing the display RAM, lighting icons, and entering power-saving standby — and the 1602 you bought back in Part 0 finally gets its moment.

---

*This series is adapted from a real mass-production project; every pitfall recorded here comes from real development. Read in order — the parts depend on each other.*
