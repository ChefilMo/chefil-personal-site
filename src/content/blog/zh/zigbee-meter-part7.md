---
title: "07 · 感知（下）：HLW8110 UART 异步状态机与 UART0 之争"
description: "驱动 HLW8110 异步读取 C 相数据：A5 帧协议、环形缓冲、step 表状态机，并复盘一场持续 14 小时的功率冻结悬案。"
pubDate: 2026-11-24
lang: zh
translationKey: zigbee-meter-part7
tags: [嵌入式, Zigbee, 教程]
series: zigbee-meter
seriesOrder: 7
category: embedded
---

> 目标：驱动 HLW8110 读出 C 相数据，理解为什么 UART 驱动必须用异步状态机，并复盘一场持续 14 小时的"功率冻结"悬案
> ⚠️ 本篇是全系列技术密度最高的一篇

---

## 一、HLW8110：单通道的 UART 隐士

HLW8110 是 HLW8112 的单通道姊妹型号：只有一个电流通道，负责 C 相。寄存器地址表、换算公式、系数区（0x70-0x77）和 8112 完全一致——第 06 篇学的知识这里全部复用。真正的差异在通信接口：**UART，9600bps，8E1（偶校验）**。

UART 接口的计量芯片有一个让嵌入式工程师血压升高的特性：**一问一答，节奏慢，还不能并发**。读一个寄存器的完整交互：

```
设备 ──► HLW8110:  A5 <reg_addr>           （2 字节，请求读）
设备 ◄── HLW8110:  <N 字节数据> <1字节CS>  （N+1 字节，应答）
```

9600bps 下每字节传输约 1.04ms。读一个 3 字节寄存器：发 2 字节（2ms）+ 等芯片处理 + 收 4 字节（4ms），一来一回接近 10ms。而一次完整采集要读 7 个寄存器（电流/电压/功率/电量/频率/相角/PF）+ 3 个健康检查寄存器 = **10 次交互 ≈ 100ms**。

100ms 是什么概念？如果像 8112 那样同步阻塞调用，主循环和 Zigbee 协议栈要陪你冻结 100ms——看门狗会亲切地帮你重启。所以 8110 的驱动从第一行代码起就注定是异步的。**这就是第 06 篇结尾埋的问题：为什么 SPI 可以同步、UART 必须异步？答案就是时间——SPI 一次事务 200us，UART 一次事务 10ms，差了两个数量级。**

## 二、UART 帧格式：A5 帧头与不对称校验和

HLW8110 的 UART 协议：

**读寄存器**（2 字节）：

```
[0] = 0xA5              帧头
[1] = 寄存器地址         bit7=0 表示读
```

应答：`寄存器数据（N 字节，大端） + 1 字节校验和`，总长 = N + 1。

**写寄存器**（2 + N + 1 字节）：

```
[0] = 0xA5
[1] = 寄存器地址 | 0x80   bit7=1 表示写
[2..2+N-1] = 数据（大端，手动字节翻转）
[2+N] = 校验和
```

**校验和算法有一个极易讲错的细节——读和写不对称**：

```c
/* 写校验和：只对发送帧自身求和 */
CS = ~(TxBuf[0] + TxBuf[1] + ... + TxBuf[len-2]) & 0xFF;

/* 读校验和：要把发送帧的前 2 字节（帧头+地址）也算进去！ */
CS = ~(RxBuf[0] + ... + RxBuf[N-1] + TxBuf[0] + TxBuf[1]) & 0xFF;
```

为什么读校验要把请求帧加进去？因为 HLW8110 收到读请求后，把"请求"和"应答"当成一个逻辑事务做校验——它算的是 `~(请求 + 应答)`。你如果只对应答求和，校验永远不会通过。这种"厂商自定义的怪癖"没有为什么，只有看官方例程或示波器抓包。

**专用命令帧**（4 字节固定格式 `A5 EA xx CS`，无应答）：

| 命令 | 帧 | 函数 | 作用 |
|------|-----|------|------|
| 打开写保护 | `A5 EA E5 CS` | `Uart_HLW8110_WriteREG_EN` | 允许写寄存器 |
| 关闭写保护 | `A5 EA DC CS` | `Uart_HLW8110_WriteREG_DIS` | 禁止写寄存器 |
| 选 A 通道 | `A5 EA 5A CS` | `Uart_HLW8110_Set_Channel_A` | PF/相角计算用哪个通道 |
| 软复位 | `A5 EA 96 CS` | `Uart_HLW8110_Reset` | 芯片复位（本项目未使用） |

