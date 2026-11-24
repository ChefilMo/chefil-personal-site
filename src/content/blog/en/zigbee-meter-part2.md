---
title: "02 · The Skeleton: TuyaOS Four-Stage Lifecycle and Zigbee Device Registration"
description: "Master the TuyaOS four-stage boot lifecycle and how to register endpoints, clusters, and attributes so the Zigbee gateway can “see” your device."
pubDate: 2026-11-24
lang: en
translationKey: zigbee-meter-part2
tags: [Embedded, Zigbee, Tutorial]
series: zigbee-meter
seriesOrder: 2
category: embedded
---

> Goal: fully understand the TuyaOS boot flow, register the device into the Zigbee network, and make the gateway “see” it

---

## 1. Building a Zigbee Worldview First: Endpoints, Clusters, Attributes

Before writing a single line of registration code, you must understand the three-layer model of the Zigbee application layer. Here’s an analogy: **a building (the device) has many rooms (endpoints), each room has mailboxes (clusters) on the wall, and the mailboxes hold attributes**.

- **Endpoint**: a device can have multiple logical functional units. A “smart power strip,” for example, might use endpoint 1 for switch 1 and endpoint 2 for switch 2. Our meter has only one functional unit, so it has only endpoint 1.
- **Cluster**: a collection of related attributes with a 16-bit ID. Standard clusters include On/Off (0x0006) and Simple Metering (0x0702); Tuya’s private cluster is **0xEF00** — 99% of this project’s data travels through it.
- **Attribute**: a concrete data item inside a cluster, e.g. 0x0004 (manufacturer name) and 0x0005 (model) in the Basic cluster.

When gateway and device discover each other, they exchange a “Simple Descriptor”: which clusters live on my endpoint 1, and which attributes each cluster has. This descriptor is exactly what we are about to register.

## 2. The TuyaOS Four-Stage Lifecycle

The four lines of log printed on the UART after flashing in Part 1 correspond to four init callbacks the application layer implements. They are not split arbitrarily — **what each stage may and may not do is hard-regulated by the SDK**:

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

Here is what each stage actually does in this project (all concentrated in the lifecycle callback file):

**`tuya_init_first()`** — does only two things:

```c
tal_uart_init(USER_UART0, &uart_cfg);   /* 115200 8N1，此时给 log 暂用 */
tal_log_create_manage_and_init(TAL_LOG_LEVEL_DEBUG, 128, (CONST TAL_LOG_OUTPUT_CB)Tl_printf);
tal_zigbee_local_auto_func_enable();    /* 启用本地联动（网关离线时设备间本地场景） */
```

Why must the log system be initialized first? Because the following three stages rely entirely on `TAL_PR_DEBUG` for debugging — without logs you’re groping in the dark.

**`tuya_init_second()`** — register the Zigbee device + create software timers:

```c
tal_sw_timer_create(__app_network_join_start_delay_cb, NULL, &etimer_join_start_delay);
tal_sw_timer_create(app_clr_rst_cnt_delay_cb, NULL, &etimer_clr_rst_cnt_delay);
app_key_init();              /* 软件部分：创建扫描/多击定时器 */
app_adc_init();
dev_zigbee_init();           /* ★ 端点/簇注册（下一节细讲） */
tal_time_sync_period_set(60 * 1000);    /* 每 60s 与网关同步一次时间 */
app_power_on_check_rst_cnt_proc();      /* 上电 3 次配网检测（第 04 篇） */
```

> **Iron rule**: before `tal_zg_endpoint_register()` completes, **calling any Zigbee data-related API is forbidden** (neither sending DPs nor reading/writing attributes). The protocol stack hasn’t opened a file on you yet — where would you even send it? This is the most common beginner mistake: trying to report data inside `init_first`.

**`tuya_init_third()`** — GPIO initialization before factory testing:

```c
app_led_init();       /* PB5 推挽输出 */
app_key_init_hw();    /* PB4 上拉输入 + 下降沿 IRQ 注册 */
```

The button’s “software timer” is created in second while its “hardware IRQ” is registered in third. Why split them? Because IRQ registration depends on the protocol stack environment being ready, while timer creation only needs system services — this split runs through the button module design in Part 3.

**`tuya_init_last()`** — where the real business begins:

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

**`tuya_main_loop()`** — currently empty, but behind this empty function stands a military regulation: **all callbacks (the init series, timer callbacks, IRQ callbacks) must be non-blocking**. The TLSR8258 is a single-threaded, event-driven architecture — if you `while(1)` or `sleep(1s)` in any callback, the entire protocol stack freezes and the watchdog will restart it for you. Whenever you need to “wait a while,” cut the work into small slices with software timers — the hardest driver in this project, HLW8110 (Part 7), was saved by exactly this idea.

## 3. Registering a Zigbee Device: dev_zigbee_init() Dissected

`dev_zigbee_init()` is implemented in the device registration module and does three things: register endpoints, configure the node type, and configure the joining policy.

### 3.1 Attribute Table and Cluster Table

A ZCL attribute is described by a six-tuple `{attr_id, type, size, mask, ?, default_value}`. Here is this project’s server cluster table:

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

A few details worth pondering:

- **0xFFFD (Cluster Revision) must exist on every cluster** — a Zigbee 3.0 compliance requirement; without it the gateway’s conformance checks will complain;
- `ATTR_MASK_TOKEN_FAST` routes attribute changes through the fast token channel — standard practice, just copy it;
- **Tuya’s private cluster 0xEF00 registers only two “placeholder” attributes** (0x0000 and 0xFFFD) — real DP data does not travel via attribute read/write, but via **specific commands (0x00/0x05/0x06)** on this cluster. In other words, 0xEF00 is just a “parcel locker slot” for us: both sending and receiving stuff self-defined protocol frames into this slot. Part 5 dissects that frame.

