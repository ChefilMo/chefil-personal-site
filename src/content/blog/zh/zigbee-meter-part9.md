---
title: "09 · 血管：DP 发送队列与一场死锁事故"
description: "讲清应用层发送队列的设计——环形缓冲、单帧在飞状态机与看门狗，并复盘一场因共用 zcl_id 引发的队列死锁事故与修复。"
pubDate: 2026-11-24
lang: zh
translationKey: zigbee-meter-part9
tags: [嵌入式, Zigbee, 教程]
series: zigbee-meter
seriesOrder: 9
category: embedded
---

> 目标：搞懂为什么需要应用层发送队列，以及队列死锁的根因与修复——这是本项目并发问题最集中的一篇

---

## 一、问题的起点：15 个槽位装不下 38 个 DP

回到第 05 篇留下的悬念。SDK 的 Zigbee 发送队列（QOS_1 通道）只有 **15 个槽位**，而我们的全量上报有 38 个 DP。直接循环调用发送 API 的后果：

```
上报 DP 1  → 入队，OK
上报 DP 2  → 入队，OK
...
上报 DP 15 → 入队，OK（队列满了）
上报 DP 16 → QUEUE_FULL_ERR！这一帧丢了
...
```

更糟的是 `tal_zg_send_data` 是**异步**的：入队成功不代表发送成功，真正的结果要通过回调函数异步告知。那么"DP 16 失败"这件事，你要么在回调里拿到，要么根本拿不到（QOS_0 静默丢弃）。

第 05 篇的过渡方案是 `sg_batch_delay_ms` 错峰——每帧延迟 200ms，38 帧要 7.6 秒。能跑，但有两个硬伤：

1. **没有可靠性**：错峰只是"降低撞车概率"，队列一忙（比如配网后的管理流量高峰）照样丢；
2. **没有背压感知**：发送方不知道队列什么时候空，只能盲目拍间隔。

我们需要的是一个真正的**应用层发送队列**：排队、限流、重试、背压感知。整套队列的实现约 200 行代码，下文逐段拆解。

## 二、队列设计：环形缓冲 + 状态机 + 看门狗

### 2.1 数据结构

```c
#define DP_TX_QUEUE_SIZE        64      /* 队列容量 */
#define DP_TX_MAX_RETRY         3       /* 最大重试次数 */
#define DP_TX_RETRY_INTERVAL_MS 300     /* 失败重试间隔 */
#define DP_TX_QUEUE_FULL_WAIT_MS 500     /* SDK 队列满时等待多久再试 */
#define DP_TX_SEND_TIMEOUT_MS   3000     /* 单帧发送超时 */
#define DP_TX_WATCHDOG_MS       5000     /* 状态机看门狗 */

#define DP_TX_QUEUE_ZCL_ID      0x69     /* ★ 专用 zcl_id，后文细讲 */

typedef struct {
    UINT8_T  ep;
    UINT8_T  dpid;
    UINT8_T  type;
    UINT8_T  data[DP_MAX_DATA_LEN];
    UINT8_T  data_len;
    UINT8_T  retry_count;
    TAL_SEND_QOS_E qos;
} DP_TX_ITEM_T;

STATIC DP_TX_ITEM_T sg_dp_tx_queue[DP_TX_QUEUE_SIZE];
STATIC UINT8_T  sg_dp_tx_head  = 0;      /* 出队端 */
STATIC UINT8_T  sg_dp_tx_tail  = 0;      /* 入队端 */
STATIC UINT8_T  sg_dp_tx_count = 0;
STATIC DP_TX_STATE_E sg_dp_tx_state = DP_TX_STATE_IDLE;
```

经典环形队列：head/tail 各自取模递增，count 记录当前深度。64 项 × 每项 ~70 字节 ≈ 4.5KB RAM——TLSR8258 有 64KB SRAM，绰绰有余。

### 2.2 状态机：一次只允许一帧在路上

