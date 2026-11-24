---
title: "01 · 磨刀：TuyaOS 开发环境搭建与第一次烧录"
description: "搭好 TuyaOS Zigbee 开发环境：解剖两段式构建、读懂固件身份证 app_config.yaml、用 BDT 烧录第一版固件，并在 PC4 模拟串口看到四行 init log。"
pubDate: 2026-11-24
lang: zh
translationKey: zigbee-meter-part1
tags: [嵌入式, Zigbee, 教程]
series: zigbee-meter
seriesOrder: 1
category: embedded
---

> 目标：从零搭好环境，编译出第一个 bin，烧进芯片，看到串口 log

---

## 一、拿到开发包之后先别急着点“Build”

TuyaOS 的 Zigbee 子设备开发包是一个完整的“压缩世界”：工具链、RTOS、Zigbee 协议栈、预编译库、构建脚本全部内置。解压缩之后的目录结构大致是：

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

值得先建立的两个直觉：

1. **你写的应用只是冰山一角**。编译时链接进来的 `lib_router_tal_telink_zigbee_release.a`、`lib_router_tkl_telink_zigbee_release.a`（TuyaOS 的 TAL/TKL 层）和 `libzb_router.a`（Telink 原厂 Zigbee 协议栈）才是大头。Zigbee 协议栈本身一行源码都看不到，只能通过头文件里的 API 使用它——这是商业 SDK 的常态，习惯就好。
2. **构建是两段式的**：Python 脚本先扫描源码生成 Makefile，再调用内置的 TC32 工具链执行 make。新增 `.c` 文件不需要手改任何 Makefile，构建脚本会递归扫描应用目录和组件目录自动加入。

## 二、唯一的前置依赖：一个能跑的 python3

整个构建系统唯一的外部依赖是 **Python 3.6~3.8**，而且脚本里调用的命令名是 `python3`。

Windows 用户这里有个经典坑：装完 Python 之后系统里只有 `python.exe`，没有 `python3.exe`。两个解法：

- 把 `python.exe` 复制一份重命名为 `python3.exe`（简单粗暴，本系列采用）；
- 或者打开“应用执行别名”里的 `python3.exe`（Store 版 Python 的方案）。

验证：

```bash
python3 --version    # Python 3.8.x 即可
```

> 版本不要高于 3.8——构建脚本用到了一些在老版本上验证过的语法行为，Python 3.10+ 曾出现过兼容问题。

## 三、构建命令解剖

在开发包的 TuyaOS 软件目录下执行：

```bash
# 构建
python3 build_app.py apps/<应用目录> <应用名> 1.0.0 build
# 清理
python3 build_app.py apps/<应用目录> <应用名> 1.0.0 clean
```

Windows 下也可以用同目录自带的 `build_app.bat`。四个参数依次是：

| 参数 | 值 | 含义 |
|------|-----|------|
| 应用路径 | `apps/<应用目录>` | 源码所在目录 |
| 应用名 | 与应用目录同名 | **长度 ≤ 32 字符**，超了直接编译失败；如果要走网关产测，需 ≤ 25 |
| 版本 | `1.0.0` | 固件版本号，OTA 比对就靠它 |
| 命令 | `build` / `clean` | |

`build_app.py` 内部干两件事：

1. **prepare 阶段**：扫描应用目录和组件目录下所有 `.c/.h`，生成 `_build/` 目录——里面有 makefile、源文件列表、`app_config.h`（从 `app_config.yaml` 自动生成）；
2. **build 阶段**：调用内置 TC32 工具链执行 make（工具链随开发包附带，无需安装）。

所以记住两条纪律：

- **首次构建必须走这个脚本**，它会生成 `_build/` 和 Makefile；之后如果装了 make 环境可以进 `_build/` 直接 `make -j` 加速迭代；
- **`_build/` 里的一切禁止手改**，改了下次构建也会被覆盖。

编译的关键宏（看 `_build/` 生成的 makefile 可以确认）：

```
MCU_CORE_8258=1  ROUTER=1  TUYA_ZG_ROUTER=1  TUYA_SKD_DBG=1
TAL_UART_MODE_CACHE=1  TAL_UART_CACHE_NUM=2
```

编译选项是 `-O2 -ffunction-sections -fdata-sections -fshort-enums -std=gnu99`，链接脚本由 SDK 的 vendor 库提供。

一次完整构建的日志尾部会列出生成的产物——看到 QIO/UG 两个 bin 同时出现即为成功。

## 四、固件元数据：app_config.yaml 是唯一真相

打开应用目录下的 `app_config.yaml`，这是固件“身份证”的唯一来源：

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

几行的分量都不轻：