### 3.2 Endpoint Descriptor

```c
TAL_ENDPOINT_T g_dev_endpoint_desc[] = {
    {1, ZHA_PROFILE_ID, ZG_DEVICE_ID_SMART_PLUG,
     SERVER_CLUSTER_NUM, (TAL_CLUSTER_T *)&g_app_server_cluster_list[0], 0, NULL},
};
```

Five key pieces of information: endpoint number 1, the ZHA profile, **device type ID**, server cluster table, and client cluster count 0.

**There is a real war story about the device type**: initially we reported `ZG_DEVICE_ID_ON_OFF_PLUGIN_UNIT` (plugin unit switch), and OTA upgrades kept failing. Only after switching to `ZG_DEVICE_ID_SMART_PLUG` (smart plug, 0x0051) did it match the Tuya cloud’s product configuration, and OTA worked immediately. The reason is very “ecosystem”: the Tuya cloud decides which OTA flow to push based on the device type + PID. Report the wrong type and the cloud won’t even send you the upgrade package.

Also note that **TuyaOS has already registered Basic (server), OTA (client), and Time (client) clusters on endpoint 1 by default** — do not register them again, or the Simple Descriptor will contain two Basic clusters and the gateway gets confused.

### 3.3 Node Configuration and Joining Policy

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

The combination of these two flags is interesting and worth every beginner’s reflection:

- `auto_join_power_on_flag = FALSE`: do **not** automatically join the network on power-up. Why? Because the meter must support the “switch gateways” scenario — if it rejoins the old network the moment it powers up, the user has no way to pair it to a new gateway. So it stays unjoined after power-up, waiting for the user to explicitly express the pairing intent via a “triple power-on” or a “5-second long press” (Part 4).
- `auto_join_remote_leave_flag = TRUE`: but after being **removed** by the gateway, automatically rejoin. This is foolproofing — if the device is deleted by mistake in the app, the meter comes back on its own, no climbing to the distribution box to press a button.

The `ZG_ROUTER` role means the device is mains-powered, never sleeps, and can even forward messages for other devices in the network. The SDK also links the router-specific precompiled library based on this role (battery-powered devices get the sleep_device set — don’t link the wrong one).

## 4. How Messages Flow In: Two Callback Chains

After the device is registered, messages from the gateway reach the application layer via `tal_zcl_specific_msg_recv_callback()`:

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

This switch is the “central sorting desk” for all gateway messages: 0xEF00 goes to the DP layer, and the OTA cluster is **look-but-don’t-touch** (the framework is handling it; poke it and you scramble the OTA state machine — during an early OTA fix in this project we deliberately added a comment to hammer this point home). `msg` carries the source address, source endpoint, payload pointer, and length; Part 5 will use it to dissect real packets.

The return value `ZCL_MSG_RET_SUCCESS` means “I’m done processing”; returning failure may send the SDK down the default handling path — a notorious source of weird bugs on multi-cluster devices.

## 5. Pitfall Log: “Mystical” Issues Caused by Init Order

**Pitfall 1: calling Zigbee APIs inside `init_first`.**
Symptoms: device reboots, hangs, or join fails. Cause: the protocol stack isn’t initialized. Read the rule once more: **before `tal_zg_endpoint_register()` in second, touch no Zigbee data API whatsoever**.

**Pitfall 2: doing time-consuming work inside init.**
All four init callbacks sit on the startup critical path. An early version of this project initialized the HLW8110 synchronously inside `init_last` (a string of register writes at 15ms intervals + a 50ms blocking read), making boot time unpredictable with occasional reboots. The final solution: `init_last` only issues the initialization command, and the real verification is deferred 200ms to an asynchronous state machine (`__on_verify_delay_cb`). Booting must be fast and deterministic — push all uncertain waiting to timers.

**Pitfall 3: device type/model inconsistent with the cloud platform.**
The `ZG_DEVICE_ID_SMART_PLUG` pitfall described above. Lesson: **the model_id/manufacture_name in app_config.yaml, the endpoint device type, and the cloud platform’s product configuration must all agree** — when debugging “the gateway doesn’t know me” issues, check this triangle.

## 6. Verification

At this point you still can’t send or receive data, but you can confirm things with a packet sniffer (e.g. Ubiqua or the Tuya gateway’s logs):

1. After power-up the device sends a Beacon Request, and the device type carried in the Beacon is Router;
2. During joining, when the gateway sends a Simple Descriptor Request, the device’s response shows endpoint 1 and cluster 0xEF00;
3. Add a log line to the `default` branch of `tal_zcl_specific_msg_recv_callback` and you can see management frames like Identify/Groups flowing.

## 7. Summary

- TuyaOS boots in four stages: **first (local peripherals) → second (Zigbee registration) → third (GPIO/IRQ) → last (business)** — the order is a hard SDK constraint, not a matter of style;
- Zigbee registration = endpoint descriptor + cluster table + attribute table + node/join configuration — `dev_zigbee_init()` handles it in one go;
- The private cluster 0xEF00 registers only placeholder attributes; real data travels via specific commands;
- The device type ID must match the cloud platform (the OTA pitfall);
- All callbacks must be non-blocking; push time-consuming work to timers.

In the next part we give the device “hands and feet”: a button that distinguishes single-click/double-click/triple-click/long-press using a GPIO interrupt + 20ms scan state machine, plus four LED blinking patterns built on a single software timer.

---

*Previous: [Part 1 Sharpening the Knife] · Series Index · Next: [Part 3 Hands and Feet: Button State Machine and LED Pattern Machine]*