```c
typedef enum {
    DP_TX_STATE_IDLE = 0,     /* 空闲：可以发下一帧 */
    DP_TX_STATE_SENDING,      /* 已调 tal_zg_send_data，等结果回调 */
    DP_TX_STATE_WAIT_RETRY,   /* 失败/队列满：定时器 X ms 后重试 */
} DP_TX_STATE_E;
```

这个状态机是整个队列的灵魂。它保证了**任意时刻最多只有一帧在 SDK 队列里"在飞"**——应用层队列把 SDK 浅队列完全屏蔽了，SDK 队列永远只承担 1 帧的压力，15 槽位的限制形同虚设。

入队（`app_dp_transmit_enqueue`）：

```c
VOID_T app_dp_transmit_enqueue(UINT8_T ep, UINT8_T *data, UINT16_T data_len,
                               UINT8_T dpid, UINT8_T type, TAL_SEND_QOS_E qos)
{
    if (sg_dp_tx_count >= DP_TX_QUEUE_SIZE) {
        TAL_PR_DEBUG("DP TX queue full, drop dpid %d", dpid);
        return;                                  /* 队列满：丢弃并 log */
    }
    /* 填入队尾项 */
    ...
    __dp_tx_process();                           /* 尝试立即发送 */
}
```

出队处理（`__dp_tx_process`）——整个队列的发动机：

```c
STATIC VOID_T __dp_tx_process(VOID_T)
{
    if (sg_dp_tx_count == 0) return;

    /* ① 看门狗：SENDING 态卡太久，强制复位 */
    if (sg_dp_tx_state == DP_TX_STATE_SENDING) {
        UINT32_T elapsed = tal_system_get_millisecond() - sg_dp_tx_send_tick;
        if (elapsed > DP_TX_WATCHDOG_MS) {
            TAL_PR_NOTICE("DP TX watchdog: dpid=%d stuck %ums, force reset", ...);
            sg_dp_tx_state = DP_TX_STATE_IDLE;    /* 回调丢了，强制回 IDLE */
        } else {
            return;                               /* 正常在飞，等回调 */
        }
    } else if (sg_dp_tx_state != DP_TX_STATE_IDLE) {
        return;                                   /* WAIT_RETRY：定时器会叫我们 */
    }

    /* ② 背压感知：SDK 发送引擎忙，让路 */
    if (tal_zg_send_data_is_busy()) {
        sg_dp_tx_state = DP_TX_STATE_WAIT_RETRY;
        tal_sw_timer_start(sg_dp_tx_retry_timer, DP_TX_QUEUE_FULL_WAIT_MS, TAL_TIMER_ONCE);
        return;
    }

    /* ③ 发队首帧 */
    DP_TX_ITEM_T *item = &sg_dp_tx_queue[sg_dp_tx_head];
    ...
    sg_dp_tx_send_tick = tal_system_get_millisecond();
    sg_dp_tx_state = DP_TX_STATE_SENDING;
    tal_zg_send_data(&send_data, __dp_tx_result_cb, DP_TX_SEND_TIMEOUT_MS);  /* ★ 注册结果回调 */
}
```

三个关键设计：

**① 看门狗（①处）**。`tal_zg_send_data` 注册了 `__dp_tx_result_cb`，但回调可能因为各种原因永不触发（SDK 内部把帧清了、栈内异常）。如果没有看门狗，状态机永远卡在 SENDING，队列永久死锁——**这就是本篇标题里"死锁事故"的修复点，下一节展开**。

**② 背压感知（②处）**。`tal_zg_send_data_is_busy()` 查询 SDK 发送引擎状态。与其发出去撞 QUEUE_FULL 再重试，不如提前让路——这是"流量整形"的思想：应用层队列主动适配下游容量。

**③ 回调驱动（③处）**。发送完成后的推进完全靠回调：

