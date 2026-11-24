---
title: "Part 17: Production Test and Mass Production — 30 Seconds per Unit, and the Design of the \"Beep Every Second\""
description: "Between \"it runs\" and \"it's ready to ship\" lies a production line: the four design principles of production testing, how the 0x0e channel scan works, the production-test mode checklist, and the release discipline from smoke checklist to golden sample."
pubDate: 2026-11-24
lang: en
translationKey: wifi-thermometer-part17
tags: [Embedded, STM32, Tutorial]
series: wifi-thermometer
seriesOrder: 17
category: embedded
---

> The code runs, sleeps, and upgrades — but between "it runs" and "it's ready to ship" lies an entire production line. The factory floor is nothing like the dev bench: operators aren't engineers, the takt time is measured in seconds, pass/fail must be visible and audible, and a bad unit must be stopped on the spot.
> This is the most product-minded post of the series: **how to design a production test that lets an ordinary person on the assembly line judge whether a unit is good or bad within seconds**.

---

## 1. Goals and the Payoff

**Goal**: the learning build implements a simplified "production-test mode" — on power-on it automatically runs a self-test sequence: all LCD segments on → short beep → self-test report over UART (sensor online, key continuity, ADC reading). Physically unplug the sensor and you can watch the report flip from PASS to FAIL.

**What you'll understand after this**: the four design principles of production testing (fast, unambiguous, one judgment per power-on, no dependence on the public internet), the principle of the 0x0e channel scan, and the discipline of a release process.

## 2. Theory in 10 Minutes

### 2.1 What Production Testing Answers

Production testing doesn't answer "is this unit perfect" — it answers a single binary question: **can this unit ship**. Every design decision revolves around four constraints:

1. **Fast**: the line takt may be only 10–30 seconds per unit, so test items must be designed by the second, and merged where possible (check everything in one power-on);
2. **Unambiguous**: the result must be visible-and-audible level — one beep for pass, beep-beep-beep for fail; the operator shouldn't have to look at a serial port. This is the positive version of the "factory noise" bonus from Part 15: the production-test prompt tone must be **loud enough and distinct enough**;
3. **One judgment per power-on**: each unit makes exactly one judgment per power-on, never a second one (guards against misjudgment and takt-time runaway), and the verdict is held until power-off — production-test mode is "enter and stay, exit by reset";
4. **No dependence on the public internet**: a real production line may have no external network. The product's core test item (Wi-Fi RF quality) is done entirely on the LAN with a **designated test router** (SSID fixed as `tuya_mdev_test`), and the cloud is not involved.

### 2.2 Wi-Fi Production Test: The Principle of the 0x0e Scan

How do you verify on the line that "this unit's Wi-Fi module and antenna are good"? The product's answer is the Tuya protocol's **0x0e production-test scan** command:

```
MCU → 模组：55 AA 03 0E 00 00 10
                    ↑命令字0x0E，无数据区
模组 → MCU：扫描环境中是否存在 SSID "tuya_mdev_test"
            回复：result(找到与否) + rssi(信号强度)
判定：result==1 且 rssi ≥ 80 → Wi-Fi 链路合格
```

Why is the rssi threshold 80 instead of "just needs to connect"? Because the distance between the module and the router on the line is **fixed and known** — at that distance, the signal strength has an expected range. Weaker than expected means this unit's antenna is cold-soldered, the module is a dud, or the housing assembly went wrong. **The essence of production testing is comparing against a "known-good baseline"**, and the rssi threshold is that baseline made quantitative.

There's a timing subtlety: the 0x0e must not be sent the instant power comes on. A Wi-Fi module needs several seconds to boot, handshake, and stabilize, so the product rule is: **only after Wi-Fi has been powered on for a cumulative 5 seconds, and the module has reported its network status at least once**, do you send the 0x0e — send it too early and the module ignores you, and a good unit gets misjudged as bad Wi-Fi.

### 2.3 The Behavior Checklist of Production-Test Mode

Once the verdict passes, the unit enters production-test mode, and that mode is itself an "operable test bench":

- **Beep every second**: status indication — dozens of units sit on the line together, and the operator can tell which ones are in test mode just by listening (hearing is the channel that occupies neither hands nor eyes);
- **No Deepstop**: it stays awake and operable at all times, and the whole-unit current sits in the wake state (which is also corroborating evidence that "Wi-Fi is off" — the current is clearly lower than in the networked state);
- **Wi-Fi off**: the scan is done, and the module is powered down to save energy;
- **Short-press the key → all LCD segments on for 5 seconds**: visual check of every stroke segment; missing segments (cold solder / cracked glass / driver problem) are visible on the spot — the "all-segments test" from Part 13 extends from the dev bench onto the line;
- **Low-battery icon refreshes in real time**: turn the bench supply down below the threshold, and the icon lights up or goes dark within about a second, verifying the battery-detection path;
- **No alarm beeps**: alarms are deliberately not triggered in production-test mode, so the line doesn't beep all over the place;
- **Exit = reset**: there's no complicated "exit production test" operation; power-cycle it and you're back to the normal product.

Note the design aesthetic of this checklist: **every production-test action is simultaneously a test item**. The beep (buzzer works), all-segments (LCD works), the icon following the voltage (ADC works), no Deepstop (low-power path works)... Production testing is not extra test code bolted on — it's the existing features re-choreographed for the line scenario.

## 3. Hands-On Code (Simplified Production Test for the Learning Build)

The learning build has no Wi-Fi module, so production testing focuses on the "power-on self-test sequence" — three acts, one uninterrupted flow:

```c
void factory_self_test(void)
{
    /* 第一幕：全显（LCD 自检） */
    lcd_all_segments_on();               // 1602 就逐格写满 '8' 字符
    beep_start(200, 200, 0);             // 一声短响（蜂鸣器自检）

    /* 第二幕：逐项自检，攒报告 */
    bool sensor_ok = (gxht40_read(&t, &h) == 0);     // I2C 链路 + 传感器
    bool key_ok    = wait_key_with_timeout(3000);    // 等操作员按键 3s
    uint16_t raw   = adc_read(1);                    // NTC 分压链路
    bool ntc_ok    = (raw > 100 && raw < 4000);      // 不在开短路区

    delay_ms(2000);                      // 全显保持 2 秒给目检留时间
    lcd_all_segments_off();

    /* 第三幕：串口输出报告（PASS/FAIL 一目了然） */
    uart_puts("=== FACTORY TEST ===\r\n");
    uart_puts(sensor_ok ? "SENSOR: PASS\r\n" : "SENSOR: FAIL\r\n");
    uart_puts(key_ok    ? "KEY   : PASS\r\n" : "KEY   : FAIL(timeout)\r\n");
    uart_puts(ntc_ok    ? "NTC   : PASS\r\n" : "NTC   : FAIL\r\n");

    /* 学习版没有真正的产测态，报告完继续正常流程；
       产品的产测态见原版对照 */
}
```

Acceptance script:

- [ ] Fully assembled: the three acts run in order, and the serial report is all PASS;
- [ ] Unplug the GXHT40 and reboot: the report shows SENSOR: FAIL — **the resolving power of a production test under fault injection**;
- [ ] Don't press the key after power-on: after 3 seconds, KEY: FAIL(timeout) — a timeout is itself a verdict; it never waits forever (the production-test version of "every wait must have a timeout" from Part 6);
- [ ] Short both ends of the NTC (simulating a probe short): NTC: FAIL — the open/short protection from Chapter 4 is reused directly in production testing.

## 4. The Original Product (CIU32F003)

Scaling the learning-build mindset up to the full product, production testing has three layers:

**Layer one: the 0x0e RF test** (detailed above). Two more product details: during the scan wait, the **UART window is extended** — while the 0x0e reply hasn't arrived, the unit must not enter Deepstop, or the reply will get cut off (truncation again — the old friend from Parts 2/5/15); and the rssi threshold was raised from 60 to 80 during trial production — the lower threshold had let through a batch of "weak antenna but still connectable" borderline units, which dropped offline as soon as the router in the user's home was a bit farther away. The complaints taught us a lesson.

**Layer two: production-test mode** (the full checklist from 2.3). The product adds one more rule: during production testing, **a full measurement runs about once per second** (temperature, humidity, and battery all sampled), and the LCD keeps refreshing — the operator puts the unit into a temperature chamber or in front of an air-conditioner vent and can see the readings change directly; the health of the sensor chain is obvious at a glance.

**Layer three: the full smoke checklist**. Dev-side verification is a 14-item checklist (Wi-Fi power on/off, serial waveform, I2C ACK, NTC, battery voltage, LPTIM period, Deepstop current, panel DPs, long-press to enter pairing, five-press OTA, the full OTA upgrade flow, buzzer, production test, and "no test router → don't enter production test") — each item a checkable acceptance statement. **The value of the checklist is not in "running it once" but in "re-running it after every release"**: it is the product's regression-test foundation.

**Release process** (tying off the foreshadowing from Parts 9 and 16): bump the version number in both places (App `MCU_VER` and the Bootloader version macro) → build the two projects in order → flash both hex files (Bootloader + App) → append a version record → all 14 checklist items pass → seal a golden sample. Any shortcut (the most common one: forgetting to sync the version numbers) guarantees spooky gremlins somewhere down the OTA chain.

## 5. Bonus: The "Origin" of 0x0e — An Abandoned SDK Feature

Buried in the trimming table from Part 9 was a row for `WIFI_TEST_ENABLE`: the SDK ships with its own Wi-Fi production-test feature, and the product cut it. The reason can finally be told in full: **the command word used by the SDK's production test conflicts with DP reporting** — in the low-power protocol's command-word space, the SDK's built-in production-test command collides with normal business frames; enabling it means certain normal frames get misparsed as production-test frames. Between "protocol correctness" and "using the ready-made feature," the product chose the former: disable the SDK's production test, and reimplement it with the protocol's official production-test command word **0x0e**.

The universal lesson of this trade-off: **what an SDK gives you is the correct answer for the average scenario, not the correct answer for your scenario**. When an SDK feature conflicts with your product's constraints, rolling your own is nothing to be ashamed of — what's shameful is knowing about the conflict and forcing the SDK anyway, leaving the spooky problems for post-launch customer support.

A second small bonus, about the "beep every second": the first version didn't have it, production testing ran silently, and the line once suffered an incident where "the operator thought the unit had crashed and power-cycled it repeatedly." After the periodic prompt tone was added, the misunderstanding vanished — **state visibility (even via the auditory channel) is a meta-rule of interaction design**, as true for operators as it is for users.

## 6. Next Up

The production test passed, the goods shipped, and the series reaches its final post. Part 18, "Graduation Review": back to that 3 KB — we'll lay the resource ledger out on the table and see where every KB learned over 18 posts was spent; we'll draw the 95 pits as a map and mark which ones run deepest; and finally, we'll talk about what to learn next after finishing this product. See you at the finale.

---

*This series is adapted from a real mass-production project; every pitfall recorded here comes from real development. Reading in order is recommended, as the posts build on each other.*