数据字节序用 union 手动翻转保证大端：`u8_TxBuf[i+2] = Temp_u32_a.byte[len-1-i]`。这是为多平台移植留下的防御——不同 MCU 的 union 字节布局不同，手动翻字节永远是对的。

## 三、UART0 的归属权之争

在讲异步状态机之前，必须先解决一个资源冲突：**UART0 同时是调试 log 的通道和 HLW8110 的通道**（TLSR8258 总共就两个 UART，UART1 没引出）。

本项目最终的解决方案：

```c
VOID_T app_uart_init(VOID_T)
{
    tal_uart_deinit(USER_UART0);            /* 第一步：释放 SDK 的占用 */

    TAL_UART_CFG_T uart_cfg = {
        .rx_buffer_size = 256,
        { .baudrate = 9600,
          .parity   = TUYA_UART_PARITY_TYPE_EVEN,    /* 8E1 */
          .databits = TUYA_UART_DATA_LEN_8BIT,
          .stopbits = TUYA_UART_STOP_LEN_1BIT,
          .flowctrl = TUYA_UART_FLOWCTRL_NONE, }};
    tal_uart_init(USER_UART0, &uart_cfg);            /* 第二步：重配为 9600 8E1 */
    tal_uart_rx_reg_irq_cb(USER_UART0, __app_uart_rx_irq_cb);  /* RX 直通环形缓冲 */
}
```

调用时机：`tuya_init_last` → `app_meter_read_init()` → `app_uart_init()`。从此 **UART0 彻底归 HLW8110 所有**。

那调试 log 怎么办？TLSR8258 平台有个救星：`Tl_printf`——Telink SDK 的 GPIO 模拟串口打印，走 **PC4 引脚**（第 01 篇讲过 `app_print_get_cfg` 的配置）。所以最终的资源分配是：

| 通道 | 用途 | 参数 |
|------|------|------|
| UART0 | HLW8110 专用 | 9600 8E1 |
| PC4 模拟 UART | 调试 log | 115200 8N1 |

> 历史花絮：本项目最早的版本真是让 log 和计量共用 UART0 的——log 以 115200 8N1 初始化，计量前再 deinit 重配成 9600 8E1。后果是计量一启动 log 就乱码，调试只能靠猜。把 log 挪到 PC4 之后，世界清净了。**教训：共享资源时，优先找替代通道，而不是分时复用。**

## 四、异步状态机：中断收字节，定时器推剧情

### 4.1 总体架构

```
UART RX 中断 ──► 环形缓冲（64 字节）        ← 生产者，只管存
                     │
                     ▼
              60ms 软件定时器（__on_etimer_step）  ← 消费者，状态机驱动
                     │  ① 取上一步的应答，解析
                     │  ② 发送当前步的请求
                     │  ③ 重启 60ms 定时器
                     ▼
              step 表（读哪些寄存器、收几个字节、怎么解析）
```

这个架构解耦了两件事：**字节什么时候到**（中断说了算）和**协议走到哪一步**（定时器说了算）。UART 的应答时间不确定（芯片忙、干扰重传），你不能在中断里等；但你可以在定时器里每 60ms 看一眼"上一步的应答到了没"。

### 4.2 环形缓冲：最经典的解耦结构

```c
#define HLW_RING_SIZE 64

STATIC UINT8_T sg_hlw_ring[HLW_RING_SIZE];
STATIC volatile UINT8_T sg_hlw_ring_head = 0;   /* 写指针（ISR 用） */
STATIC UINT8_T sg_hlw_ring_tail = 0;            /* 读指针（状态机用） */

/* UART RX 中断回调——只做一件事：存字节 */
STATIC VOID_T hlw8110_uart_rx_cb(UINT8_T *data, UINT16_T len)
{
    for (UINT16_T i = 0; i < len; i++) {
        sg_hlw_ring[sg_hlw_ring_head] = data[i];
        sg_hlw_ring_head = (sg_hlw_ring_head + 1) % HLW_RING_SIZE;
        /* 满则丢弃最旧（覆盖）——宁可丢新数据也不阻塞 ISR */
    }
}
```

