---
title: "02 · 骨架：TuyaOS 四段式生命周期与 Zigbee 设备注册"
description: "彻底搞懂 TuyaOS 四段式启动生命周期，掌握端点/簇/属性注册方法，让 Zigbee 网关能“看见”设备。"
pubDate: 2026-11-24
lang: zh
translationKey: zigbee-meter-part2
tags: [嵌入式, Zigbee, 教程]
series: zigbee-meter
seriesOrder: 2
category: embedded
---

> 目标：彻底搞懂 TuyaOS 的启动流程，把设备注册进 Zigbee 网络，让网关能"看见"它

---

## 一、先建立 Zigbee 的世界观：端点、簇、属性

在写任何一行注册代码之前，必须理解 Zigbee 应用层的三层模型。用一个类比：**一栋楼（设备）里有多个房间（端点），每个房间里挂着若干信箱（簇），信箱里存着属性（Attribute）**。

- **端点（Endpoint）**：一个设备可以有多个逻辑功能单元。比如一个"智能插排"可能端点 1 是开关 1、端点 2 是开关 2。电表只有一个功能单元，所以只有端点 1。
- **簇（Cluster）**：一组相关属性的集合，有 16 位 ID。标准簇比如 On/Off（0x0006）、Simple Metering（0x0702）；涂鸦的私有簇是 **0xEF00**——本项目 99% 的数据都走它。
- **属性（Attribute）**：簇里的具体数据项，比如 Basic 簇的 0x0004（厂商名）、0x0005（型号）。

网关和设备互相发现时，会交换"简单描述符"（Simple Descriptor）：我的端点 1 上有哪些簇、每个簇有哪些属性。这个描述符就是我们接下来要注册的内容。

## 二、TuyaOS 的四段式生命周期

上一篇烧录后串口打出的四行 log，对应应用层实现的四个 init 回调。它们不是随意分的，**每个阶段能做什么、不能做什么，SDK 有硬性规定**：

```
上电
 │
 ▼
tuya_init_first()     ── 协议栈还没醒，只能初始化"纯本地"的外设
 │
 ▼
tuya_init_second()    ── TuyaOS 内部组件就绪，注册 Zigbee 端点/簇
 │
 ▼
tuya_init_third()     ── 协议栈就绪、产测之前，初始化 GPIO/IRQ
 │
 ▼
tuya_init_last()      ── 产测之后，初始化业务（数据模型、定时器、外设驱动）
 │
 ▼
tuya_main_loop()      ── 主循环，反复回调，绝对禁止阻塞
```

对照本项目每个阶段的实际内容（全部集中在生命周期回调文件里）：

**`tuya_init_first()`** —— 只干两件事：

```c
tal_uart_init(USER_UART0, &uart_cfg);   /* 115200 8N1，此时给 log 暂用 */
tal_log_create_manage_and_init(TAL_LOG_LEVEL_DEBUG, 128, (CONST TAL_LOG_OUTPUT_CB)Tl_printf);
tal_zigbee_local_auto_func_enable();    /* 启用本地联动（网关离线时设备间本地场景） */
```

为什么 log 系统必须第一个初始化？因为后面三个阶段全靠 `TAL_PR_DEBUG` 排错，没有 log 就是瞎子摸象。

**`tuya_init_second()`** —— 注册 Zigbee 设备 + 创建软件定时器：

```c
tal_sw_timer_create(__app_network_join_start_delay_cb, NULL, &etimer_join_start_delay);
tal_sw_timer_create(app_clr_rst_cnt_delay_cb, NULL, &etimer_clr_rst_cnt_delay);
app_key_init();              /* 软件部分：创建扫描/多击定时器 */
app_adc_init();
dev_zigbee_init();           /* ★ 端点/簇注册（下一节细讲） */
tal_time_sync_period_set(60 * 1000);    /* 每 60s 与网关同步一次时间 */
app_power_on_check_rst_cnt_proc();      /* 上电 3 次配网检测（第 04 篇） */
```

