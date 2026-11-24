---
title: "04 · 入网：配网流程与网络状态机"
description: "拆解 TuyaOS 智能电表的配网流程与网络状态机：两种配网触发方式、离线不停采集、JOIN_OK 延迟上报等血泪经验。"
pubDate: 2026-11-24
lang: zh
translationKey: zigbee-meter-part4
tags: [嵌入式, Zigbee, 教程]
series: zigbee-meter
seriesOrder: 4
category: embedded
---

> 目标：搞清楚设备"什么时候该配网、配网失败怎么办、掉线怎么自救"，让 App 里出现"设备在线"

---

## 一、什么是配网（Join）？

Zigbee 设备出厂时是无网络的"白纸"（Factory New 状态），它必须经历 **Join** 才能加入某个网络。过程大致是：

```
设备                    网关（协调器）
  │                          │
  │──── Beacon Request ────→│  我找工作单位，有谁在招人？
  │←────── Beacon ──────────│  我这儿有网络，PAN ID 是 0xXXXX
  │                          │
  │──── Associate Request ─→│  我要加入
  │←─── Transport Key ──────│  这是网络密钥（加密通信的基础）
  │                          │
  │←── Simple Descriptor Req─│  你都有什么能力？（端点/簇清单）
  │──── Simple Desc Resp ──→│  端点1，簇 0x0003/0x0004/0x0005/0xEF00...
```

前三步由 Zigbee 协议栈自动完成（`tal_zg_join_start()` 一个调用的事），最后两步就是第 02 篇注册的端点描述符在起作用。

对用户来说，这一切发生在按下一个按键之后；对开发者来说，真正的工作在**状态管理**——配网期间业务要不要停？配网失败 LED 怎么亮？网关把设备删了怎么办？这些问题的答案都收在 `tal_zg_nwk_status_changed_callback()` 这一个回调里。

## 二、两种触发配网的方式

本项目支持两种触发姿势，都指向同一个入口 `tal_zg_join_start(ZIGBEE_JOIN_MAX_TIMEOUT_MS)`。

### 2.1 长按 5 秒（生产/调试姿势）

第 03 篇讲过：长按 5 秒 → `etimer_join_start_delay`（50ms 后触发）。回调里有个非常重要的细节：

```c
STATIC VOID_T __app_network_join_start_delay_cb(TIMER_ID timer_id, VOID_T *arg)
{
    /* Long-press triggers factory reset BEFORE re-joining, so the device
     * comes back online with all defaults and no stale calibration/energy. */
    app_meter_data_factory_reset();
    app_meter_read_factory_reset();
    app_meter_test_reset();

    tal_zg_join_start(ZIGBEE_JOIN_MAX_TIMEOUT_MS);
}
```

**配网前先恢复出厂**。为什么？设想这个场景：设备原来在客户 A 的网关下运行了半年，积累了电量和校准数据，现在转手卖给了客户 B。如果不清零直接入网，客户 B 的 App 上会看到一个带着 500kWh 历史电量和陌生校准值的"新"设备——投诉电话就在路上了。所以"重新配网" = "新生命的开始"，本地数据全部清零。

### 2.2 三连上电（用户姿势）

爬进配电箱找按键很不友好，所以家电行业有个祖传交互：**快速断电-上电 3 次 = 我要配网**。实现藏在 `app_power_on_check_rst_cnt_proc()` 里，机制是"KV 计数器 + 5 秒清零窗口"：

