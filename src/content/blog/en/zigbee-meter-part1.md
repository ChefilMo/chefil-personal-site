---
title: "01 · Sharpening the Knife: Setting Up the TuyaOS Dev Environment and Your First Flash"
description: "Set up the TuyaOS Zigbee dev environment from scratch: dissect the two-stage build, read the firmware's ID card app_config.yaml, flash your first firmware with BDT, and see four lines of init log on the PC4 bit-banged UART."
pubDate: 2026-11-24
lang: en
translationKey: zigbee-meter-part1
tags: [Embedded, Zigbee, Tutorial]
series: zigbee-meter
seriesOrder: 1
category: embedded
---

> Goal: Set up the environment from scratch, compile your first bin, flash it into the chip, and see the serial log.

---

## 1. After You Get the Dev Package, Don't Rush to Hit “Build”

The TuyaOS Zigbee sub-device development package is a complete “world in a box”: toolchain, RTOS, Zigbee protocol stack, precompiled libraries, and build scripts — all bundled in. After extracting it, the directory layout looks roughly like this:

```
开发包根目录/
├── hardware/           # 芯片数据手册、ZTU/ZT3L 模组规格书
├── pc/tools/           # BDT.exe —— Telink 官方烧录/调试工具
├── 软件目录/
│   ├── apps/           # 各应用工程（我们的电表应用就在其中）
│   ├── components/     # 开源组件
│   ├── include/        # TuyaOS API 头文件（tkl_* / tal_*）
│   ├── libs/           # 预编译 .a 库（tuya_lib + vendor_lib）
│   ├── scripts/        # 配置脚本
│   ├── tools/          # 构建脚本 + OTA 工具 + TC32 工具链
│   └── vendor/         # Telink 原厂 SDK
└── SDK 开发文档目录/
```

Two intuitions worth building up front:

