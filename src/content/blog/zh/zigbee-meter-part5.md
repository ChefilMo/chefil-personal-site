---
title: "05 · 语言：Tuya 私有簇 0xEF00 与 DP 协议"
description: "彻底讲透涂鸦 DP 协议：0xEF00 私有簇、6 字节 DP 帧、三个命令字与类型系统，实现网关与设备的双向通信，以及批量上报清队列的著名 bug。"
pubDate: 2026-11-24
lang: zh
translationKey: zigbee-meter-part5
tags: [嵌入式, Zigbee, 教程]
series: zigbee-meter
seriesOrder: 5
category: embedded
---

> 目标：彻底讲透 Tuya DP 协议——帧格式、命令字、类型系统，实现网关与设备的双向通信

---

## 一、为什么是“私有簇”？

上一篇末尾，设备已经能入网了，但“在线”只是存在，“有用”需要对话。对话需要协议。

Zigbee 联盟定义过标准的计量簇（Simple Metering 0x0702、Electrical Measurement 0x0B04），理论上电表应该用它们。但涂鸦生态的现实是：**App 面板、云端自动化、语音助手接入，全部围绕 DP（Data Point）物模型构建**。DP 是涂鸦云的通用语言——不管你是 Wi-Fi 设备还是 Zigbee 设备，云端看到的都是一串 DP ID + 值。

于是涂鸦在 Zigbee 上做了件很“工程”的事：在应用层定义一个私有簇 **0xEF00**，簇上只跑三个命令字，载荷是自协议的 DP 帧。Zigbee 栈负责“把字节可靠地送到对端”，DP 协议负责“这些字节代表什么语义”。分层干净利落：

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

我们写代码只需要关心最上面两层。

## 二、DP 帧格式：六个字节的世界观

全部 38 个 DP 共用同一个帧骨架：

```
┌────────┬──────┬──────┬──────┬────────┬────────┬──────────┐
│ header │ seq  │ dpid │ type │ len_hi │ len_lo │ data[N]  │
│ 1 byte │ 1B   │ 1B   │ 1B   │ 1B     │ 1B     │ N bytes  │
└────────┴──────┴──────┴──────┴────────┴────────┴──────────┘
```

- **header**：固定 0x00（保留位）；
- **seq**：序列号，应答时回显。简化实现里一直填 0x00；
- **dpid**：数据点 ID，1-138 本项目都有定义；
- **type**：数据类型，见下表；
- **len**：数据长度，**大端**（len_hi 在前）；
- **data**：负载。VALUE 类型固定 4 字节大端；BOOL 1 字节（0x00/0x01）。

类型系统只有 6 种：

| type | 含义 | data 长度 |
|------|------|-----------|
| 0x00 | RAW | 任意 |
| 0x01 | BOOL | 1 |
| 0x02 | VALUE（32 位有符号整数） | 4 |
| 0x03 | STRING | 任意 |
| 0x04 | ENUM | 1 |
| 0x05 | BITMAP | 1/2/4 |

本项目 38 个 DP 只用了 BOOL 和 VALUE 两种。所有 VALUE 都是“整数 × 10^scale”的定点表示：比如 DP 101（电压，scale=1）报 `2222` 代表 222.2V；DP 1（电量，scale=2）报 `12345` 代表 123.45 kWh。**为什么不发浮点？因为 Zigbee 帧里塞 IEEE 754 既浪费字节又容易踩大小端，定点整数是最省心的跨平台方案。**

### 解剖一帧真实报文

抓一帧“设备上报 A 相功率 123.4W”（DP 105，scale=1）：

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

## 三、三个命令字：一问一答一广播

```
0x00  网关 → 设备：下发 DP（控制命令，如“打开继电器”）
0x05  设备 → 网关：应答 0x00（把收到的帧原样回显）
0x06  设备 → 网关：主动上报（周期性数据、报警、状态变化）
```

注意 0x05 的设计：**应答就是原样回显**。收到网关的 0x00 帧后，设备把 payload 原封不动用 0x05 命令发回去——这既是应用层 ACK，也顺手完成了“我收到并理解了”的语义。比设计一个独立的 ACK 帧格式省事得多，代价是应答帧里没带“执行结果”，成功失败靠后续的 0x06 主动上报兜底（执行后再报一次当前值）。

