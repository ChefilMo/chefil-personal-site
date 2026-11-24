---
title: "08 · 记忆：数据模型、KV 持久化与电量不丢的秘密"
description: "38 个 DP 的数据模型设计：全定点结构体、KV 持久化，用“NV 偏移 + 芯片实时累加”架构解决掉电电量归零，附磨损均衡节流、聚合层与踩坑实录。"
pubDate: 2026-11-24
lang: zh
translationKey: zigbee-meter-part8
tags: [嵌入式, Zigbee, 教程]
series: zigbee-meter
seriesOrder: 8
category: embedded
---

> 目标：设计一个能撑住 38 个 DP 的数据模型，解决"掉电后电量归零"这个电表行业的终极焦虑

---

## 一、为什么电表的数据模型值得单独一篇？

手机 App 的数据模型可以随便设计——内存不够就申请，丢了就重新拉取。电表不行：

- **掉电是常态**：配电箱跳闸、用户换电池（如果有）、雷击保护动作……任何一次断电都不能让累计电量归零；
- **Flash 寿命有限**：TLSR8258 的 Flash 擦写次数约 10 万次，电量每 10 秒写一次，一年就写 300 万次——**naive 的"每周期写 Flash"方案两年就把芯片写废了**；
- **数据有两张脸**：同一份电量既要按"端子"维度报（物理事实）又要按"相位"维度报（用户视角），两套必须严格一致。

本篇的三位主角：`METER_DATA_T`（数据模型）、KV Flash（持久化）、聚合层（电量算术）。

## 二、METER_DATA_T：一个结构体装下整个电表

全部 38 个 DP 的运行时值集中在一个结构体里：

```c
typedef struct {
    /* ---- 累计电量（RO, scale=2, kWh）---- */
    INT32_T forward_energy_total;   /* DP 1   正向累计总电量 */
    INT32_T reverse_energy_total;   /* DP 2   反向累计总电量 */
    INT32_T forward_energy_1;       /* DP 56  A通道正向电量(按端子) */
    /* ... 共 14 个电量字段 ... */
    INT32_T forward_energy_a;       /* DP 125 A通道正向累计电量(按相) */

    /* ---- 实时数据（RO）---- */
    INT32_T power_total;            /* DP 9   总功率, W×10 */
    INT32_T cur_voltage;            /* DP 101 电压, V×10 */
    INT32_T current_a;              /* DP 102 电流, mA */
    /* ... 共 11 个实时字段 ... */
    INT32_T power_factor_a;         /* DP 108 功率因数, ×100 */

    /* ---- 每小时电量（RO）---- */
    INT32_T forward_energy_a_hour;  /* DP 117 */

    /* ---- 报警（RO, BOOL）---- */
    BOOL_T  power_alarm_a;          /* DP 114 */

    /* ---- 配置（RW）---- */
    BOOL_T  switch_state;           /* DP 16  继电器开关 */
    INT32_T power_setting_a;        /* DP 111 功率阈值, W */
    INT32_T voltage_calibration;    /* DP 132 电压校准 */
    /* ... 共 11 个 RW 字段 ... */
} METER_DATA_T;
```

设计决策逐条说：

**① 全部用 INT32_T / BOOL_T，没有浮点数。** DP 协议就是定点整数（第 05 篇），数据模型和协议层同构，省掉一层转换。浮点只在驱动换算的瞬间存在，写进模型前必须转成定点（`HLW_DBG_*` 宏家族：`(INT32_T)((v) * 10)` 等）。附带好处：结构体可以在 KV 里整体读写。

**② 单实例全局变量 + 访问器函数**，不搞 malloc：

```c
STATIC METER_DATA_T sg_meter_data;

METER_DATA_T *app_meter_data_get(VOID_T)    /* 唯一访问入口 */
{
    return &sg_meter_data;
}
```

嵌入式里动态内存是万恶之源——碎片、泄漏、不确定性。一个电表的数据量就几百字节，静态分配 + 指针访问，简单且可预测。

**③ RO 和 RW 分区。** 结构体里 27 个 RO 字段（上电清零，等芯片填充）+ 11 个 RW 字段（必须持久化）。这个分界决定了 KV 策略：RW 任何变动立即写盘，RO 只在特定条件下写。

**④ 端子电量（1/2/3）与相位电量（a/b/c）并存。** `forward_energy_1/2/3` 是芯片读数 + NV 偏移的原始结果（物理端子），`forward_energy_a/b/c` 是经过交叉映射的相位视角（第 06 篇）。两套都上报，云端爱用哪套用哪套。

## 三、KV Flash：TuyaOS 的持久化原语

TuyaOS 的 KV（Key-Value）闪存抽象提供四个原语：