环形缓冲的三个设计点：

- **ISR 里零处理**：中断回调只搬字节，任何解析都放到主环境（定时器回调）里——ISR 越短，系统越稳；
- **覆盖策略**：满了丢最旧的。对计量场景，新数据永远比旧数据值钱；
- **`volatile`**：跨 ISR/主循环共享的变量必须加，防止编译器优化掉主循环里的重读。

### 4.3 step 表：声明式状态机

状态机不写成一坨 switch-case，而是一张**数据表**：

```c
typedef struct {
    UINT8_T addr;               /* 要读的寄存器地址 */
    UINT8_T rx_len;             /* 期望应答长度（数据 + 1 校验和） */
    hlw_step_parse_t parse;     /* 这一步的解析回调，返回 BOOL */
} hlw_step_t;
```

两张静态表定义了两种任务：

**校验表 `g_verify_steps`（12 步）**：9 个系数寄存器（0x70-0x77 + CHECKSUM 0x6F）+ SYSCON/EMUCON/EMUCON2 写回检查。上电 200ms 后跑一次，确认芯片状态健康。

**采集表 `g_calc_steps`（11 步）**：RMS_IA → RMS_U → POWER_PA → ENERGY_PA（拆两步：先读电量，再读 HFCONST 校验）→ UFREQ → ANGLE → PF → SYSCON → EMUCON → EMUCON2（后三个是内嵌的健康检查）。

调度核心 `__on_etimer_step` 每 60ms 执行一轮：

```c
STATIC VOID_T __on_etimer_step(TIMER_ID timer_id, VOID_T *arg)
{
    /* ① 取上一步应答：凑够字节则取走解析，不足则判 RX_SHORT 失败 */
    if (sg_cur_step > 0) {
        UINT8_T prev_idx = sg_cur_step - 1;
        UINT8_T expect = sg_steps[prev_idx].rx_len;
        if (__hlw_ring_count() >= expect) {
            UINT8_T buf[8];
            __hlw_ring_get(buf, expect);
            if (!sg_steps[prev_idx].parse(buf, expect)) {
                sg_all_ok = FALSE;                    /* 解析失败，记录 */
            }
        } else {
            sg_all_ok = FALSE;                        /* 超时：应答没凑够 */
        }
    }

    /* ② 所有步走完：收尾 */
    if (sg_cur_step >= sg_step_count) {
        sg_state_busy = FALSE;
        if (sg_done_cb) sg_done_cb(sg_all_ok);        /* 通知上层 */
        return;
    }

    /* ③ 发当前步的请求，重启 60ms 定时器 */
    UINT8_T tx[2] = {0xA5, sg_steps[sg_cur_step].addr};
    Start_Send_UartData(tx, 2);
    sg_cur_step++;
    tal_sw_timer_start(sg_etimer_step, HLW_STEP_INTERVAL_MS, TAL_TIMER_ONCE);
}
```

**超时处理居然没有专门的超时定时器**——靠的是 60ms 步进间隔的自然检查：如果上一步的应答在 60ms 内没凑够字节数，直接判 RX_SHORT。60ms 在 9600bps 下能传 57 字节，远大于最大应答（5 字节），所以这个"被动超时"既简单又充分。

声明式 step 表的好处：**加一个新寄存器 = 表上加一行 + 写一个 parse 函数**，不动状态机骨架。第 06 篇说过"新增寄存器读取请扩展现有 step 表，不要另起同步阻塞读"——指的就是这里。

### 4.4 启动序列的防竞态

```c
OPERATE_RET hlw8110_async_run(VOID_T)
{
    if (sg_state_busy) {
        return OPRT_RESOURCE_NOT_READY;    /* 状态机忙，拒绝重入 */
    }

    __hlw_ring_clear();                    /* ★ 清空环形缓冲再出发 */
    sg_all_ok = TRUE;
    sg_cur_step = 0;
    sg_state_busy = TRUE;
    tal_sw_timer_start(sg_etimer_step, 1, TAL_TIMER_ONCE);   /* 1ms 后开跑 */
    return OPRT_OK;
}
```

两个防御点：`sg_state_busy` 防重入（周期采集和按键触发可能撞车）；**启动前清环形缓冲**——这一行是血泪换来的，后面详细讲。

## 五、14 小时悬案：power_c 冻结在 8000W