## 四、接收路径：从 ZCL 消息到业务分发

接收的完整调用链（第 02 篇埋下的伏笔，这里收线）：

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

### 4.1 帧解析：六字节头的拆包

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

两个防御点：payload 至少要有 6 字节头；声明的 len 不能超过实际 payload。空中传输的帧可能因栈内缓冲复用而带脏数据，这类边界检查永远不写白不写。

### 4.2 业务分发：只认 RW 的 DP

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

设计决策值得说明：**只处理 RW（可写）DP**。网关下发的 0x00 帧理论上只可能是写操作（RO 数据是设备单方面拥有的），所以 default 分支直接丢弃。这个 switch 就是全设备的“写入口清单”，新增可写 DP 时必须在这里挂号。

### 4.3 应答与回报的 zcl_id 之争

看这两行代码：

```c
/* 应答（0x05）与回报（0x06）用的是同一个 zcl_id = 0x68 */
send_data.zcl_id = 0x68;
...
tal_zg_clear_send_data(ZG_CLEAR_ALL_ZCL_ID, &send_data.zcl_id);   /* ★ 发前先清同 ID 的待发帧 */
```

`tal_zg_clear_send_data` 的作用是：把 SDK 发送队列里**相同 zcl_id 的待发帧全部清掉**。SDK 这么设计的初衷是好的——同一个 zcl_id 代表“同一类消息”，新消息顶掉旧消息可以避免队列堆积。但它引出了本项目最著名的一个 bug：**批量上报时，后一个 DP 会把前面还没发出去的 DP 清掉**。

想象一下全量上报 38 个 DP 的场景：DP1 入队（还没发出去）→ DP2 入队前清队列，DP1 没了 → DP3 入队前清队列，DP2 没了……最后只有最后一个 DP 到达网关。这就是项目文档里用加粗强调的那句话的由来：

> **`app_dp_transmit_report` vs `app_dp_transmit_report_no_clear`：前者会调用 `tal_zg_clear_send_data` 清空相同 zcl_id 的待发队列。批量上报必须用 `_no_clear` 版本。**

三个发送接口的完整分工：

| 接口 | 清队列？ | 用途 |
|------|---------|------|
| `app_dp_transmit_report` | 是 | 单发场景：确保新值顶掉旧值 |
| `app_dp_transmit_report_no_clear` | 否 | 批量场景：应答后回报告知、全量上报 |
| `app_dp_transmit_report_immediate` | 是 + 不排队 | 紧急场景：报警、开关跳闸，delay_time=0 |

你在第 04 篇见过 `report_no_clear` 的实际用途：应答 0x05 刚入队，回报告知 0x06 如果走 `report` 版本，会把应答帧清掉。

## 五、发送路径：组帧的三个要素

上报的本质是填一个 `TAL_ZG_SEND_DATA_T` 结构体：

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

几个要点：

- **目的地址固定是网关**（`TUYA_GATEWAY_ADDRESS`）。涂鸦子设备不直接和云端通信，所有帧都发给网关，由网关转发云端——这就是“子设备”三个字的含义；
- `frame_type = ZG_ZCL_FRAME_TYPE_SPEC_TO_CLUSTER` 表示“簇特定命令”（相对于“全局命令”如读属性）。0xEF00 上我们只用簇特定命令；
- `direction = SERVER_TO_CLIENT`：0xEF00 是服务端簇，设备作为 server 向 client（网关）发数据；
- `delay_time` 和 `sg_batch_delay_ms` 是批量错峰机制：每发一帧延迟 +200ms，给协议栈留出发送时间。这是队列机制出现之前的过渡方案，第 09 篇会被更完善的队列取代，但错峰思想保留了下来。

QOS 的选择也讲透（这直接关系到可靠性）：

| QOS | 含义 | 用在哪 |
|-----|------|--------|
| QOS_0 | 发完不管，可能静默丢失 | 普通周期数据 |
| QOS_1 | 要求 APS 层 ACK，没收到自动重传 | **所有 RW 配置 DP、报警、开关状态** |