```c
tal_kv_flash_read(key_id, len, buf);     /* 读：不存在返回非 SUCC */
tal_kv_flash_write(key_id, len, buf);    /* 写：Wear-Leveling 由 SDK 负责 */
tal_kv_flash_delete(key_id);             /* 删除 */
```

本项目用掉了 4 个 KV ID：

| Key | 内容 | 大小 | 写入策略 |
|-----|------|------|---------|
| 0x00 | 复位计数（三连配网） | 1B | 每次上电 |
| 0x01 | warm-start 魔数 0xA5 | 1B | 仅首次上电 |
| 0x10 | **RW 配置块** | sizeof(METER_DATA_T) | **任何 RW 变动立即写** |
| 0x20 | **6 路电量 NV 偏移** | 24B (6×INT32) | 60s 周期 + 变化阈值 |

注意 0x10 的小技巧：**整个 METER_DATA_T 落盘，但只读写 RW 字段**：

```c
/* 保存：先清零临时结构体，只填 RW 字段，整体写入 */
STATIC VOID_T __meter_rw_save_to_kv(VOID_T)
{
    METER_DATA_T temp_data;
    tal_system_memset(&temp_data, 0, sizeof(METER_DATA_T));
    temp_data.switch_state    = sg_meter_data.switch_state;
    temp_data.power_setting_a = sg_meter_data.power_setting_a;
    /* ... 11 个 RW 字段 ... */
    tal_kv_flash_write(KV_ID_METER_RW_DATA, sizeof(METER_DATA_T), (UINT8_T *)&temp_data);
}

/* 加载：整体读出，只拷 RW 字段回来 */
STATIC BOOL_T __meter_rw_load_from_kv(VOID_T)
{
    METER_DATA_T temp_data;
    if (tal_kv_flash_read(KV_ID_METER_RW_DATA, sizeof(METER_DATA_T), (UINT8_T *)&temp_data) != TAL_KV_SUCC) {
        return FALSE;    /* 首次烧录/恢复出厂后没有数据 */
    }
    sg_meter_data.switch_state    = temp_data.switch_state;
    /* ... 只拷 11 个 RW 字段，RO 保持初始化时的 0 ... */
    return TRUE;
}
```

为什么不只存 11 个字段的真实大小（约 45 字节）？因为**结构体整体读写最简单**——不用维护一个单独的打包格式，加字段时只要在两个函数里各加一行拷贝。多写的几十字节 Flash 空间换代码的健壮性，划算的买卖。

## 四、电量的掉电续算：NV 偏移架构

这是本篇的核心。问题的难点在：**芯片内部的电量寄存器掉电就清零**（HLW811x 的电量寄存器不是非易失的），而累计电量可能已经有几百 kWh。直接存"总电量"？不行——运行中电量一直在涨，每次写 Flash 的都是过期值，掉电就丢最近一段。

本项目的解法叫 **"NV 偏移 + 芯片实时累加"**：

```
                上电时                          运行中                    掉电前
                   │                               │                         │
┌──────────────────┼───────────────────────────────┼─────────────────────────┐
│ 读 KV 0x20:      │  芯片电量寄存器从 0 开始累加   │  每 60s 检查一次：       │
│ sg_nv_offset     │                                │  若 |当前总量 - 上次存档| │
│ = 123450 (kWh×100)│  meter->forward_energy_a      │  >= 1 (0.01kWh):        │
│                  │  = offset + chip_reg           │  存 KV 0x20              │
│ 显示 = 1234.50kWh│  = 123450 + chip累加           │  = 完整当前值           │
│                  │                                │                         │
└──────────────────┴───────────────────────────────┴─────────────────────────┘
   掉电最多丢 60s 内的增量（<0.01kWh 时连这 60s 都省了）
```

聚合层的核心代码：

```c
/* 相位累计电量 = NV 偏移 + 芯片实时（端子）电量 */
meter->forward_energy_a = sg_nv_offset_fwd_a + meter->forward_energy_1;
meter->forward_energy_b = sg_nv_offset_fwd_b + meter->forward_energy_2;
meter->forward_energy_c = sg_nv_offset_fwd_c + meter->forward_energy_3;
```

持久化的节流策略（`__energy_nv_save_check`）：

```c
#define NV_SAVE_INTERVAL_MS   (60 * 1000)    /* 每分钟检查一次 */
#define NV_SAVE_THRESHOLD     1              /* 变化 ≥1 (0.01kWh) 才写 */

STATIC VOID_T __energy_nv_save_check(VOID_T)
{
    BOOL_T changed = FALSE;
    if (ABS(meter->forward_energy_a - sg_last_fwd_a) >= NV_SAVE_THRESHOLD) changed = TRUE;
    /* ... 6 路都查 ... */
    if (changed) {
        __energy_nv_save();                  /* 写 KV 0x20 */
    }
}
```

三行参数，三重考量：

