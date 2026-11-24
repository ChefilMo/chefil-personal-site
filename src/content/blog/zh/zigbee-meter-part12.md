---
title: "12 · 进化：OTA 升级全流程"
description: "打通 Zigbee 设备 OTA 空中升级全链路，复盘心跳配置、Flash 冲突、身份校验等四大真实故障的排查与修复。"
pubDate: 2026-11-24
lang: zh
translationKey: zigbee-meter-part12
tags: [嵌入式, Zigbee, 教程]
series: zigbee-meter
seriesOrder: 12
category: embedded
---

> 目标：打通空中升级链路，复盘“App 收不到升级成功”“OTA 变砖”等真实故障的排查与修复

---

## 一、OTA 在 Zigbee 里是怎么工作的？

固件发布后发现 bug 怎么办？Zigbee 设备装进了配电箱，不可能拆回来插线刷机——**OTA（Over-The-Air）是唯一解**。

Zigbee OTA 的架构是“云 → 网关 → 设备”两级推送：

```
涂鸦云（存储 UG 固件，决定给谁推）
   │
   │ ① 云端通知网关：设备 X 有新固件 1.0.1
   ▼
网关（Zigbee 协调器，OTA Server 角色）
   │
   │ ② OTA 簇（0x0019）命令：Image Notify / Query Next Image Response
   │ ③ 分块传输：固件切成 ~50-100 字节的 APS 帧，逐块发送
   ▼
设备（OTA Client 角色，SDK 内置状态机）
   │
   │ ④ 写 Flash（固件暂存区）→ 校验 CRC → 切换运行镜像
   ▼
重启运行新固件
```

应用层要做的其实不多：**OTA 簇的接收处理由 SDK 框架完成**，我们只需在四个回调里做“配合动作”。但“配合”的每个细节都可能是坑——本项目在 OTA 上连踩四坑，全部记录在项目实际的修复历史里，本篇逐一复盘。

## 二、应用层的四个配合动作

### 2.1 消息分流：别碰 OTA 状态机

第 02/05 篇见过的消息回调里有一个特殊分支：

```c
case CLUSTER_OTA_BOOTLOAD_CLUSTER_ID: {     /* 0x0019 */
    /* OTA messages are handled by the SDK framework internally.
     * Log only; do not interfere with the OTA state machine. */
    TAL_PR_DEBUG("ota: framework handles cluster 0x%02x cmd 0x%02x", msg->cluster, msg->command);
    break;
}
```

OTA 簇的消息由 SDK 内部的 OTA 状态机消费（Image Block Request 的自动应答等）。如果应用层在这里也调 `tal_zg_send_data` 去回什么帧，就会和状态机的应答撞车——轻则双倍流量，重则状态机错乱。**规则：OTA 簇只观察，不行动。**

### 2.2 OTA 开始：暂停一切 Flash 写入

`tal_zg_ota_start_callback`：

```c
VOID_T tal_zg_ota_start_callback(UINT_T image_size, VOID_T *argv)
{
    TAL_PR_DEBUG("ota: start, image_size=%d", image_size);

    app_meter_read_pause();                      /* 停计量采集 */
    app_meter_read_stop_timers();                /* 停 NV 存档 + 小时电量定时器 */
    tal_sw_timer_stop(etimer_periodic_report);   /* 停周期上报 */

    app_led_set_mode_force(LED_MODE_SLOW_BLINK); /* 慢闪 = 升级中 */
}
```

**为什么要停掉所有定时器？** Flash 是共享资源：OTA 下载过程在持续擦写 Flash（TLSR8258 单 Flash 架构，程序和数据共存），如果此时电量数据的 NV 存档也触发一次 KV 写入，两次擦写可能交错——轻则 KV 数据损坏，重则 OTA 镜像校验失败变砖。这不是理论风险，是项目实际修复过的真实场景。

三个暂停动作的覆盖面：计量采集（`pause`）防止采集回调里触发写操作；NV/小时定时器（`stop_timers`）挡住周期写盘；周期上报停掉防止上报路径里的 KV 写入（报警锁存写 KV，第 11 篇）。**OTA 期间的纪律就是一句话：Flash 只归 OTA 用。**

LED 慢闪（1500ms 周期）是用户语义：“设备在升级，别断电”。慢闪周期从 750ms 调到 1500ms——太快像报警，太慢像呼吸，1500ms 是“明显但不焦虑”的节奏。

### 2.3 OTA 结束：成功等重启，失败全恢复

```c
VOID_T tal_zg_ota_end_callback(UINT8_T result)
{
    if (result == 0) {
        /* 成功：LED 常亮后由 SDK 框架重启 */
        app_led_set_mode(LED_MODE_ON);
    } else {
        /* 失败：恢复正常业务 */
        app_meter_read_resume();
        app_meter_read_start_timers();
        tal_sw_timer_start(etimer_periodic_report, PERIODIC_REPORT_INTERVAL_MS, TAL_TIMER_ONCE);
        app_led_set_mode(LED_MODE_OFF);
    }
}
```

成功路径故意“什么都不做”：重启由 SDK 在回调返回后执行，应用层只点个常亮 LED 给用户最后的视觉确认。失败路径是暂停动作的精确逆操作——`resume` / `start_timers` / 重启周期上报，一个不能少。

### 2.4 版本心跳：升级成功的最后一公里

这是本项目 OTA 史上最大的坑（OTA 三连修的最后一修：*App 端收不到升级成功状态*）。

**症状**：OTA 明明成功了——设备重启、新功能生效、log 显示新版本号——但 App 上永远显示“升级中”，最后超时变“升级失败”。

**排查链**：