## 六、把整条链路走一遍：远程打开继电器

用户在 App 上点“开”，到我们继电器吸合，全链路时序：

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

全程约 200-500ms（视网络状况）。其中物理动作（第 3 步）发生得**最早**——先执行、再持久化、再上报。这个顺序保证即使上报丢失，本地状态也是对的，下次入网全量上报会纠正云端。

## 七、新增一个 DP 的标准流程（可收藏的清单）

以“假设要加 DP 200：漏电流报警”为例，六个步骤：

1. 在 DP 常量定义处加 `#define DP_ID_LEAKAGE_ALARM 200`；
2. 在中央数据结构的结构体里加字段 `BOOL_T leakage_alarm;`；
3. 在数据初始化函数里给初值；如需掉电保存，在 KV 读写函数里维护字段拷贝；
4. 若可写：在 DP 写入接口的 switch 加分支；**同时**在业务分发 switch 里挂号（两个 switch 容易漏一个）；
5. 在全量上报 / 周期上报函数里加 `__report_bool_dp(DP_ID_LEAKAGE_ALARM, ...)`，注意 realtime 里加“变化才报”的缓存比较；
6. 涂鸦 IoT 平台的物模型里加同名 DP——**云和固件的 dpid 必须一致**，这是最容易翻车的一步：云平台用的 dpid 和代码里的宏对不上，数据就是“发得出、看不见”。

## 八、踩坑实录

**坑 1：VALUE 的大小端。**
DP 帧的 len 是大端，VALUE 的 4 字节数据也是大端（`__int32_to_be`）。解析时 `value[0]<<24 | value[1]<<16 | value[2]<<8 | value[3]`。哪一端搞反了，数字看起来都“差不多对”（小数值时），但负数和大数值直接爆炸。

**坑 2：应答帧没回显对端地址。**
`app_dp_transmit_response` 的 `dst_addr/dst_ep` 必须取自**收到的 msg**（`msg->src_addr`/`msg->src_ep`），不能写死网关地址——网关可能从不同的端点或地址发起请求。

**坑 3：回报时错用 `report` 清掉应答帧。**
前文详解。规则：**一个事件链里只要有第二个待发帧，第一个就必须用 `_no_clear`**。

**坑 4：PLATFORM 物模型 dpid 与固件不一致。**
云上 dpid 是 132，代码里宏是 133——这种错位不会有任何编译错误，表现是“云端收不到”或“控制不生效”。排查方法：抓一帧 0xEF00 报文，对 dpid 逐个核。

## 九、验证方法

1. **下行**：App 改功率阈值 → 串口看到 `DP recv: dpid=111` → 紧接着 `report DP 111 (VALUE) = ...`；
2. **上行**：周期定时器触发后，用网关的抓包功能（或串口 log 的 `report DP xxx` 行）确认 0x06 帧到达；
3. **闭环**：App 上操作开关，500ms 内继电器吸合 + App 状态回显——任何一环断了都按第六节的时序图定位。

## 十、小结

- DP 协议 = 6 字节头 + 数据负载，三个命令字（0x00 下发 / 0x05 应答 / 0x06 上报），六种类型但只用了 BOOL + 定点 VALUE；
- 接收链路：**应答先行、解析居中、分发殿后**；
- `tal_zg_clear_send_data` 按 zcl_id 清队列是双刃剑——理解 `report` / `_no_clear` / `immediate` 三个接口的分工；
- QOS_1 留给“必须到达”的帧，QOS_0 给周期数据；
- 新增 DP 六步清单，云-固件 dpid 一致性是最大的暗坑。

设备现在会说话了，但它说的还是“空话”——所有 RO 数据还是零。下一篇请出本项目的物理之眼：**HLW8112 计量芯片**，用 GPIO 模拟 SPI 把它点亮，读出 A/B 两相真实的电压、电流、功率。

---

*上一篇：[04 入网] · 系列目录 · 下一篇：[06 感知（上）：HLW8112 SPI 双通道计量]*