- **60 秒间隔**：Flash 写入有毫秒级阻塞（擦除期间中断响应延迟），太频繁影响 Zigbee 时序；10 万次寿命 ÷ 每分钟 1 次 = 69 天……不对，**配合变化阈值，实际写入频率取决于负载**：空载时电量不动，一小时也写不了一次；满载时约每分钟一次 → 年写入约 52 万次？那也不行！

  等一下，重算：10 万次 ÷ 525600 分钟/年 ≈ 0.19 次/分钟——寿命只够 5 个月？这是 naive 算法的死穴。TuyaOS 的 KV 实现带 **Wear-Leveling（磨损均衡）**，把写入分散到整个 KV 区域（实际可用擦写次数 × 均衡区块数），开发者看到的"一个 KV ID"物理上在多个 Flash 页间轮换。SDK 不承诺具体次数，但工程实践表明分钟级单点写入可支撑产品生命周期。**如果你的 SDK 没有磨损均衡，就要自己设计"电量变化才写 + 分钟级节流 + 双页轮换"**——这正是本架构把"变化阈值"和"时间间隔"分开控制的原因，方便按芯片特性调参。

- **阈值 1（0.01 kWh）**：10W 负载 1 小时才走 0.01 kWh，普通家庭负载的写入频率远低于每分钟一次；
- **掉电损失上界**：最坏情况丢 60s 的电量增量——10kW 满载 60s 是 0.167 kWh（0.1 度电）。对民用表计，这个精度完全可接受；电力公司结算表用超级电容撑到下一次写入，那是另一个级别的产品。

## 五、聚合层：每次采集后的算术中心

`__aggregate_meter_data()` 在每次"两芯片都读完"之后执行，是整个数据流的交通枢纽：

```c
STATIC VOID_T __aggregate_meter_data(VOID_T)
{
    /* ① 相位电量 = NV 偏移 + 芯片实时 */
    meter->forward_energy_a = sg_nv_offset_fwd_a + meter->forward_energy_1;
    /* ... */

    /* ② 总功率 = 三相之和（带符号） */
    meter->power_total = meter->power_a + meter->power_b + meter->power_c;

    /* ③ 总电量 = 三相之和 */
    meter->forward_energy_total = meter->forward_energy_a + ..._b + ..._c;

    /* ④ 报警检查（功率 vs 阈值 → 继电器动作，第 11 篇详述） */
    app_meter_data_update_alarms();

    /* ⑤ NTC 温度 */
    INT32_T adc_val = app_adc_read_pb6();
    if (adc_val >= 0) {
        if (adc_val >= 3200) {
            meter->temp_current = 0;         /* NTC 开路：探头没接，报 0℃ */
        } else {
            meter->temp_current = (INT32_T)(app_adc_get_temperature(adc_val) * 10);
        }
    }
}
```

**为什么聚合放在"两芯片都读完"之后而不是各自读完就报？** 因为总量、报警、上报都依赖完整的三相数据。8112（SPI 同步）先读完，8110（UART 异步）后完成，`__on_hlw8110_done` 回调就是聚合的触发点——第 07 篇的异步状态机在这里完成它的使命：

```c
STATIC VOID_T __on_hlw8110_done(BOOL_T all_ok)
{
    __hlw8110_health_check(all_ok);
    if (!all_ok) {
        app_lcd_refresh();          /* C 相坏了：A/B 数据仍有效，LCD 照常刷 */
        if (sg_done_cb) sg_done_cb();
        return;                     /* 跳过聚合与上报——数据不全不硬算 */
    }
    __aggregate_meter_data();       /* ★ 唯一的聚合入口 */
    app_meter_data_report_realtime();
    app_lcd_refresh();
    if (sg_done_cb) sg_done_cb();   /* 重启周期定时器 */
}
```

这个回调还处理了两个优雅细节：首次成功采集时 LED 快闪 5 次（"数据就绪"的视觉信号，和第 03 篇的 `flash_times` 联动）；失败时仍然刷 LCD（A/B 相数据还有效，用户体验不能跟着 C 相陪葬）。

## 六、每小时电量：差值法的朴素实现

DP 117-124 要报"过去一小时每相用了多少电"。实现是教科书级的差值法（`__hourly_energy_update`）：

```c
/* 每小时定时器到点 */
meter->forward_energy_a_hour = meter->forward_energy_1 - sg_hour_start_fwd_a;
/* ... 6 路差值 ... */
meter->forward_energy_total_hour = a + b + c;

/* Baseline 推进到当前值 */
sg_hour_start_fwd_a = meter->forward_energy_1;
/* ... */

app_meter_data_report_hourly();
```

`sg_hour_start_*` 是上小时的基准值，差值即小时电量，报完把基准推到当前。1 小时定时器用单次软件定时器自接力（60 分钟到期 → 计算 → 重启自己）。