```c
VOID_T app_power_on_check_rst_cnt_proc(VOID_T)
{
    /* 看门狗复位不算——那是异常重启，不能触发配网 */
    if (tal_system_get_reset_reason() == TUYA_RESET_REASON_WATCHDOG) {
        return;
    }

    /* 读 KV：复位计数(0x00) 和 warm-start 标记(0x01) */
    tal_kv_flash_read(KV_ID_RST_CNT, ...);
    tal_kv_flash_read(KV_ID_WARM_ST, ...);

    if (v_warm_start != 0xA5) {          /* 冷启动：写魔数，计数归 1 */
        tal_kv_flash_write(KV_ID_WARM_ST, ..., 0xA5);
        tal_kv_flash_write(KV_ID_RST_CNT, ..., 1);
    } else {                              /* 暖启动：计数 +1，满 3 触发配网 */
        v_rst_cnt++;
        if (v_rst_cnt >= 3) {
            tal_sw_timer_start(etimer_join_start_delay, 20, TAL_TIMER_ONCE);
        }
        tal_kv_flash_write(KV_ID_RST_CNT, ..., v_rst_cnt);
    }

    /* 无论哪条路径：启动 5s 清零定时器 */
    tal_sw_timer_start(etimer_clr_rst_cnt_delay, 5000, TAL_TIMER_ONCE);
}
```

三个机制环环相扣，缺一不可：

| 机制 | 作用 |
|------|------|
| **0xA5 魔数** | 区分"此生第一次上电"（冷启动，计数归 1）和"又一次上电"（暖启动，计数 +1）。没有它，每次上电都从 1 重新开始计数，永远到不了 3 |
| **5 秒清零窗口** | `etimer_clr_rst_cnt_delay` 5 秒后把计数写回 0。没有它，一天内分三次正常开关机也会误触发配网 |
| **看门狗排除** | 芯片异常重启时 reset reason 是看门狗，此时触发配网就是灾难 |

这套逻辑在 `tuya_init_second` 阶段执行——很早，因为用户"三连上电"的动作窗口只有几秒钟，必须抢时间。

## 三、核心：网络状态机

`tal_zg_nwk_status_changed_callback(TAL_ZG_NWK_STATUS_E status)` 是 TuyaOS 对应用层最重要的回调，没有之一。网络里任何风吹草动都会以状态码的形式送到这里。本项目要处理 9 种状态，我按"业务维度"重新组织成一张决策表：

### 3.1 离线家族：LED 灭，但 LCD 不能停

```
POWER_ON_LEAVE  上电但未入网（等用户触发配网）
JOIN_TIMEOUT    配网超时
NWK_LOST        网络丢失（失去父节点）
REMOTE_LEAVE    被网关删除
LOCAL_LEAVE     本地退网
```

这五个状态的共同点处理：

```c
case TAL_ZG_NWK_JOIN_TIMEOUT: {
    sg_nwk_online = FALSE;
    app_led_set_mode(LED_MODE_OFF);
    app_meter_read_resume();                                /* ★ 计量继续跑 */
    tal_sw_timer_start(etimer_periodic_report, PERIODIC_REPORT_INTERVAL_MS, TAL_TIMER_ONCE);
    break;
}
```

注意 `app_meter_read_resume()` 和周期定时器的启动——**离线时计量采集和 LCD 刷新一刻都不能停**。电表装在配电箱里，网关坏了、Wi-Fi 断了都是常事，用户抬头看 LCD 必须还能看到实时电压电流。只有 DP 上报被 `app_nwk_is_online()` 挡住（第 08 篇细讲这个标志的用法）。

这是项目修复记录中两次修复的结晶。早期的实现是"离线 = 全部停摆"，结果用户一断网 LCD 就冻结在最后一帧，WiFi 图标还傻亮着，看起来像死机。教训：**离线和停止工作之间没有等号，上报可以缓存/跳过，采集和显示必须自治**。

### 3.2 在线家族：延迟上报，别抢跑

```
POWER_ON_ONLINE  上电且已入网（闪存里有网络信息，直接回网）
JOIN_OK          首次配网成功
REJOIN_OK        掉线后重连成功
```

首次配网成功（JOIN_OK）的处理：

```c
case TAL_ZG_NWK_JOIN_OK: {
    sg_nwk_online = TRUE;
    app_meter_read_resume();
    app_led_set_mode(LED_MODE_ON);                          /* 常亮 = 在线 */
    tal_sw_timer_start(etimer_report_all_delay, 6000, TAL_TIMER_ONCE);   /* ★ 等 6 秒！ */
    tal_sw_timer_start(etimer_periodic_report, PERIODIC_REPORT_INTERVAL_MS, TAL_TIMER_ONCE);
    break;
}
```