- `device_role: "router"` —— 设备是 Zigbee 路由器（常供电、可中继、不睡眠）。如果你的应用是电池传感器，这里就是 `sleep_end_dev`，SDK 链接的是另一套库（为休眠设备准备的 sleep_device 库）。
- `model_id: "TS0601"` —— 写入 Basic 簇 0x0000 的属性 0x0005。涂鸦网关看到这个熟悉的型号就知道走透传 DP 流程。
- `manufacture_name: "_TZE2041000000_p3g8xiug"` —— Tuya 模式下 Basic 簇属性 0x0004 的私有定义，格式是 `能力值_PID`。这个 `_TZE204...` 前缀告诉网关“我是涂鸦系设备”，后面的 `p3g8xiug` 是 IoT 平台上的产品 ID，网关靠它把设备关联到你的云产品。**烧录前必须先在涂鸦 IoT 平台建好这个产品拿到 PID**，否则设备入网后云端不认识。

构建脚本由这个 yaml 自动生成 `app_config.h`（文件头写着 *Automatically-generated, Do not edit!*）。**想改配置就改 yaml，千万别直接改 .h**——改了下次构建会被覆盖，而且你很可能改了 yaml 又忘了 .h 里的旧值，两份配置打架。

yaml 里还有一组被注释掉的 “Zigbee 标准模式” 配置块（用标准 ManufacturerName/ModelIdentifier 属性）。两套配置互斥，同一时刻只能启用一组。本项目走 Tuya 模式。

## 五、烧录：QIO 与 UG 两种 bin

构建产物在应用的输出目录里：

| 文件 | 用途 |
|------|------|
| `<应用名>_QIO_1.0.0.bin` | **生产烧录**：完整镜像（含 bootloader），用 BDT 工具烧到 0x0 |
| `<应用名>_UG_1.0.0.bin` | **OTA 升级**：空中升级镜像（第 12 篇的主角） |

烧录工具是 **BDT.exe**（Telink Burn/Debug Tool，开发包自带）：

1. 模组通过 SWS（单线调试）接口连上烧录器（ZT3L 模组的烧录口一般是 3.3V/SWS/GND 三根线）；
2. BDT 选择芯片型号 TLSR8258，加载 QIO bin，擦除 + 烧录 + 校验；
3. 拔电重启，设备就跑起来了。

> ⚠️ **一个会影响你调试体验的坑**：未经涂鸦授权的 BDT 烧录固件**最多运行 7 天**就会停止工作。这是涂鸦的商业授权机制，开发调试无所谓（大不了重新烧），但正式产品必须走涂鸦的授权烧录工具把授权信息写进 Flash。详见第 13 篇的量产章节。

## 六、第一行 log：调试串口在哪里？

烧完重启，第一件事是找到 log 输出口。TLSR8258 平台的调试打印不是走 UART0，而是 **PC4 引脚的 GPIO 模拟串口**（Telink SDK 的 `Tl_printf`），波特率 115200、8N1。配置入口是应用层实现的 `app_print_get_cfg()` 回调：

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

而日志系统的初始化在 `tuya_init_first()` 里：

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

用 USB 转 TTL 模块接 **PC4 → RXD**，115200 8N1 打开串口助手，重启设备，应该能看到四行 init log（每行以 `/*********` 开头），依次对应 first / second / third / last 四个初始化阶段——开头一行是：

```
/*********first init*********/
```

这四行是本系列的“Hello World”。

> 这四个 init 的含义先不展开，第 02 篇整篇都在讲它们。但注意一个细节：**此时 UART0 虽然初始化成了 115200，8258 平台的 log 并不走它**——UART0 在启动后期会被重新配置为 9600 8E1 交给计量芯片 HLW8110（`app_uart_init()`），那是一场好戏，第 07 篇开讲。

## 七、踩坑实录：环境搭建阶段的三个高频问题

**坑 1：`python3 不是内部或外部命令`。**
90% 的首次构建失败是这个。回到第二节，复制 `python.exe` 为 `python3.exe`，重新开终端（PATH 缓存）。

**坑 2：构建报 `Application name too long`。**
应用名（第 2 个参数）超过 32 字符。缩写它，但要同步改 `apps/` 下的目录名，两处必须一致。

**坑 3：烧录后完全无 log。**
按顺序排查：烧的是不是 QIO bin（UG 不能直接烧）→ SWS 线接触（Telink 的烧录口对接触敏感，压紧或换线）→ 串口接的是不是 PC4 而不是 UART0 的 TX → 波特率 115200。本项目的 log 从启动到运行一直在 PC4，不存在“后期换波特率”的问题。

## 八、小结

这一篇我们只做了三件事：装好 python3、跑通 `build_app.py`、用 BDT 烧录并在 PC4 上看到四行 init log。但地基里埋了三个重要的认知：

1. TuyaOS 是“两段式构建”：Python 生成 Makefile → TC32 工具链编译，**应用名 ≤ 32 字符，`_build/` 不可手改**；
2. `app_config.yaml` 是固件身份证的唯一来源，PID 必须先在涂鸦 IoT 平台注册；
3. 日志走 **PC4 模拟串口**（115200），UART0 是计量芯片的私有财产。

下一篇进入 TuyaOS 的世界观：四个 init 回调到底谁先谁后，Zigbee 的“端点—簇—属性”三层模型怎么理解，以及怎么用十几行代码把设备注册进 Zigbee 网络。

---

*上一篇：[00 开篇] · 系列目录 · 下一篇：[02 骨架：TuyaOS 四段式生命周期与 Zigbee 设备注册]*