注意小时电量基于**端子电量**（`_1/_2/_3`）做差，不是相位电量——因为端子电量是芯片的原始连续计数，差值最干净；相位电量多了 NV 偏移的加法，差值理论上一样但绕了一层。这个选择再次体现"物理事实优先用原始数据"的原则。

## 七、恢复出厂：三套清零的边界

"清数据"听起来简单，实际有三个层次，各自归不同的模块管（这是踩过坑之后划清的边界）：

| 层次 | 函数 | 干什么 | 归谁管 |
|------|------|--------|--------|
| 数据模型 | `app_meter_data_factory_reset()` | 删 KV 0x10、RW 字段归零、恢复默认阈值 500W、继电器断开 | 数据模型模块 |
| 计量累积 | `app_meter_read_factory_reset()` | 删 KV 0x20、清零 NV 偏移/小时基准、清零芯片运行累计、LCD 回首页 | 计量读取模块 |
| 自检状态 | `app_meter_test_reset()` | 自检通道指针回 A | 自检模块 |

三个函数在第 04 篇的配网触发和 REMOTE_LEAVE 分支里一起被调。边界划分的理由：KV 0x10 的格式只有数据模型模块知道怎么解析；芯片累计清零只有计量读取模块知道调哪个驱动接口。**"谁的数据谁清零"是模块化的一条铁律**，如果让一个函数包打天下，将来加新模块时必然漏清。

## 八、踩坑实录

**坑 1：掉电丢电量（上电读不到 NV）。**
症状：每次上电电量归零。排查：KV ID 定义和读写处的宏不一致（0x20 写成 0x10 之类）；或者写时 `len` 传错（sizeof 结构体 vs. sizeof 指针！）。`tal_kv_flash_write(key, sizeof(*ptr), (UINT8_T*)ptr)` 里的 sizeof 永远写 `sizeof(结构体)`。

**坑 2：电量"越用越少"。**
差值溢出或符号错误：6 路电量是 `INT32_T`，单位 0.01kWh，上限约 2147 万 kWh——够用。但**反向电量在芯片里是独立的累加路径**，如果驱动层把反向当负数加到正向里，聚合层的加法就会互相抵消。检查驱动层"正/反向分流"逻辑（第 06 篇的功率符号位判断）。

**坑 3：Flash 写穿。**
开发阶段把 `NV_SAVE_INTERVAL_MS` 改成 5 秒"方便调试"，几个月后设备 Flash 报废。教训：**节流参数就是产品寿命参数**，调试配置和生产配置分开。

**坑 4：恢复出厂后云端还显示旧电量。**
只清了本地 KV，没清"变化检测缓存"（`sg_last_fwd_*`）。结果第一次周期上报时，"当前值 0 vs. 缓存值 12345"的差值超过死区，本该报 0——但缓存里存的还是旧值的上报记录，逻辑正确；真正的问题是**云端需要一次全量快照**。对策：`factory_reset` 里把 `sg_realtime_report_initialized = FALSE`，强制下一次周期上报走全量分支（项目实际的修复记录里就是这么做的）。

## 九、验证方法

1. **掉电测试**：带电运行累计 0.5 kWh，断电 10 秒，重新上电——电量应从 0.5 kWh 继续，误差 ≤0.01 kWh（一次 60s 存档周期的增量）；
2. **写入频率**：串口 log 数 `energy NV saved` 出现的频率，空载时应该一小时难得出现一次；
3. **恢复出厂**：三连上电配网 → 本地电量清零 → 云端电量在下一次全量上报后归零；
4. **结构体变更**：给 METER_DATA_T 加字段后，老设备的 KV 0x10 读出的是旧长度——`tal_kv_flash_read` 长度不匹配返回错误，代码应走"用默认值"分支而非崩溃。这就是 `__meter_rw_load_from_kv` 返回 BOOL 的意义。

## 十、小结

- 数据模型 = 单实例静态结构体，全定点整数，RO/RW 分区，端子与相位双视角；
- RW 配置任何变动立即落盘 KV 0x10（整个结构体写、只读写字段）；电量用"NV 偏移 + 芯片实时"架构，60s + 变化阈值双条件节流写 KV 0x20；
- 聚合层是数据流的枢纽：电量合成、总量、报警、温度都在这里串起来，触发点是 8110 异步采集完成回调；
- 每小时电量 = 差值法，基准值每小时推进一次；
- 恢复出厂三套清零分属三个模块，"谁的数据谁清零"。

数据的问题解决了，但还有一个性能炸弹没拆：38 个 DP 一起上报时，SDK 只有 15 个槽位的发送队列根本装不下。下一篇讲应用层发送队列——以及一场真实的"队列死锁"事故。

---

*上一篇：[07 感知（下）] · 系列目录 · 下一篇：[09 血管：DP 发送队列与一场死锁事故]*