1. 设备重启后重新入网，这没问题；
2. 入网后 SDK 会自动向网关上报应用版本——**但前提是心跳机制被正确配置**；
3. 看代码：`tal_heartbeat_period_set(60000)` 被调用了吗？—— 早期版本有这行代码但被注释掉了；解开注释后参数写成了 `30*000`……这是 C 语言里 `*` 和 `000` 凑出的合法表达式（30×000 = 0），心跳周期为 0 = 永不心跳！

**根因：心跳没配，云端永远不知道设备的新版本，升级流程永远停在“等待确认”。**

修复就是第 02 篇 `tuya_init_last` 里的那两行：

```c
tal_heartbeat_period_set(60000);         /* 每 60s 报一次 */
tal_heartbeat_type_set(HEARTBEAT_APP_VERSION);   /* 报的是应用版本 */
```

**教训：C 语言的表达式错误不一定报错**。`30*000` 编译通过、运行正常（心跳周期 0），但语义全错。这种“语法正确、语义荒谬”的代码，code review 时最容易漏——看到 `30*000` 这样的写法，任何人都会以为是个笔误而跳过。

## 三、坑位复盘：四个 OTA 故障的完整档案

### 档案 1：App 收不到升级成功
上文详解。关键词：心跳、版本上报、`30*000`。

### 档案 2：OTA 期间 Flash 冲突
症状：OTA 偶发失败，设备重启后跑的还是旧固件（或者更糟：起不来）。
根因：OTA 下载期间电量 NV 存档并发写 Flash。
修复：`tal_zg_ota_start_callback` 里 `app_meter_read_stop_timers()`；失败回调里 `start_timers()` 恢复。

### 档案 3：OTA 根本不开始
症状：云端发起了升级，设备毫无反应，连 `ota: start` log 都没有。
根因：端点设备类型报的是 `ZG_DEVICE_ID_ON_OFF_PLUGIN_UNIT`，与涂鸦云平台的产品配置（智能插座）不匹配，云端不下发 OTA 任务。
修复：端点注册时设备类型改 `ZG_DEVICE_ID_SMART_PLUG`。
教训：**OTA 链路的每一跳都有“身份校验”**——PID（云产品）、型号（Basic 簇）、设备类型（端点描述符），任何一处对不上，任务根本不会到达设备。排查“OTA 没反应”类问题，从云到设备逐跳查身份。

### 档案 4：升级状态不可感知（UX 层面）
症状：升级进行中用户不知道，升级完了也没反馈。
修复：慢闪（进行中）→ 常亮（成功重启前）的 LED 语言体系。

## 四、OTA 固件的生成与版本管理

构建产物两个 bin 的分工（第 01 篇讲过）：

| 文件 | 内容 | 用途 |
|------|------|------|
| `*_QIO_1.0.0.bin` | Bootloader + 应用（完整镜像） | BDT 烧录 |
| `*_UG_1.0.0.bin` | 应用部分（OTA 载荷） | 云端 OTA 推送 |

**版本号是 OTA 的比对核心**：构建命令的第三个参数 `1.0.0` 会编进固件（`FW_VERSION_HEX`），设备心跳上报它，云端拿它和目标版本比对决定升不升。

版本管理的三条纪律：

1. **版本号只增不减**。云端永远向“版本低于目标”的设备推送，版本号倒退（或相等）的设备收不到任务。出 hotfix 时用 `1.0.1`、`1.0.2` 递增；
2. **UG bin 必须和 QIO bin 同源构建**。别拿 1.0.0 的 QIO 和 1.0.1 的 UG 混着烧——设备报告的版本和实际代码对不上，OTA 状态机会陷入“永远需要升级”的死循环；
3. **OTA 前先在开发环境做“断电演练”**：升级中途断电，设备应能回滚到旧固件（SDK 的双镜像机制）或至少进入可重试状态。TLSR8258 平台的 OTA 采用“暂存区 + 校验后切换”，断电最坏情况是停在旧版本，不会变砖——但要实测确认。

## 五、OTA 的回归测试清单

发布一个 OTA 版本前，逐项过：

- [ ] **正常路径**：1.0.0 → 1.0.1，升级中 LED 慢闪，完成后自动重启，App 显示“升级成功”（依赖心跳，最多 60s 延迟）；
- [ ] **失败路径**：人为制造弱信号（遮挡天线），升级中断，`ota: end, result!=0`，设备恢复正常业务（定时器重启、采集继续、LED 正常）；
- [ ] **中途断电**：升级 50% 时断电重启 → 设备跑旧固件且工作正常 → 云端重新推送可成功；
- [ ] **业务中断检查**：升级期间 KV 写入计数应为 0（`stop_timers` 生效）；
- [ ] **心跳配置检查**：log 里每 60s 出现一次 `heartbeat: ...`（`tal_heartbeat_report_callback` 的打印）；
- [ ] **版本一致性**：升级后 `Application version` log 与目标版本一致。

## 六、小结

- Zigbee OTA = 云推网关、网关分块传设备、SDK 写暂存区校验切换；应用层只做四个配合动作（分流、暂停、恢复、心跳）；
- `ota_start` 里停掉**一切** Flash 写入源，OTA 期间 Flash 是独占资源；
- “App 收不到升级成功”的元凶是心跳版本上报没配置——以及一个 `30*000=0` 的 C 语言表达式陷阱；
- “OTA 不开始”查身份三角：PID、型号、设备类型；
- LED 慢闪/常亮构成升级过程的用户语言；
- 版本号只增不减，QIO 与 UG 同源，发布前过断电演练。

至此，一台电表从硬件驱动到云端通信到自我进化的完整链路全部打通。最后一篇收个尾：整机联调方法论、全笔画测试、量产烧录与授权，以及这个项目的完整进化史。

---

*上一篇：[11 裁判] · 系列目录 · 下一篇：[13 收官：整机联调、量产之路与项目复盘]*