```c
STATIC VOID_T __dp_tx_result_cb(TAL_SEND_ST_E status, TAL_ZG_SEND_DATA_T *send_data)
{
    DP_TX_ITEM_T *item = &sg_dp_tx_queue[sg_dp_tx_head];

    if (status == SEND_ST_OK) {
        sg_dp_tx_head = (sg_dp_tx_head + 1) % DP_TX_QUEUE_SIZE;
        sg_dp_tx_count--;
        sg_dp_tx_state = DP_TX_STATE_IDLE;
        __dp_tx_process();                        /* ★ 递归推进下一帧 */
    } else if (status == SEND_ST_QUEUE_FULL_ERR) {
        sg_dp_tx_state = DP_TX_STATE_WAIT_RETRY;
        tal_sw_timer_start(sg_dp_tx_retry_timer, DP_TX_QUEUE_FULL_WAIT_MS, TAL_TIMER_ONCE);
    } else {
        item->retry_count++;
        if (item->retry_count > DP_TX_MAX_RETRY) {
            /* 重试耗尽：丢弃此帧，推进 */
            sg_dp_tx_head = ...; sg_dp_tx_count--; ...
            __dp_tx_process();
        } else {
            sg_dp_tx_state = DP_TX_STATE_WAIT_RETRY;
            tal_sw_timer_start(sg_dp_tx_retry_timer, DP_TX_RETRY_INTERVAL_MS, TAL_TIMER_ONCE);
        }
    }
}
```

三种结果三种策略：成功→出队发下一帧；队列满→等 500ms 再试（不耗重试次数，因为这是"拥堵"不是"失败"）；真失败→计重试，3 次后丢弃。**"丢弃"听起来粗暴，但对周期上报数据是正确的**——10 秒后的下一周期会带出最新值，为旧值无限重试只会阻塞新数据。

### 2.3 为什么回调里能递归调用 `__dp_tx_process`

`__dp_tx_result_cb` 成功分支会调 `__dp_tx_process` 发下一帧，而 `__dp_tx_process` 又会 `tal_zg_send_data` 注册新的回调……这不会栈溢出吗？不会，因为整个链是**事件驱动**的：`tal_zg_send_data` 只把帧放进 SDK 队列就返回，回调由 SDK 在发送完成后的事件循环里调用——两次 `__dp_tx_process` 之间隔了一次完整的发送过程（毫秒到几十毫秒），调用栈早就 unwind 了。这是事件驱动架构和阻塞调用的本质区别。

## 三、事故复盘：队列死锁是怎么发生的

这是项目实际修复记录里的一场真实故障，也是理解"zcl_id"设计的钥匙。

### 3.1 症状

设备入网后一切正常，但运行一段时间后（几小时到几天），**所有 DP 上报全部停止**——周期上报、报警、配置回报，全部静默。设备还活着（配网还能触发），Zigbee 网络还在（心跳正常），唯独 DP 数据不走了。重启必好，但过段时间必复发。

### 3.2 排查：给状态机拍 X 光

在 `__dp_tx_process` 的各分支加 log 后，发现状态机卡在 `DP_TX_STATE_SENDING`——队首帧发出去之后，`__dp_tx_result_cb` **再也没有被调用**。

为什么回调会丢？看这两行代码（第 05 篇见过）：

```c
/* 应答 0x05 用的 zcl_id */
send_data.zcl_id = 0x68;
...
tal_zg_clear_send_data(ZG_CLEAR_ALL_ZCL_ID, &send_data.zcl_id);   /* 清掉队列里所有 zcl_id=0x68 的帧 */
```

`tal_zg_clear_send_data` 的语义：**把 SDK 发送队列里匹配 zcl_id 的所有待发帧清除**。它设计的初衷是"同一类消息，新的顶掉旧的"（比如用户连续调亮度，只发最后一次）。但副作用是：**被清除的帧，其注册的回调也不会触发**。

于是死锁的完整链条拼出来了：