这是本项目最精彩的调试故事，完整记录在项目实际的修复历史里。

### 5.1 症状

设备长期运行（>14 小时）后，云端 C 相功率突然变成一个荒谬的值（约 8000W，实际负载只有几百瓦），并且**永远卡在那里不再更新**。更诡异的是：断电重启必然恢复，但跑十几小时后必然复发。

### 5.2 排查

第一步看 log：周期采集的 `calc failed` 出现频率随运行时间上升。但"失败就跳过"的设计意味着数据应该保持上次值，怎么会跳成 8000W？

第二步看代码：失败时的确有"跳过本次数据写入"的保护——**但只保护了一半**。问题出在环形缓冲：

```
第 N 次采集：某一步应答超时（RX_SHORT），判失败。
            但芯片其实应答了，只是延迟超过 60ms——
            这些迟到的字节残留在了环形缓冲里！

第 N+1 次采集：状态机从第 0 步重新开始读，
            第 0 步取"上一步应答"时，从缓冲里取出的是
            上一次残留的错位数据——它居然通过了校验和！
            （残留字节的校验和是"真的"，只是属于错误的寄存器）

            → 电压寄存器的值被当成了功率 → 8000W
```

**根因：残留数据偶发性地通过 checksum 校验**。校验和只能验证"字节在传输中没损坏"，不能验证"这些字节是不是对这一步的应答"。时序错位让校验和防线形同虚设。

### 5.3 修复：三层防线

那次修复是教科书级的"纵深防御"：

**第一层（根治）：启动前清环形缓冲**。`hlw8110_async_run()` 里 `__hlw_ring_clear()`——不让任何残留数据有活到下一次采集的机会。

**第二层（兜底）：只有全部步骤成功才写数据**。`__on_calc_done` 里 `if (!all_ok) return;`——任何一步失败，本次采集的数据整个丢弃，METER_DATA_T 保持上一次的好数据。宁可没有新数据，不要错误数据。

**第三层（数值合理性钳位）**：小功率死区（<0.3W / <30mA 判空载清零）和 ±50kW 硬钳位——即使前两道都漏了，数值也被限制在物理可能范围内。

外加两条系统级加固：`Init_HLW8110()` 加 busy 保护（重初始化不能打断正在跑的状态机）；calc 持续失败 5 分钟（30 次 × 10s）自动保存电量后整机复位（`HLW_RESET_THRESHOLD` 机制）。

### 5.4 教训清单

1. **校验和 ≠ 语义正确**。CRC 只能防传输损坏，防不了时序错位。协议层要有"这一步的数据只能是这一步的"的机制（比如 seq 号，可惜 HLW8110 没有）。
2. **异步系统的状态泄漏比同步更难发现**。同步代码失败即返回，缓冲随之作废；异步代码的失败现场会残留到下一次执行。清场（clear buffer）和入场（busy 检查）同等重要。
3. **数值钳位是最后一道保险**。任何来自外部世界的数据，进系统前先问"这个值物理上可能吗"。

## 六、健康检查：三级故障恢复体系

8110 的可靠性不依赖单一机制，而是一套递进体系：

```
Level 0: 单步校验和失败 / RX_SHORT        → 丢弃本步，all_ok=FALSE
Level 1: 连续 3 次采集失败 (HLW_INIT_FAIL_THRESHOLD)
          → Init_HLW8110() 重初始化芯片
          （且要 hlw8110_is_busy() 防竞态——状态机跑着时不准重入）
Level 2: 累计失败 30 次 ≈ 5 分钟 (HLW_RESET_THRESHOLD)
          → __energy_nv_save() 保存电量 → tal_system_reset() 整机复位
          （"用户观察到断电重启总能解决问题"的代码化）
```

Level 2 的注释特别坦诚：

> This matches the user's observation that a power-cycle always fixes the issue — a software reset achieves the same effect without human intervention.

"断电重启能好"是现场工程师的祖传偏方，代码化之后就是：先持久化关键数据，再自我复位。30 次 × 10 秒周期 = 5 分钟，足够区分"暂时干扰"和"真的坏了"。

另外状态机每次 calc 的**最后三步**是 SYSCON/EMUCON/EMUCON2 读回检查：如果这三个寄存器等于芯片默认值（0x0A04/0x0000/0x0001），说明芯片被意外复位了（干扰、电压跌落），立即触发重初始化——比等 3 次失败计数器更快发现异常。

