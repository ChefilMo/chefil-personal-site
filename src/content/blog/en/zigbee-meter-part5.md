---
title: "05 · Language: The Tuya Private Cluster 0xEF00 and the DP Protocol"
description: "A deep dive into the Tuya DP protocol: the 0xEF00 private cluster, the 6-byte DP frame, the three command IDs and the type system for gateway-device communication, plus the famous queue-clearing bug."
pubDate: 2026-11-24
lang: en
translationKey: zigbee-meter-part5
tags: [Embedded, Zigbee, Tutorial]
series: zigbee-meter
seriesOrder: 5
category: embedded
---

> Goal: explain the Tuya DP protocol inside out — frame format, command IDs, type system — and get the gateway and the device talking to each other.

---

## 1. Why a “Private Cluster”?

By the end of the last post, the device could join the network — but “online” is only existence; “useful” requires conversation. And conversation requires a protocol.

The Zigbee Alliance defined standard metering clusters (Simple Metering 0x0702, Electrical Measurement 0x0B04), so in theory a meter should use them. But the reality of the Tuya ecosystem is: **the app panels, cloud automations, and voice-assistant integrations are all built around the DP (Data Point) device model**. DP is the universal language of the Tuya cloud — whether you're a Wi-Fi device or a Zigbee device, all the cloud ever sees is a list of DP ID + value pairs.

So Tuya did something very “engineering-minded” on top of Zigbee: define a private cluster **0xEF00** at the application layer, run only three command IDs on it, and carry a self-defined DP frame as payload. The Zigbee stack handles “deliver the bytes reliably to the other side”; the DP protocol handles “what these bytes actually mean”. Clean layering:

```
┌─────────────────────────────────────────────┐
│ 应用语义层：DP 帧                             │  dpid + type + value
├─────────────────────────────────────────────┤
│ 私有簇层：0xEF00 特定命令                     │  cmd 0x00 / 0x05 / 0x06
├─────────────────────────────────────────────┤
│ ZCL 层：Zigbee Cluster Library 帧头          │  frame control / seq / cmd id
├─────────────────────────────────────────────┤
│ APS / NWK / 802.15.4 层（SDK 与协议栈负责）   │  寻址 / 加密 / 重传
└─────────────────────────────────────────────┘
```

In our code we only need to care about the top two layers.

## 2. The DP Frame Format: A Worldview in Six Bytes

All 38 DPs share the same frame skeleton:

```
┌────────┬──────┬──────┬──────┬────────┬────────┬──────────┐
│ header │ seq  │ dpid │ type │ len_hi │ len_lo │ data[N]  │
│ 1 byte │ 1B   │ 1B   │ 1B   │ 1B     │ 1B     │ N bytes  │
└────────┴──────┴──────┴──────┴────────┴────────┴──────────┘
```

- **header**: fixed at 0x00 (reserved);
- **seq**: sequence number, echoed back in the response. In our simplified implementation it's always 0x00;
- **dpid**: data point ID — 1–138 are all defined in this project;
- **type**: data type, see the table below;
- **len**: data length, **big-endian** (len_hi first);
- **data**: payload. VALUE type is always 4 bytes big-endian; BOOL is 1 byte (0x00/0x01).

There are only 6 types:

| type | Meaning | data length |
|------|------|-----------|
| 0x00 | RAW | arbitrary |
| 0x01 | BOOL | 1 |
| 0x02 | VALUE (32-bit signed integer) | 4 |
| 0x03 | STRING | arbitrary |
| 0x04 | ENUM | 1 |
| 0x05 | BITMAP | 1/2/4 |

Of the 38 DPs in this project, only BOOL and VALUE are used. Every VALUE is a fixed-point number in the form “integer × 10^scale”: for example DP 101 (voltage, scale=1) reporting `2222` means 222.2 V; DP 1 (energy, scale=2) reporting `12345` means 123.45 kWh. **Why not send floating point? Because stuffing IEEE 754 into a Zigbee frame wastes bytes and invites endianness bugs — a fixed-point integer is the most painless cross-platform option.**

### Dissecting a Real Frame

Let's capture one frame of “device reports phase-A power 123.4 W” (DP 105, scale=1):