> **一条铁律**：`tal_zg_endpoint_register()` 完成之前，**禁止调用任何 Zigbee 数据相关 API**（发 DP、读写属性都不行）。协议栈还没建档，你往哪儿发？这是新手最容易犯的错——在 `init_first` 里就想上报数据。

**`tuya_init_third()`** —— 产测前的 GPIO 初始化：

```c
app_led_init();       /* PB5 推挽输出 */
app_key_init_hw();    /* PB4 上拉输入 + 下降沿 IRQ 注册 */
```

按键的"软件定时器"在 second 创建、"硬件 IRQ"在 third 注册，为什么要拆开？因为 IRQ 注册依赖协议栈环境就绪，而定时器创建只需要系统服务——这个拆分会贯穿第 03 篇的按键模块设计。

**`tuya_init_last()`** —— 业务正式开始的地方：

```c
app_meter_data_init();            /* 数据模型：从 KV 读 RW 配置，初始化继电器 */
tal_sw_timer_create(__app_periodic_report_cb, NULL, &etimer_periodic_report);
tal_sw_timer_create(__app_report_all_delay_cb, NULL, &etimer_report_all_delay);
tal_sw_timer_create(__app_report_all_retry_cb, NULL, &etimer_report_all_retry);
app_dp_transmit_queue_init();     /* DP 发送队列（第 09 篇的主角） */
app_meter_read_init();            /* 计量层：HLW8112/8110 初始化 + LCD + NV 电量 */
tal_heartbeat_period_set(60000);  /* 每 60s 心跳，OTA 升级成功的关键（第 12 篇） */
tal_heartbeat_type_set(HEARTBEAT_APP_VERSION);
```

**`tuya_main_loop()`** —— 目前是空的，但这个空函数背后是一条军规：**所有回调（init 系列、定时器回调、IRQ 回调）都必须非阻塞**。TLSR8258 是单线程事件驱动架构，你在任何回调里 `while(1)` 或者 `sleep(1s)`，整个协议栈就冻住了，看门狗会替你重启。需要"等一会儿"的场景，一律用软件定时器把自己切成多个小片段——本项目最难的 HLW8110 驱动（第 07 篇）就是靠这个思想救活的。

## 三、注册一个 Zigbee 设备：dev_zigbee_init() 全解

`dev_zigbee_init()` 在设备注册模块中实现，它做三件事：注册端点、配置节点类型、配置配网策略。

### 3.1 属性表与簇表

ZCL 的属性用 `{attr_id, type, size, mask, ?, default_value}` 六元组描述。本项目的服务端簇表：

```c
/* 以 Identify 簇为例 */
#define IDENTIFY_ATTR_LIST \
    {0x0000, ATTR_INT16U_ATTRIBUTE_TYPE, 2, (ATTR_MASK_TOKEN_FAST), 0, ((UINT8_T *)0x0005)}, \
    {0xFFFD, ATTR_INT16U_ATTRIBUTE_TYPE, 2, (ATTR_MASK_READABLE), 0, ((UINT8_T *)0x0001)},

const TAL_CLUSTER_T g_app_server_cluster_list[] = {
    DEF_CLUSTER_IDENTIFY_CLUSTER_ID(identify_attr_list)      /* 0x0003 */
    DEF_CLUSTER_GROUPS_CLUSTER_ID(group_attr_list)           /* 0x0004 */
    DEF_CLUSTER_SCENES_CLUSTER_ID(scene_attr_list)           /* 0x0005 */
    DEF_CLUSTER_PRIVATE_TUYA_CLUSTER_ID(private_attr_list)   /* 0xEF00 ★ */
};
```

几个值得琢磨的细节：