## 七、初始化与校验的时序安排

`Init_HLW8110()` 的寄存器配置与 8112 类似（SYSCON=0x0F04 但只开 A 通道、EMUCON=0x1183、EMUCON2=0x03FF），但它**写完不做验证**——因为 15ms 步进的写序列刚结束，芯片可能还在消化。验证推迟 200ms 后由异步状态机执行（`app_meter_read_init` 里的 `sg_etimer_verify_delay`）。

这段 200ms 的延迟也是第 04 讲的 POWER_ON_ONLINE 分支"不立即触发采集"的原因：verify 和首次采集共用状态机，启动早期的任务编排必须规定优先级。

`__on_verify_done` 的系数交叉校验算法：

```c
/* 8 个系数之和 + 0xFFFF 取反，应等于 CHECKSUM 寄存器 */
UINT16_T sum = 0xFFFF;
for (int i = 0; i < 8; i++) sum += coeffs[i];
if ((~sum & 0xFFFF) == checksum_reg) → 校验通过
```

与 8112 不同，8110 的系数读取每一步都带 UART 校验和验证（8112 的 SPI 没有帧级校验）——接口不同，验证策略也不同，但"系数不可信则全盘不可信"的原则一致。

## 八、数据写入：死区、钳位、校准的交汇处

采集成功后，`hlw8110_write_to_meter_data()` 把 C 相数据写进 `METER_DATA_T`，这里是三个业务机制的交汇点：

```c
/* ① 空载死区：小信号噪声清零 */
if (F_AC_I_8110 < 0.03f && fabsf(F_AC_P_8110) < 0.3f) {   /* <30mA 且 <0.3W */
    F_AC_I_8110 = 0; F_AC_P_8110 = 0; ...
}

/* ② 应用层校准（加性偏移，校准篇详述） */
F_AC_V_8110  += meter->voltage_calibration * 0.1f;        /* DP 132: -50~50 → ±5V */
F_AC_I_8110  += meter->current_calib_c  * 0.001f;
F_AC_P_8110  += meter->power_calib_c    * 0.1f;

/* ③ 物理合理性钳位 */
if (F_AC_P_8110 > 50000.0f)  F_AC_P_8110 = 50000.0f;      /* ±50kW */
if (F_AC_P_8110 < -50000.0f) F_AC_P_8110 = -50000.0f;
```

写数据的顺序也有讲究：先死区（物理判断）→ 再校准（业务修正）→ 再钳位（安全兜底）。校准在钳位之前，因为合法的校准不应被钳掉；死区在校准之前，因为零漂校准不该把空载"救活"。

## 九、验证方法

1. **上电验证**：200ms 后串口出现 `verify` 各步的 OK 日志，12 步全过后触发首次 calc；
2. **数据比对**：C 相接已知负载，与标准功率计对比，误差 ±2% 内；
3. **压力测试**：连续运行 48h，观察 `calc failed` 计数（应长期为 0）；
4. **故障注入**：拔掉 HLW8110 的 UART 线，应看到 3 次失败后 `re-init`，恢复接线后数据自动回来；
5. **状态机竞态**：按键短按（触发采集）和 10s 周期采集同时到来时，log 应出现 `busy, calc skipped` 而非卡死。

## 十、小结

- UART 计量驱动的异步化是传输时间逼的：100ms 的同步阻塞不可接受，"中断收字节 + 定时器推状态机"是唯一出路；
- step 表把状态机声明化，扩展新寄存器只需加一行；
- "无独立超时定时器"的被动超时设计：60ms 步进间隔天然给出超时间窗；
- 14 小时悬案的根因是环形缓冲残留 + 校验和无法防时序错位；修复策略是"清场 + 全成功才写入 + 数值钳位"三层纵深防御；
- 三级故障恢复（丢弃→重init→整机复位）把"断电重启"这个祖传偏方代码化。

至此三相数据全部到手。但数据躺在内存里，掉电就全没了——下一篇解决"记忆"问题：数据模型设计、KV 持久化、电量掉电续算，以及"端子电量 + NV 偏移"的巧妙架构。

---

*上一篇：[06 感知（上）] · 系列目录 · 下一篇：[08 记忆：数据模型、KV 持久化与电量不丢的秘密]*