```
00 00 69 02 00 04 00 00 04 D2
│  │  │  │  │  │  └┬┘└┬──┘
│  │  │  │  │  │    │   └─ data = 0x000004D2 = 1234 → 123.4 W
│  │  │  │  │  │    └───── len = 0x0004
│  │  │  │  │  └────────── len_hi
│  │  │  │  └───────────── len_lo
│  │  │  └──────────────── type = 0x02 (VALUE)
│  │  └─────────────────── dpid = 105 = 0x69
│  └────────────────────── seq = 0
└───────────────────────── header = 0
```

## 3. Three Command IDs: A Question, an Answer, a Broadcast

```
0x00  Gateway → device: send down a DP (control command, e.g. “turn on the relay”)
0x05  Device → gateway: respond to 0x00 (echo the received frame back verbatim)
0x06  Device → gateway: proactive report (periodic data, alarms, state changes)
```

Note the design of 0x05: **the response is a verbatim echo**. After receiving a 0x00 frame from the gateway, the device sends the payload back untouched under command 0x05 — that serves as both an application-layer ACK and, handily, the semantics of “I received it and understood it”. It's far less work than designing a dedicated ACK frame format; the cost is that the response carries no “execution result” — success or failure is covered by a follow-up 0x06 proactive report (report the current value again after acting on it).

## 4. The Receive Path: From ZCL Message to Business Dispatch

The full call chain on receive (paying off the foreshadowing planted in Part 2):

```
tal_zcl_specific_msg_recv_callback()
  └─ cluster == 0xEF00
     └─ app_dp_transmit_recv_handler(msg)
        ├─ cmd == 0x00:
        │   1. 先回 0x05 应答（tal_zg_send_data, zcl_id=0x68）
        │   2. 解析 DP 帧 → __app_dp_business_handler()
        │   3. 业务分发：RW DPs → app_meter_data_set_dp() → KV 持久化
        │   4. 回报告知当前值（cmd 0x06，report_no_clear 版本）
```

### 4.1 Frame Parsing: Unpacking the Six-Byte Header

```c
STATIC BOOL_T __app_dp_frame_parse(UINT8_T *payload, UINT8_T payload_len, APP_DP_DATA_T *dp_data)
{
    if (payload == NULL || payload_len < DP_FRAME_HEADER_LEN || dp_data == NULL) {
        return FALSE;
    }
    dp_data->header = payload[0];
    dp_data->seq    = payload[1];
    dp_data->dpid   = payload[2];
    dp_data->type   = payload[3];
    dp_data->len    = ((UINT16_T)payload[4] << 8) | payload[5];   /* 大端长度 */

    if (payload_len < (DP_FRAME_HEADER_LEN + dp_data->len)) {     /* 长度自卫检查 */
        return FALSE;
    }
    dp_data->data = &payload[6];
    return TRUE;
}
```

Two defensive checks: the payload must have at least the 6-byte header; and the declared len must not exceed the actual payload. Frames coming over the air can carry dirty data due to buffer reuse inside the stack — boundary checks like these never hurt to write.

### 4.2 Business Dispatch: Only RW DPs Get In

```c
switch (dp_data->dpid) {
case DP_ID_SWITCH:
case DP_ID_POWER_SETTING_A:
/* ... 共 11 个可写 DP ... */
    if (dp_data->len > 0 && dp_data->data != NULL) {
        app_meter_data_set_dp(dp_data->dpid, dp_data->data, dp_data->len);  /* 落地 */
        /* 落地后立刻用 0x06 回报当前值 */
        app_dp_transmit_report_no_clear(..., QOS_1);
    }
    break;
default:
    /* dpid 不在写入口清单里，直接丢弃 */
    break;
}
```

One design decision deserves explanation: **only RW (writable) DPs are handled**. A 0x00 frame sent down by the gateway can, in theory, only ever be a write operation (RO data is owned solely by the device), so the default branch simply drops it. This switch is the device's entire “writable-DP registry” — any new writable DP must be registered here.

### 4.3 The zcl_id Battle Between Response and Report

Look at these two lines:

```c
/* 应答（0x05）与回报（0x06）用的是同一个 zcl_id = 0x68 */
send_data.zcl_id = 0x68;
...
tal_zg_clear_send_data(ZG_CLEAR_ALL_ZCL_ID, &send_data.zcl_id);   /* ★ 发前先清同 ID 的待发帧 */
```

What `tal_zg_clear_send_data` does: **clear all pending frames with the same zcl_id** from the SDK's send queue. The SDK's intention is good — the same zcl_id means “the same kind of message”, and having a new message bump off the old one prevents queue buildup. But it gave rise to this project's most famous bug: **during batch reporting, each subsequent DP wipes out the previous DP that hasn't been sent yet**.