- **0xFFFD（Cluster Revision）每个簇都要有**，这是 Zigbee 3.0 的规范性要求，缺了网关的合规性检查会挑刺；
- `ATTR_MASK_TOKEN_FAST` 是让属性变化走快速令牌通道，标准做法，抄即可；
- **涂鸦私有簇 0xEF00 只注册了两个"占位"属性**（0x0000 和 0xFFFD）——真正的 DP 数据不走 attribute 读写，而是走这个簇上的**特定命令（0x00/0x05/0x06）**。也就是说 0xEF00 对我们来说只是个"快递柜格口"，收发都往这个格口里塞自协议帧。第 05 篇专门解剖这个帧。

### 3.2 端点描述符

```c
TAL_ENDPOINT_T g_dev_endpoint_desc[] = {
    {1, ZHA_PROFILE_ID, ZG_DEVICE_ID_SMART_PLUG,
     SERVER_CLUSTER_NUM, (TAL_CLUSTER_T *)&g_app_server_cluster_list[0], 0, NULL},
};
```

五个关键信息：端点号 1、ZHA 协议 profile、**设备类型 ID**、服务端簇表、客户端簇数量 0。

**设备类型这里有个真实的踩坑故事**：最初报的是 `ZG_DEVICE_ID_ON_OFF_PLUGIN_UNIT`（插件式开关），结果 OTA 升级一直失败。改成 `ZG_DEVICE_ID_SMART_PLUG`（智能插座，0x0051）后才与涂鸦平台的产品配置对上，OTA 立刻通了。原因很"生态"：涂鸦云根据设备类型 + PID 决定给它推哪种 OTA 流程，报错了类型，云端连升级包都不会下发。

另外注意 **TuyaOS 默认已在端点 1 帮我们注册了 Basic（server）、OTA（client）、Time（client）三个簇**，不要重复注册——否则简单描述符里出现两个 Basic，网关会犯迷糊。

### 3.3 节点配置与配网策略

```c
STATIC VOID_T app_router_node_init(VOID_T)
{
    TAL_ZG_NODE_CFG_T node_config = {
        .node_type = ZG_ROUTER,                       /* 路由器角色 */
        .tx_power = ZIGBEE_DEFAULT_TX_POWER_DB,
        .scan_interval = ZIGBEE_BEACON_SEND_INTERVAL_MS,
        .scan_duration = ZG_SCAN_DURATION_3,          /* 153.6ms */
    };
    tal_zg_node_config(&node_config);
}

STATIC VOID_T dev_joined_config(VOID_T)
{
    TAL_ZG_JOIN_CFG_T join_config = {
        .auto_join_power_on_flag = FALSE,       /* 上电不自动配网！ */
        .auto_join_remote_leave_flag = TRUE,    /* 被网关删除后自动重连 */
        .join_timeout = ZIGBEE_JOIN_MAX_TIMEOUT_MS,
    };
    tal_zg_join_config(&join_config);
}
```

两个 flag 的组合很有意思，值得新手体会：

- `auto_join_power_on_flag = FALSE`：上电**不**自动加入网络。为什么？因为电表要支持"换网关"场景——如果上电就自动回旧网络，用户根本没法把它配到新网关。所以上电后保持未入网状态，等用户"三连上电"或"长按 5 秒"明确表达配网意图（第 04 篇）。
- `auto_join_remote_leave_flag = TRUE`：但被网关**删除**后自动重新加入。这是防呆——App 里误删设备后，电表能自己回来，不用爬到配电箱去按按键。

`ZG_ROUTER` 角色意味着设备常供电、不睡眠、还能帮网络里的其他设备转发消息。SDK 也根据这个角色链接 router 对应的预编译库（给电池设备的是 sleep_device 那套，别链错）。

## 四、消息是怎么流进来的：两条回调链

设备注册完之后，网关发来的消息通过 `tal_zcl_specific_msg_recv_callback()` 送达应用层：