**为什么要延迟 6 秒才全量上报？** 这是本篇最值钱的经验，代码注释里写得清清楚楚：

> Zigbee 协议栈在 JOIN_OK 后会立刻产生一大波管理流量（Device Annce、Node/Active/Simple Descriptor Request/Response……），SDK 的 QOS_1 发送队列只有 **15 个槽位**。如果你在 JOIN_OK 回调里立刻全量上报 38 个 DP，每一帧都会得到 `QUEUE_FULL_ERR`。

6 秒是让协议栈把这波"入公司报到手续"办完。首次入网比重新入网（REJOIN_OK 只等 3 秒）更久，因为首次入网还要做路由发现，APS 路径根本不存在，早发的帧会以 QOS_0 静默丢弃。

而且一次上报还不保险——首次入网太脆弱，所以 `__app_report_all_delay_cb` 在 6 秒后报完一轮，**5 秒后再报一轮备份**（`etimer_report_all_retry`）。App 上偶尔闪过的"数据终于对了"，很多就是第二次备份上报救回来的。

### 3.3 配网进行中：暂停业务，快闪提示

```c
case TAL_ZG_NWK_JOIN_START: {
    tal_sw_timer_stop(etimer_periodic_report);
    app_meter_read_pause();                                 /* 采集暂停 */
    app_led_set_mode_force(LED_MODE_FAST_BLINK);            /* 快闪 = 正在找网 */
    break;
}
```

配网期间暂停计量有两个原因：一是配网是无线电最忙的时刻，SPI/UART 采集可能被中断延迟干扰；二是早期版本在这里踩过坑——配网期间 HLW8110 的异步状态机还在跑，和入网流程竞争软件定时器，出现过状态机卡死（后来的一次修复解决了它）。

`set_mode_force` 用上篇讲的强制模式：用户可能正按着按键，但配网快闪是最高优先级提示。

### 3.4 被删除家族：清数据，自动回家

```c
case TAL_ZG_NWK_REMOTE_LEAVE: {     /* 网关上点了"移除设备" */
    sg_nwk_online = FALSE;
    app_led_set_mode(LED_MODE_OFF);
    app_meter_data_factory_reset();     /* 三重清零 */
    app_meter_read_factory_reset();
    app_meter_test_reset();
    app_meter_read_resume();
    tal_sw_timer_start(etimer_periodic_report, ...);
    break;
}
```

注意这里没有调用 `tal_zg_join_start`——**重连是框架自动做的**（第 02 篇的 `auto_join_remote_leave_flag = TRUE`）。应用层只需要做"重新做人"的部分：清数据、恢复计量、等框架把自己拉回网络。

### 3.5 完整状态机一图流

```
                    ┌─────────────┐
   三连上电/长按5s  │ JOIN_START  │  快闪，暂停计量
        ──────────→│  (配网中)    │
                    └──────┬──────┘
              成功          │           超时
        ┌─────────────────┼──────────────────┐
        ▼                 │                  ▼
  ┌──────────┐            │           ┌─────────────┐
  │ JOIN_OK  │  常亮      │           │ JOIN_TIMEOUT│ 灯灭
  │(首配网)   │            │           └──────┬──────┘
  └────┬─────┘            │                  │ 等下次触发
       ▼                  │                  ▼
  ┌──────────┐            │           (回到离线家族，
  │  ONLINE  │◄───────────┘            LCD 继续显示)
  │  (在线)   │
  └────┬─────┘
       │ 网络丢失
       ▼
  ┌──────────┐   自动重连    ┌───────────┐
  │ NWK_LOST │──────────────→│ REJOIN_OK │
  │  (离线)   │              │  灯亮,3s后 │
  └──────────┘              │  上报RW    │
                            └───────────┘
```

## 四、配网期间的三个工程细节

### 4.1 上电已入网时不要急着采集

POWER_ON_ONLINE 分支里有一段值得抄作业的注释：