Picture a full report of all 38 DPs: DP1 enqueued (not yet sent) → before DP2 enqueues, the queue is cleared, DP1 is gone → before DP3 enqueues, the queue is cleared, DP2 is gone … in the end only the last DP ever reaches the gateway. That's where the bolded sentence in the project docs comes from:

> **`app_dp_transmit_report` vs `app_dp_transmit_report_no_clear`: the former calls `tal_zg_clear_send_data` to wipe the pending queue of frames with the same zcl_id. Batch reports must use the `_no_clear` version.**

The full division of labor among the three send interfaces:

| Interface | Clears queue? | Use case |
|------|---------|------|
| `app_dp_transmit_report` | Yes | Single-shot: make sure the new value bumps off the old one |
| `app_dp_transmit_report_no_clear` | No | Batch: report-after-response, full report |
| `app_dp_transmit_report_immediate` | Yes + no queueing | Urgent: alarms, breaker trips, delay_time=0 |

You saw the practical use of `report_no_clear` in Part 4: the 0x05 response has just been enqueued, and if the 0x06 value-report went through the `report` version, it would wipe the response frame.

## 5. The Send Path: Three Essentials of Frame Building

Reporting boils down to filling in a `TAL_ZG_SEND_DATA_T` struct:

```c
send_data.qos          = qos;
send_data.delay_time   = sg_batch_delay_ms;      /* 批量时的错峰延迟 */
send_data.zcl_id       = 0x68;
send_data.direction    = ZG_ZCL_DATA_SERVER_TO_CLIENT;
send_data.frame_type   = ZG_ZCL_FRAME_TYPE_SPEC_TO_CLUSTER;
send_data.command_id   = DP_CMD_ID_REPORT;       /* 0x06 */

send_data.addr.mode    = SEND_MODE_DEV;
send_data.addr.type.dev.dst_addr  = TUYA_GATEWAY_ADDRESS;   /* 固定发网关 */
send_data.addr.type.dev.dst_ep    = 0x01;
send_data.addr.type.dev.cluster_id = CLUSTER_PRIVATE_TUYA_CLUSTER_ID;

/* DP 帧塞进 private.data（len 大端） */
send_data.data.private.data[0] = 0x00;           /* header */
send_data.data.private.data[1] = 0x00;           /* seq */
send_data.data.private.data[2] = dpid;
send_data.data.private.data[3] = type;
send_data.data.private.data[4] = (data_len >> 8) & 0xFF;
send_data.data.private.data[5] = (data_len >> 0) & 0xFF;
memcpy(&send_data.data.private.data[6], data, data_len);
```

A few key points:

- **The destination address is always the gateway** (`TUYA_GATEWAY_ADDRESS`). A Tuya sub-device never talks to the cloud directly; every frame goes to the gateway, which forwards it to the cloud — that's precisely what the word “sub-device” means;
- `frame_type = ZG_ZCL_FRAME_TYPE_SPEC_TO_CLUSTER` means “cluster-specific command” (as opposed to “global commands” like reading attributes). On 0xEF00 we only use cluster-specific commands;
- `direction = SERVER_TO_CLIENT`: 0xEF00 is a server-side cluster, and the device acts as the server sending data to the client (the gateway);
- `delay_time` and `sg_batch_delay_ms` are the batch staggering mechanism: +200 ms delay per frame, giving the protocol stack time to actually send. This is a transitional solution before a proper queue shows up — it gets replaced by a more complete queue in Part 9, but the staggering idea survives.

The QOS choice deserves a thorough explanation too (it directly affects reliability):

| QOS | Meaning | Used for |
|-----|------|--------|
| QOS_0 | Fire and forget, may silently drop | Ordinary periodic data |
| QOS_1 | Requires APS-layer ACK, auto-retransmits on loss | **All RW config DPs, alarms, switch states** |

## 6. Walking the Whole Chain: Turning On the Relay Remotely

The user taps “On” in the app; our relay pulls in. The full-chain timing:

```
App ──云端──► 网关
                 │  ZCL: cluster=0xEF00, cmd=0x00
                 ▼
        tal_zcl_specific_msg_recv_callback
                 │
                 ▼
        app_dp_transmit_recv_handler
          1. 回 0x05 应答（zcl_id=0x68, QOS_1）
          2. 解析 DP: dpid=16, type=BOOL, len=1, data=0x01
          3. __app_dp_business_handler → app_meter_data_set_dp
                 │
                 ▼
        sg_meter_data.switch_state = TRUE
        app_meter_data_switch_apply()  → PC0 输出高 → 继电器吸合 ★物理动作发生
        __meter_rw_save_to_kv()        → 立即写 KV 0x10 ★掉电不丢
          4. 回报：cmd 0x06, dpid=16, data=0x01（report_no_clear）
                 │
                 ▼
              网关 → 云端 → App 开关变成“开” ★状态闭环
```