```c
TAL_MSG_RET_E tal_zcl_specific_msg_recv_callback(TAL_ZCL_MSG_T *msg)
{
    TAL_PR_DEBUG("app spec msg cb: cluster 0x%02x, cmd 0x%02x", msg->cluster, msg->command);

    switch (msg->cluster) {
    case CLUSTER_PRIVATE_TUYA_CLUSTER_ID:            /* 0xEF00 */
        app_dp_transmit_recv_handler(msg);           /* → DP 协议层 */
        break;
    case CLUSTER_OTA_BOOTLOAD_CLUSTER_ID:            /* 0x0019 */
        /* OTA 由 SDK 框架内部处理，这里只 log，千万别碰状态机 */
        break;
    default:
        break;
    }
    return ZCL_MSG_RET_SUCCESS;
}
```

这个 switch 是全网关消息的"总分拣台"：0xEF00 的转给 DP 层，OTA 簇的**只看不摸**（框架在处理，你插手就搅乱 OTA 状态机——项目早期一次 OTA 修复中特意加了注释强调这一点）。`msg` 里带着源地址、源端点、负载指针和长度，第 05 篇会拿它解剖真实报文。

返回值 `ZCL_MSG_RET_SUCCESS` 表示"我处理完了"；如果返回失败，SDK 可能会走默认处理路径——多簇设备里这是常见的灵异 bug 来源。

## 五、踩坑实录：init 顺序引发的"玄学"问题

**坑 1：在 `init_first` 里调用 Zigbee API。**
症状：设备重启、卡死、或 join 失败。原因：协议栈未初始化。规则再念一遍：**second 的 `tal_zg_endpoint_register()` 之前，不碰任何 Zigbee 数据 API**。

**坑 2：在 init 里做耗时操作。**
四个 init 回调都在启动关键路径上。本项目早期版本在 `init_last` 里直接同步初始化 HLW8110（一串 15ms 间隔的寄存器写 + 50ms 阻塞读），导致启动时间不可控、偶看重启。最终方案：`init_last` 里只发初始化命令，真正的校验推迟 200ms 后由异步状态机执行（`__on_verify_delay_cb`）。启动要快、要确定——不确定的等待全部推给定时器。

**坑 3：设备类型/型号与云平台不一致。**
前面讲的 `ZG_DEVICE_ID_SMART_PLUG` 之坑。教训：**app_config.yaml 的 model_id/manufacture_name、端点设备类型、云平台产品配置，三者必须一致**，排查"网关不认识我"类问题时按这个三角查。

## 六、验证方法

走到这一步，虽然还不能收发数据，但可以用抓包工具（如 Ubiqua 或涂鸦网关的日志）确认：

1. 设备上电后发出 Beacon Request，且 Beacon 里携带的 device type 是 Router；
2. 入网过程中网关发来 Simple Descriptor Request 时，设备的应答里能看到端点 1、簇 0xEF00；
3. `tal_zcl_specific_msg_recv_callback` 里给 `default` 分支加一行 log，能看到 Identify/Groups 等管理帧在流动。

## 七、小结

- TuyaOS 是四段式启动：**first（本地外设）→ second（注册 Zigbee）→ third（GPIO/IRQ）→ last（业务）**，顺序是 SDK 的硬性约束而非风格问题；
- Zigbee 注册 = 端点描述符 + 簇表 + 属性表 + 节点/配网配置，`dev_zigbee_init()` 一口气搞定；
- 私有簇 0xEF00 只注册占位属性，真正的数据走特定命令；
- 设备类型 ID 必须与云平台一致（OTA 之坑）；
- 一切回调非阻塞，耗时操作拆给定时器。

下一篇给设备装上"手脚"：用 GPIO 中断 + 20ms 扫描状态机实现一个能区分单击/双击/三击/长按的按键，再用一个软件定时器搭出 LED 的四种闪烁模式。

---

*上一篇：[01 磨刀] · 系列目录 · 下一篇：[03 手脚：按键状态机与 LED 模式机]*