1. **Your application is just the tip of the iceberg**. The real bulk is linked in at compile time: `lib_router_tal_telink_zigbee_release.a`, `lib_router_tkl_telink_zigbee_release.a` (the TuyaOS TAL/TKL layers) and `libzb_router.a` (Telink's original Zigbee protocol stack). You won't see a single line of the Zigbee stack's source code — you can only use it through the APIs declared in the headers. That's the norm for commercial SDKs; get used to it.
2. **The build is two-stage**: a Python script first scans your source and generates a Makefile, then invokes the bundled TC32 toolchain to run make. Adding a new `.c` file requires zero manual Makefile edits — the build script recursively scans the app and component directories and picks it up automatically.

## 2. The Only Prerequisite: A Working python3

The build system's one and only external dependency is **Python 3.6~3.8**, and the command name the scripts invoke is `python3`.

Classic Windows trap here: after installing Python, your system has `python.exe` but no `python3.exe`. Two fixes:

- Copy `python.exe` and rename the copy to `python3.exe` (brutal but effective — this series goes with that);
- Or enable the `python3.exe` “App Execution Alias” (the Store-version Python route).

Verify:

```bash
python3 --version    # Python 3.8.x 即可
```

> Don't go above 3.8 — the build scripts rely on some syntax behaviors validated on older versions, and Python 3.10+ has caused compatibility issues.

## 3. Anatomy of the Build Command

Run this from the TuyaOS software directory of the dev package:

```bash
# 构建
python3 build_app.py apps/<应用目录> <应用名> 1.0.0 build
# 清理
python3 build_app.py apps/<应用目录> <应用名> 1.0.0 clean
```

On Windows you can also use the bundled `build_app.bat` in the same directory. The four arguments are, in order:

| Argument | Value | Meaning |
|------|-----|------|
| App path | `apps/<app directory>` | Where the source code lives |
| App name | Same as the app directory | **Length ≤ 32 characters** — exceed it and the build fails outright; if you need gateway factory testing, keep it ≤ 25 |
| Version | `1.0.0` | Firmware version number; OTA comparison depends on it |
| Command | `build` / `clean` | |

Internally, `build_app.py` does two things:

1. **prepare stage**: scans all `.c/.h` files under the app and component directories and generates a `_build/` directory — containing the makefile, the source file list, and `app_config.h` (auto-generated from `app_config.yaml`);
2. **build stage**: invokes the bundled TC32 toolchain to run make (the toolchain ships with the dev package — nothing to install).

So remember two rules of discipline:

- **The first build must go through this script** — it generates `_build/` and the Makefile. Afterwards, if you have a make environment installed, you can cd into `_build/` and run `make -j` directly to speed up iteration;
- **Never hand-edit anything in `_build/`** — your changes will be overwritten on the next build anyway.

The key compile-time macros (you can confirm them in the makefile generated under `_build/`):

```
MCU_CORE_8258=1  ROUTER=1  TUYA_ZG_ROUTER=1  TUYA_SKD_DBG=1
TAL_UART_MODE_CACHE=1  TAL_UART_CACHE_NUM=2
```

Compile options are `-O2 -ffunction-sections -fdata-sections -fshort-enums -std=gnu99`; the linker script is provided by the SDK's vendor library.

The tail of a full build log lists the artifacts — seeing both the QIO and UG bins appear means success.

## 4. Firmware Metadata: app_config.yaml Is the Single Source of Truth

Open `app_config.yaml` in the app directory — it's the sole source of the firmware's “ID card”:

```yaml
Firmware_Information:
  description: "this is a demo project"
  device_role: "router"        # router / sleep_end_dev
  image_type:
  manufacture_id:
  model_id: "TS0601"           # 涂鸦生态约定俗成的透传设备型号
  manufacture_name: "_TZE2041000000_p3g8xiug"   # 能力值 + pid
  module_name: ""
  chip_id: ""                  # TLSR8258F1KET
```

None of these lines is light-duty:

- `device_role: "router"` — the device is a Zigbee router (mains-powered, can relay, never sleeps). If your app were a battery-powered sensor, this would be `sleep_end_dev`, and the SDK would link a different set of libraries (the sleep_device libraries built for dormant devices).
- `model_id: "TS0601"` — written into attribute 0x0005 of the Basic cluster 0x0000. When a Tuya gateway sees this familiar model ID, it knows to run the pass-through DP flow.
- `manufacture_name: "_TZE2041000000_p3g8xiug"` — a private definition for attribute 0x0004 of the Basic cluster in Tuya mode, in the format `capability_PID`. The `_TZE204...` prefix tells the gateway “I'm a Tuya-ecosystem device”, and the trailing `p3g8xiug` is the product ID from the Tuya IoT Platform — the gateway uses it to associate the device with your cloud product. **You must create this product on the Tuya IoT Platform and get the PID before flashing**, otherwise the cloud won't recognize the device after it joins the network.

The build script auto-generates `app_config.h` from this yaml (the file header reads *Automatically-generated, Do not edit!*). **To change configuration, edit the yaml — never the .h directly** — or the next build will overwrite it, and worse, you'll probably edit the yaml while forgetting the stale value sitting in the .h, leaving two configs fighting each other.

The yaml also contains a commented-out “Zigbee standard mode” config block (using the standard ManufacturerName/ModelIdentifier attributes). The two config sets are mutually exclusive — only one can be enabled at a time. This project uses Tuya mode.

## 5. Flashing: The QIO and UG Bins

Build artifacts land in the app's output directory:

| File | Purpose |
|------|------|
| `<app name>_QIO_1.0.0.bin` | **Production flash**: complete image (including the bootloader), flashed to 0x0 with the BDT tool |
| `<app name>_UG_1.0.0.bin` | **OTA upgrade**: over-the-air image (the star of Part 12) |

The flashing tool is **BDT.exe** (Telink Burn/Debug Tool, bundled with the dev package):

1. Connect the module to the flasher via the SWS (single-wire debug) interface (the ZT3L module's flashing port is usually three wires: 3.3V/SWS/GND);
2. In BDT, select chip model TLSR8258, load the QIO bin, then erase + flash + verify;
3. Power-cycle, and the device is up and running.

> ⚠️ **A trap that will mess with your debugging experience**: firmware flashed with BDT without Tuya authorization **stops working after at most 7 days**. This is Tuya's commercial licensing mechanism. For development and debugging it's no big deal (worst case, reflash), but a shipping product must go through Tuya's authorized flashing tool to write the license info into Flash. See the mass-production chapter in Part 13 for details.

## 6. The First Line of Log: Where's the Debug UART?

After flashing and rebooting, the first order of business is finding the log output. On the TLSR8258 platform, debug prints don't go through UART0 — they go through **a GPIO bit-banged UART on pin PC4** (Telink SDK's `Tl_printf`), at 115200 baud, 8N1. The configuration entry point is the `app_print_get_cfg()` callback implemented at the application layer:

```c
BOOL_T app_print_get_cfg(UINT8_T *print_type, UINT8_T *disable_irq, GPIO_PORT_PIN_T *gpio)
{
    gpio->port = PORT_C;
    gpio->pin  = PIN_4;          /* ← log 从 PC4 出 */
    *print_type = 0;
    *disable_irq = 1;
#ifdef UART_PRINTF_MODE
    return 1;
#else
    return 0;
#endif
}
```

And the log system is initialized inside `tuya_init_first()`:

```c
OPERATE_RET tuya_init_first(VOID_T)
{
    TAL_UART_CFG_T uart_cfg = { .rx_buffer_size = 256, ... 115200 8N1 ... };
    tal_uart_init(USER_UART0, &uart_cfg);          /* UART0 先给 log 用一程 */

#if (ENABLE_TAL_LOG == 1)
#ifdef MCU_CORE_8258
    /* 8258 平台：log 走 Tl_printf（PC4 模拟串口），与 UART0 无关 */
    tal_log_create_manage_and_init(TAL_LOG_LEVEL_DEBUG, 128, (CONST TAL_LOG_OUTPUT_CB)Tl_printf);
#endif
#endif
    ...
}
```

Hook a USB-to-TTL adapter to **PC4 → RXD**, open your serial tool at 115200 8N1, reboot the device, and you should see four lines of init log (each starting with `/*********`), corresponding in order to the four init stages: first / second / third / last — the opening line being:

```
/*********first init*********/
```

These four lines are this series' “Hello World”.

> We'll leave the meaning of these four inits for later — Part 2 is entirely dedicated to them. But note one detail: **even though UART0 has been initialized to 115200 at this point, the 8258 platform's log does not go through it** — later in startup, UART0 gets reconfigured to 9600 8E1 and handed over to the metering chip HLW8110 (`app_uart_init()`). That's a great show, and it opens in Part 7.

## 7. Pitfall Report: Three High-Frequency Issues During Environment Setup

**Pitfall 1: `python3 is not recognized as an internal or external command`.**
90% of first-build failures are this one. Go back to Section 2, copy `python.exe` as `python3.exe`, and open a new terminal (PATH cache).

**Pitfall 2: build reports `Application name too long`.**
The app name (the 2nd argument) exceeds 32 characters. Abbreviate it — but remember to rename the directory under `apps/` to match; the two must be identical.

**Pitfall 3: completely no log after flashing.**
Troubleshoot in order: are you flashing the QIO bin (the UG can't be flashed directly)? → SWS wiring contact (Telink's flashing port is touchy — press it firmly or swap the wire) → is the serial adapter on PC4 rather than UART0's TX? → baud rate 115200. In this project, the log stays on PC4 from boot through runtime — there's no “baud rate changes later” situation.

## 8. Summary

In this part we only did three things: install python3, get `build_app.py` running, and flash with BDT to see four lines of init log on PC4. But three important understandings were buried in the foundation:

1. TuyaOS uses a “two-stage build”: Python generates the Makefile → the TC32 toolchain compiles. **App name ≤ 32 characters, `_build/` is off-limits to hand edits**;
2. `app_config.yaml` is the single source of the firmware's ID card — the PID must be registered on the Tuya IoT Platform first;
3. Logs go through the **PC4 bit-banged UART** (115200); UART0 is private property of the metering chip.

Next up, we enter TuyaOS's world view: what order the four init callbacks actually run in, how to wrap your head around Zigbee's three-layer “endpoint–cluster–attribute” model, and how to register a device into the Zigbee network with a dozen lines of code.

---

*Previous: [Part 00 Opening] · Series Index · Next: [Part 02 Skeleton: TuyaOS Four-Stage Lifecycle and Zigbee Device Registration]*