The whole trip takes roughly 200–500 ms (depending on network conditions). Note that the physical action (step 3) happens **first** — act, then persist, then report. This ordering guarantees that even if the report is lost, the local state is already correct, and the next full report after rejoining will set the cloud straight.

## 7. The Standard Procedure for Adding a DP (A Checklist Worth Bookmarking)

Take “suppose we want to add DP 200: leakage-current alarm” as an example — six steps:

1. Add `#define DP_ID_LEAKAGE_ALARM 200` where the DP constants are defined;
2. Add a field `BOOL_T leakage_alarm;` to the struct of the central data structure;
3. Give it an initial value in the data-init function; if it needs to survive power loss, maintain a field copy in the KV read/write functions;
4. If it's writable: add a branch to the switch in the DP write interface; **and at the same time** register it in the business-dispatch switch (it's easy to miss one of the two switches);
5. Add `__report_bool_dp(DP_ID_LEAKAGE_ALARM, ...)` to the full-report / periodic-report function, and in the realtime path add a cached “report only on change” comparison;
6. Add a DP with the same name in the device model on the Tuya IoT platform — **the cloud and firmware dpid must match exactly**. This is the step most likely to flip the car: if the dpid used by the cloud platform doesn't match the macro in the code, the data “sends fine but is nowhere to be seen”.

## 8. War Stories from the Trenches

**Pit 1: VALUE endianness.**
The len field of a DP frame is big-endian, and so is the 4-byte VALUE data (`__int32_to_be`). When parsing: `value[0]<<24 | value[1]<<16 | value[2]<<8 | value[3]`. Whichever end you get wrong, the numbers will look “roughly right” (for small values) — but negatives and large values explode on the spot.

**Pit 2: The response frame didn't echo the peer's address.**
The `dst_addr/dst_ep` of `app_dp_transmit_response` must be taken **from the received msg** (`msg->src_addr`/`msg->src_ep`) — never hardcode the gateway address, because the gateway may have initiated the request from a different endpoint or address.

**Pit 3: The report wiped out the response frame by using `report`.**
Detailed above. The rule: **whenever a second frame is pending in one event chain, the first one must use `_no_clear`**.

**Pit 4: The platform's device-model dpid doesn't match the firmware.**
The cloud says dpid 132, the macro in the code says 133 — this kind of misalignment produces zero compile errors, and shows up as “the cloud receives nothing” or “control has no effect”. The debugging method: capture one 0xEF00 frame and check the dpids one by one.

## 9. How to Verify

1. **Downlink**: change the power threshold in the app → serial shows `DP recv: dpid=111` → immediately followed by `report DP 111 (VALUE) = ...`;
2. **Uplink**: after the periodic timer fires, use the gateway's packet-capture feature (or the `report DP xxx` lines in the serial log) to confirm the 0x06 frame arrives;
3. **Closed loop**: operate the switch in the app — within 500 ms the relay pulls in and the app state echoes back. If any link in the chain breaks, locate it with the timing diagram in Section 6.

## 10. Summary

- DP protocol = 6-byte header + data payload, three command IDs (0x00 downlink / 0x05 response / 0x06 report), six types but only BOOL + fixed-point VALUE are used;
- Receive chain: **respond first, parse in the middle, dispatch last**;
- `tal_zg_clear_send_data` clearing the queue by zcl_id is a double-edged sword — understand the division of labor among `report` / `_no_clear` / `immediate`;
- QOS_1 is for frames that “must arrive”; QOS_0 is for periodic data;
- The six-step checklist for adding a DP, and cloud-firmware dpid consistency is the biggest hidden pit.

The device can now talk — but it's still speaking “empty words”: all the RO data is still zero. In the next post we bring in the physical eyes of this project: **the HLW8112 metering chip**, light it up with SPI bit-banged via GPIO, and read out the real voltage, current, and power of phases A and B.

---

*Previous: [04 Joining the Network] · Series Index · Next: [06 Sensing (Part 1): HLW8112 SPI Dual-Channel Metering]*