```
早期的队列实现用的也是 zcl_id=0x68

时刻 T1: 队列发 DP 5（zcl_id=0x68），入 SDK 队列，等回调
时刻 T2: 网关下发一个控制命令（比如改阈值）
         → 设备走 app_dp_transmit_response 回 0x05 应答
         → 应答前调 tal_zg_clear_send_data(0x68)
         → SDK 队列里那帧 DP 5 被清掉了！
         → DP 5 的 __dp_tx_result_cb 永远不会触发
时刻 T3: 队列状态机永远停在 SENDING
时刻 T4~∞: 队列深度逐渐堆满 64，然后所有 enqueue 全部静默丢弃
```

**根因：两个逻辑通道（队列上报 + 应答）共用一个 zcl_id，互相清除对方的帧，导致回调丢失、状态机死锁。**

### 3.3 修复：zcl_id 隔离 + 看门狗

修复是一行宏定义 + 一个看门狗：

```c
/* 队列专用 zcl_id，与应答的 0x68 隔离 */
#define DP_TX_QUEUE_ZCL_ID  0x69
```

```c
/* __dp_tx_process 里的看门狗 */
if (elapsed > DP_TX_WATCHDOG_MS) {
    sg_dp_tx_state = DP_TX_STATE_IDLE;    /* 即使回调真丢了，5 秒后也自愈 */
}
```

两道防线各管一段：zcl_id 隔离让回调丢失**不发生**（根因消除）；看门狗让回调丢失**不致命**（即使将来有别的原因丢回调，5 秒后自动恢复，代价只是队首帧可能重复或丢失）。

### 3.4 教训

1. **共享命名空间是并发 bug 的温床**。zcl_id 就是发送队列里的"通道名"，不同逻辑通道必须隔离命名——和 TCP 端口、HTTP 路由是同一个道理；
2. **异步回调必须有超时兜底**。任何"注册回调 → 等回调"的模式，都要问一句"回调不来怎么办"。看门狗不是优雅方案，但它是正确性的最后防线；
3. **`tal_zg_clear_send_data` 会连带清掉回调**。用清队列类 API 时，必须想清楚队列里有没有"别人的"帧。

## 四、错峰机制的遗产：delay_time 与批量节奏

看门狗和 zcl_id 是修复，队列本身还有主动的性能设计。`__app_dp_transmit_report_internal`（第 05 篇）里的 `sg_batch_delay_ms`：

```c
send_data.delay_time = immediate ? 0 : sg_batch_delay_ms;
...
if (!immediate) {
    sg_batch_delay_ms += 200;   /* 每帧多等 200ms */
}
```

这个设计在队列启用后已经不是主力（队列自己控制节奏），但对**不走队列的紧急帧**仍有意义：`app_dp_transmit_report_immediate` 用 `immediate=TRUE`，delay_time 强制 0 且不动 `sg_batch_delay_ms`——报警帧分秒必争，绝不能排在批量错峰的后面。

第 05 篇的三接口分工在队列时代依然成立，只是职责微调：

| 接口 | 队列时代的作用 |
|------|---------------|
| `app_dp_transmit_report_immediate` | 报警/跳闸等紧急单帧，delay=0，QOS_1 |
| `app_dp_transmit_enqueue` | **一切周期/批量上报的主通道**，QOS_1 |
| `app_dp_transmit_report_no_clear` | 应答后回报告知等"非队列但必须紧跟"的帧 |

## 五、完整时序：一次 10 秒周期上报的队列视角

把第 08 篇的采集和第 05 篇的组帧串起来，看队列在其中的角色：

```
10s 定时器到点
  → app_meter_read_trigger_with_cb(__on_periodic_report_done)
    → HLW8112_Measure()          （SPI 同步，~4ms）
    → hlw8110_calc_start_with_cb()  （UART 异步，~600ms）
      ... 60ms × 11 步 ...
    → __on_hlw8110_done(all_ok=TRUE)
      → __aggregate_meter_data()
      → app_meter_data_report_realtime()
        → 死区过滤后，假设 15 个 DP 变了
        → 每个调 app_dp_transmit_enqueue()
          → 入队 15 项，__dp_tx_process() 发队首（zcl_id=0x69, QOS_1）
        → （~100ms 后）__dp_tx_result_cb(OK)
          → 出队，__dp_tx_process() 发下一帧
        → ... 15 帧依次发出，每帧间隔 ≈ SDK 发送耗时（几十 ms）
      → app_lcd_refresh()
      → sg_done_cb() = __on_periodic_report_done
        → 重启 10s 定时器
```