> Do NOT trigger immediate calc here: HLW8110 init verify runs 200ms after boot and occupies the async state machine. Immediate calc would race with verify and get accepted first (sg_state_busy starts FALSE), blocking verify entirely.

两个异步任务抢同一个状态机时，**必须规定谁先谁后**。规则：上电 200ms 的芯片校验（verify）优先，首次真实采集等 10 秒周期定时器自然触发。这类"初始化竞态"在事件驱动架构里极其常见——症状是"偶发第一次读数全零"，排查方向就是启动早期的任务编排。

### 4.2 心跳与时间的配置时机

`tal_time_sync_period_set(60 * 1000)` 在 `init_second`，而 `tal_heartbeat_period_set(60000)` 在 `init_last`——前者是协议栈服务，后者涉及"向云报版本号"属于业务。后面的 OTA 篇会看到，这个 60 秒心跳是 OTA 升级成功的最后一公里。

### 4.3 状态回调里只做"记账"，不做"重活"

看看每个 case 的函数清单：设标志、切 LED、启停定时器、（最多）调恢复出厂。**没有一个 case 直接发送 Zigbee 数据**——所有发送都推给定时器延后执行。原因和第 02 篇一样：状态回调运行在协议栈的上下文里，在里面发数据容易和栈内队列操作纠缠出诡异时序。

## 五、踩坑实录

**坑 1：JOIN_OK 里立刻全量上报 → 满屏 QUEUE_FULL_ERR。**
前文详解。记住数字：**SDK QOS_1 队列 15 槽**，入网管理流量持续约 3-6 秒。

**坑 2：离线就停采集 → LCD 冻结，用户以为死机。**
修复之前的行为。修正原则：**采集/显示自治，上报受闸门控制**。

**坑 3：首次配网上报一次就完事 → App 偶尔缺配置。**
APS 路由未建立时 QOS_0 静默丢帧，没有错误回调。对策：JOIN_OK 6s 后报一轮 + 5s 后再报一轮备份。

**坑 4：三连上电误触发。**
多半是 5 秒清零定时器没启动，或者看门狗复位没排除。检查三连上电处理的两个分支是否都启动了 `etimer_clr_rst_cnt_delay`。

## 六、验证方法

1. **首次配网**：长按 5 秒 → LED 快闪 → 6 秒内常亮 → App 出现设备 → 串口 log 里 `report_all_rw` 出现两次（6s 和 11s 各一次）；
2. **三连上电**：正常通电状态下 5 秒内快速断电上电 3 次 → 第 3 次上电后自动进入快闪配网；
3. **断网自救**：设备在线时关掉网关 → log 出现 `nwk_lost---` → LED 灭但 LCD 数据仍在刷新 → 打开网关 → `rejoin_ok---` → LED 亮，3 秒后 RW 配置重新上报；
4. **网关删除**：App 里删除设备 → `remote_leave---` → 设备自动重新入网（无需按键）→ App 重新出现设备且电量从零开始。

## 七、小结

- 配网入口统一为 `tal_zg_join_start`，但触发姿势可以有很多种（长按、三连上电、网关删除后自动重连）；
- 三连上电 = KV 计数 + 0xA5 冷启动魔数 + 5 秒清零窗口，三个机制缺一不可；
- 网络状态机是本项目的"总调度"：**离线不停采集、在线延迟上报、配网暂停业务、删除自动回家**；
- 首次入网的 6 秒延迟 + 5 秒备份上报，是拿 QUEUE_FULL_ERR 和静默丢帧换来的经验；
- 状态回调只记账不干活，所有 Zigbee 发送推给定时器。

至此设备已经能在 App 里"在线"了——但它还不会"说话"。下一篇解剖本项目的数据命脉：Tuya 私有簇 0xEF00 的 DP 协议，从 ZCL 帧到 DP 帧的逐字节结构，实现网关 ↔ 设备的双向通信。

---

*上一篇：[03 手脚] · 系列目录 · 下一篇：[05 语言：Tuya 私有簇 0xEF00 与 DP 协议]*
