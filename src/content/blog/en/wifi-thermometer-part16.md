---
title: "Part 16: The OTA Bootloader — Flash Layout, the Jump Trick, and the Mystery of \"Dies After One Frame\""
description: "Build a minimal dual-project OTA system: Flash partition planning, the Bootloader's jump decision, the physical limits of self-writing Flash, and a textbook real-world bug — the OTA always fails after receiving exactly the first frame, with no error, no exception."
pubDate: 2026-11-24
lang: en
translationKey: wifi-thermometer-part16
tags: [Embedded, STM32, Tutorial]
series: wifi-thermometer
seriesOrder: 16
category: embedded
---

> The feature puzzle has only its biggest piece left: OTA. What do you do when the firmware has a bug? The devices are sold all over the country — you can't take them back and reflash them by hand. The device has to be able to replace its own firmware.
> This post has one of the highest knowledge densities in the whole series: **Flash partition planning, the Bootloader's jump decision, the physical limits of self-writing Flash**, plus a textbook real-world bug: the OTA always "fails after receiving the first frame" — no error, no exception.

---

## 1. Goals and What You'll Get

**Goal**: build a minimal dual-project system — a Bootloader project + an App project:

1. At power-on the Bootloader checks the upgrade flag: no upgrade request → counts down 2 seconds and jumps to the App;
2. Hold the button (or send a serial command) → stay in upgrade mode, receive a chunk of "firmware data" and write it into the App region;
3. When done, set the "upgrade succeeded" flag; after reset the Bootloader hands control to the new App;
4. If power is lost mid-upgrade and the device restarts → it will not jump into a half-baked firmware (brick-proofing).

**When you're done you'll understand**: why the App can't upgrade itself, how to draw the partition table, the five critical lines of the Bootloader jump, and the brick-proofing philosophy behind flag design.

## 2. Theory in 10 Minutes

### 2.1 Why There Must Be a Bootloader

The most intuitive OTA approach: the App receives the new firmware and writes it directly into its own Flash. Physically impossible — **Cortex-M fetches instructions from Flash, and many chips forbid erasing/programming the same Flash region that is currently being fetched from** (the bus stalls during erase, the fetch fails, and the CPU crashes). Even if the hardware allowed it, "running while ripping up the floor beneath your own feet" is too risky.

So the standard structure for MCU OTA is always **two-stage**:

```
Flash layout (the product's real partitions):

0x0000_0000 ┌─────────────┐
            │  Bootloader │  8 KB (actually uses 4.5 KB)
            │  resident,  │
            │  runs updates│
0x0000_2000 ├─────────────┤
            │             │
            │    App      │  15 KB, the everyday you
            │             │
0x0000_5C00 ├─────────────┤
            │ OTA flag    │  UPDATE_REQUEST / UPDATE_OK
            │ area +      │
            │ config storage│
0x0000_6000 └─────────────┘
```

At power-on the Bootloader always runs first, and it answers a simple multiple-choice question:

```
Check the OTA flag:
  UPDATE_REQUEST? → enter upgrade mode, receive data, write App region
  UPDATE_OK?      → clear the flag, jump to App (new firmware takes office)
  neither         → jump to App directly (the everyday path, takes milliseconds)
```

During the upgrade it's the Bootloader that erases and programs the Flash — the App isn't even in the room. The physical contradiction of 2.1 dissolves elegantly.

### 2.2 The Five Lines of the Jump

Handing the CPU from the Bootloader to the App is essentially "faking a reset": set the stack pointer, set the program counter. The App is linked at 0x2000, so:

```c
#define APP_ADDR   0x08002000    // 学习版 F103 可用 0x08004000，原理相同

static void jump_to_app(void)
{
    uint32_t app_sp = *(volatile uint32_t *)APP_ADDR;        // App 的栈顶
    uint32_t app_pc = *(volatile uint32_t *)(APP_ADDR + 4);  // App 的复位向量

    if (app_sp < 0x20000000 || app_sp > 0x20005000) return;  // 栈指针合法性检查
                                                             // （App 区是空的/残缺的，
                                                             //  这里第一个拦下）

    __disable_irq();                 // 关中断，拆除所有回调
    SysTick->CTRL = 0;               // 停掉滴答

    __set_MSP(app_sp);               // ① 换栈
    SCB->VTOR = APP_ADDR;            // ② 中断向量表重定位！（漏了它就等着死）
    __set_CONTROL(0);                // ③ 回到特权模式、用主栈
    ((void (*)(void))app_pc)();      // ④ 跳！（不再返回）
}
```