关键观察：**整个批量上报期间，周期定时器还没重启**——它是上报完成后才重启的。这意味着如果队列堵了（比如网关信号差，每帧都重试），周期会被拉长而不是并行叠加——天然的过载保护。代价是极端拥塞时上报周期变长，可接受：电表数据的变化速度远慢于 10 秒。

## 六、踩坑实录

**坑 1：队列卡死后无感知。**
早期没有看门狗，状态机死了只能靠"用户发现 App 没数据"。修复后 log 里出现 `watchdog ... force reset` 就是预警信号，看到就该查为什么回调丢了。

**坑 2：QOS_0 导致"发送成功"假象。**
队列支持传入 QOS，早期统一用 QOS_0——回调会报 OK（帧确实进 SDK 队列了），但 APS 层没 ACK，空中丢了也不知道。修复后 **RW 配置类 DP 一律 QOS_1**，让 Zigbee 栈的 ACK 重传机制兜底。周期数据可以 QOS_0（丢了下周期补上），**配置数据必须 QOS_1（丢了云端状态就错了）**。

**坑 3：回调里做重活。**
`__dp_tx_result_cb` 里曾直接调上报函数（递归组帧），结果回调上下文里嵌套太深。原则：**回调里只做状态推进，业务逻辑回到定时器或事件循环里做**。

**坑 4：64 项队列打满。**
调试时把 `PERIODIC_REPORT_INTERVAL_MS` 改成 1 秒，队列入队速度 > 发送速度，64 项瞬间打满然后静默丢帧。log 里 `queue full, drop` 就是信号。队列容量是按"10s 周期 × 最坏 38 项全报"设计的（38 < 64），改周期时要重算这个不等式。

## 七、验证方法

1. **吞吐测试**：入网稳定后触发全量上报（38 帧），用网关侧抓包确认全部到达、顺序正确，总耗时 < 5s；
2. **背压测试**：上报进行中触发配网（制造管理流量高峰），观察 log 中 `queue full, wait` 后帧最终全部发出、无 `drop`；
3. **死锁回归**：人为在 `__dp_tx_result_cb` 入口 return（模拟回调丢失），5 秒后 log 应出现 watchdog reset，队列自愈继续工作；
4. **重试测试**：遮挡天线制造弱信号，QOS_1 帧应自动 APS 重传，`retry 1/3`、`retry 2/3` 出现但最终 `ok`。

## 八、小结

- SDK 发送队列 15 槽位装不下 38 个 DP，应用层队列用"环形缓冲 + 单帧在飞状态机"把浅队列彻底屏蔽；
- 状态机三态 IDLE/SENDING/WAIT_RETRY，由结果回调驱动推进，背压感知靠 `tal_zg_send_data_is_busy()`；
- 死锁根因是两个逻辑通道共用 zcl_id 0x68，`tal_zg_clear_send_data` 清帧连带丢回调；修复 = zcl_id 隔离（0x69）+ 5 秒看门狗；
- QOS 策略：配置必 QOS_1，周期数据可 QOS_0；
- 周期定时器"上报完才重启"提供了天然的过载保护。

数据链路完全打通了：采集 → 聚合 → 队列 → 网关。但设备还缺一张"脸"——下一篇讲 VK1621 段码屏驱动和 NTC 测温，让电表脱离 App 也能被人读懂。

---

*上一篇：[08 记忆] · 系列目录 · 下一篇：[10 面孔：VK1621 段码屏与 NTC 温度]*