Of the four actions, ② is the easiest to miss: **by default the interrupt vector table sits at the start of Flash (the Bootloader's vector table)**. Without relocating it, the first interrupt in the App (say, SysTick) will jump into the Bootloader's interrupt handler — a bizarre symptom that costs hours to track down. When building the App project in Keil, you must change the start address to the App partition in the Target options, update the scatter file to match, and set VTOR in the startup code. All four steps; miss one and you're dead.

The ③ check deserves a word too: if power died mid-upgrade, the App region holds half a firmware, and the stack-top location may be a wild value. Verify "the stack pointer lands in valid SRAM range" first, and if it isn't, **don't jump** — this is the first gate of brick-proofing.

### 2.3 Flags: Only What Is Written Last Counts

The full timeline of an upgrade:

```
Cloud pushes the package → App receives the upgrade notice → sets UPDATE_REQUEST flag → reset
  → Bootloader sees the flag → receives packets, writes Flash (page by page)
  → all data written, verification passed → sets UPDATE_OK flag → reset
  → Bootloader sees OK → jumps to the new App
```

Note the care in the ordering: **UPDATE_OK must be written only after all the data is written**. The other way around — set OK first, then write data — means a mid-write power loss leaves you with "the flag says success, but the App region is half a firmware". Power on, jump into the mangled firmware, bricked. "Write the flag last" is the embedded version of atomic commit: the data is the draft, the flag is the commit button.

Likewise, UPDATE_REQUEST must be cleared promptly after use (the first thing to do upon entering upgrade mode), so the next power-on doesn't wrongly re-enter upgrade mode after the upgrade finishes.

### 2.4 Writing: The Ghost of Unlocking Returns

Part 12 taught the five-step Flash unlock ritual for writing settings. OTA firmware writing is the same ritual, but at a much larger volume (15 KB, erasing page by page, writing halfword by halfword). Let me plant one sentence here: **miss one step of the unlock sequence and the write operation is silently discarded** — no error, no exception, read back and it's still the old data. Remember this ghost. See the Bonus section.

## 3. Hands-On: A Minimal Dual-Project OTA

### Step 1: Two Keil Projects

- **Bootloader project**: an ordinary project, same chip selection, link address untouched (0x08000000);
- **App project**: Options → Target → IROM1 start `0x08004000`, size `0xC000` (the learning version reserves 16 KB for the Bootloader); enable .bin generation (via the fromelf command, or add `fromelf --bin -o ...` in Keil's User options tab).

At the top of the App's `main()`:

```c
SCB->VTOR = 0x08004000;    // 向量表重定位（2.2 的②，App 侧也要做）
```

### Step 2: The Bootloader Main Flow

```c
#define MAGIC_REQUEST   0x5A5A
#define MAGIC_OK        0xA5A5
#define FLAG_ADDR       0x0800FC00          // 用最后一页做标志区

int main(void)
{
    clock_uart_gpio_init();
    flash_unlock();                          // 早解锁，省得忘了

    uint16_t flag = *(volatile uint16_t *)FLAG_ADDR;

    if (flag == MAGIC_OK) {                  // 升级成功：清标志，上新固件
        flash_erase_page(FLAG_ADDR);
        flash_write_halfword(FLAG_ADDR, 0xFFFF);
        jump_to_app();
    }

    if (flag == MAGIC_REQUEST) {             // 有升级任务
        flash_erase_page(FLAG_ADDR);         // 先清请求标志
        ota_receive_and_write();             // 收数据写 App 区（2.4 + 第 12 篇的函数）
        flash_erase_page(FLAG_ADDR);
        flash_write_halfword(FLAG_ADDR, MAGIC_OK);   // ★ 最后才写成功标志
        system_reset();
    }

    /* 平时：倒计时跳 App，按键打断进升级模式（五连击的角色由它客串） */
    uart_puts("boot: press key for OTA, else jump app in 2s\r\n");
    for (int i = 0; i < 20; i++) {
        if (key_pressed()) {
            flash_erase_page(FLAG_ADDR);
            flash_write_halfword(FLAG_ADDR, MAGIC_REQUEST);
            system_reset();
        }
        delay_ms(100);
    }
    jump_to_app();
}
```

### Step 3: A Simplified OTA Transfer

The learning version replaces real OTA protocol with a minimal text protocol for the "firmware data" (the real frame-sequence/offset/CRC machinery is left for you to extend along the same lines):

```
Host (serial assistant / script) sends line by line:
  :ADDRHHLL:DATAHEX\n
Bootloader receives: parse address + data → write halfword → reply 'K'
End line: :DONE\n → Bootloader verifies a few key bytes → sets the OK flag
```

The teaching point isn't the protocol but the **rhythm**: after every few halfwords, mind the Flash programming time; before crossing into a new page, erase it first — it's precisely in these "taken-for-granted" steps that the bug from the Bonus section hides.

### The Lab Script

- [ ] Flash only the App project: after reset the Bootloader counts down and jumps straight to the App, which prints version number v1 (you must flash the Bootloader first, then the App — the order cannot be reversed);
- [ ] Hold the button while powering on: enter upgrade mode, the serial port echoes "waiting for data";
- [ ] Send simulated firmware data (a small array is enough), and receive a 'K' reply for each line;
- [ ] Send :DONE: after reset the Bootloader clears the OK flag and jumps into the "new" App — in the teaching version, just read back the written data to verify consistency. To actually swap firmware, send your compiled App.bin line by line (advanced);
- [ ] **Brick-proofing test**: cut power halfway through the upgrade, power on again — the Bootloader stays in upgrade mode waiting for a reflash, and **never jumps into the half-baked firmware**;
- [ ] **VTOR experiment** (destructive learning): comment out the `SCB->VTOR` line in the App and watch the bizarre crash at the first SysTick interrupt after the jump — then restore it, and appreciate why ② in 2.2 is singled out in red.

## 4. The Original Product (CIU32F003)

The full form of the product's Bootloader — every element in this post has its counterpart:

1. **Partitions**: Bootloader 8 KB (actually uses 4.5 KB) + App 15 KB + a reserved flag/config region, each configured in its own scatter file;
2. **How it enters**: the five-tap gesture (Part 14) sets the OTA flag → a 2-second long beep (Part 15, **reset only after the beep finishes**) → the Bootloader takes over the upgrade; cloud-pushed upgrades travel the same flag path;
3. **Transfer protocol**: the real Tuya OTA protocol — the cloud pushes packets one by one, the Bootloader receives, verifies, and writes them by offset; the UART/frame buffer was enlarged to 512 B for this;
4. **Brick-proofing**: the OK flag written last + the stack-pointer validity check + staying in upgrade mode on failure — all three axes in place;
5. **Version-number discipline** (paying off the foreshadowing from Part 9): the App's `MCU_VER` and the Bootloader's version macro **must match**, incremented in lockstep at every release. When the two sides disagree, the cloud and the MCU's understanding of the version gets out of sync, and the upgrade flow develops paranormal problems.

## 5. Bonus: The Ghost of "Dies After One Frame"

The scene of the product's OTA joint debugging: the cloud starts pushing the package, and the first frame is perfect — received, acknowledged, written, all smooth. From the second frame on, **failure, forever**.

No error code, no HardFault, no abnormal frame. The Bootloader's receive interrupt is still firing (the logs prove it), the data does come in — it just won't get written.

The investigation chain finally pointed at the sentence planted in 2.4: the Flash controller's unlock state is **volatile** — after each program operation completes, the hardware **automatically re-locks**! The first frame's write succeeded with the unlock in place; the moment the first frame finished writing, the lock quietly came back; every write of the second frame was silently discarded. The receive path had no idea, because it only receives — the one doing the writing failed in silence.

The fix was to re-run the full unlock sequence before every write transaction. A one-line bug, a full day of investigation — because of its silence. After this case, the team checklist gained one more entry: **"Unlock unconditionally before every Flash write. Treat it as muscle memory, not as a conditional check."**

Part 10 said "silent failure is the most expensive type of bug in embedded systems"; this post is the second exhibit. After two instances you should be able to spot the pattern: **any operation where "the hardware decides success or failure on your behalf, and the software has no way to sense it" (Flash writes, entering low-power mode, clock switching) deserves a line of verification or logging next to the code** — expensive, but two orders of magnitude cheaper than debugging after the fact.

## 6. Next Up

The code is written: it runs, it sleeps, it upgrades. But between "it runs" and "dare to ship" lies a production line. The next post, Part 17, "Production Testing and Mass Production": how the factory quickly decides whether each unit is good (production-test route scanning, full-display visual inspection, a 14-item smoke checklist), how the release process works, and that design where "the unit beeps once per second in production-test mode" — the last piece of the puzzle, the prelude to the finale.

---

*This series is adapted from a real mass-production project; every war story comes from actual development. Reading in order is recommended — the parts depend on each other.*
