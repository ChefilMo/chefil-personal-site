---
title: "09 · Blood Vessels: The DP Transmit Queue and a Deadlock Incident"
description: "How we designed the application-layer transmit queue — ring buffer, single-frame-in-flight state machine, and watchdog — and a postmortem of a real deadlock caused by sharing one zcl_id, plus the fix."
pubDate: 2026-11-24
lang: en
translationKey: zigbee-meter-part9
tags: [Embedded, Zigbee, Tutorial]
series: zigbee-meter
seriesOrder: 9
category: embedded
---

> Goal: Understand why an application-layer transmit queue is needed, and the root cause and fix of a queue deadlock — the article with the highest density of concurrency issues in this series

---

## 1. Where the Problem Started: 15 Slots Can't Hold 38 DPs

Back to the cliffhanger left in Part 5. The SDK's Zigbee transmit queue (QOS_1 channel) has only **15 slots**, while our full report carries 38 DPs. The consequence of naively calling the send API in a loop:

```
Report DP 1  → enqueued, OK
Report DP 2  → enqueued, OK
...
Report DP 15 → enqueued, OK (queue is full)
Report DP 16 → QUEUE_FULL_ERR! This frame is lost
...
```

Worse, `tal_zg_send_data` is **asynchronous**: a successful enqueue doesn't mean a successful send — the real outcome arrives asynchronously via a callback. So for "DP 16 failed," you either learn it in the callback, or you never learn it at all (QOS_0 silently drops).

The interim solution from Part 5 was `sg_batch_delay_ms` staggering — 200 ms per frame, 38 frames = 7.6 seconds. It works, but has two fatal flaws:

1. **No reliability**: Staggering merely "reduces the chance of a collision." When the queue gets busy (say, a management-traffic spike right after joining the network), frames still get dropped;
2. **No backpressure awareness**: The sender has no idea when the queue drains, so it can only blindly guess the interval.

What we need is a real **application-layer transmit queue**: queuing, rate limiting, retry, backpressure awareness. The whole queue is about 200 lines of code; let's dissect it piece by piece.

## 2. Queue Design: Ring Buffer + State Machine + Watchdog

### 2.1 Data Structures

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

A classic ring queue: head and tail each increment modulo the size, and count tracks the current depth. 64 items × ~70 bytes per item ≈ 4.5 KB of RAM — the TLSR8258 has 64 KB of SRAM, more than enough.

### 2.2 The State Machine: Only One Frame in Flight at a Time

```c
typedef enum {
    DP_TX_STATE_IDLE = 0,     /* 空闲：可以发下一帧 */
    DP_TX_STATE_SENDING,      /* 已调 tal_zg_send_data，等结果回调 */
    DP_TX_STATE_WAIT_RETRY,   /* 失败/队列满：定时器 X ms 后重试 */
} DP_TX_STATE_E;
```

This state machine is the soul of the entire queue. It guarantees **at most one frame is "in flight" in the SDK queue at any moment** — the application-layer queue completely shields the SDK's shallow queue, which forever bears the pressure of just a single frame. The 15-slot limit becomes a non-issue.

Enqueue (`app_dp_transmit_enqueue`):

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

Dequeue processing (`__dp_tx_process`) — the engine of the whole queue:

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

Three key designs:

**① The watchdog (marked ①).** `tal_zg_send_data` registers `__dp_tx_result_cb`, but the callback may never fire for various reasons (the SDK clears the frame internally, an exception inside the stack). Without a watchdog, the state machine stays stuck in SENDING forever and the queue is permanently deadlocked — **this is the fix for the "deadlock incident" in this article's title, expanded in the next section**.

**② Backpressure awareness (marked ②).** `tal_zg_send_data_is_busy()` queries the state of the SDK's send engine. Rather than firing and then retrying after hitting QUEUE_FULL, it's better to yield in advance — this is the idea of "traffic shaping": the application-layer queue actively adapts to downstream capacity.

**③ Callback-driven (marked ③).** Progress after a send completes relies entirely on the callback:

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

Three outcomes, three strategies: success → dequeue and send the next frame; queue full → wait 500 ms and retry (without consuming the retry budget, because this is "congestion," not "failure"); real failure → count a retry, drop after 3. **"Dropping" sounds brutal, but it's correct for periodic report data** — the next cycle, 10 seconds later, will carry the latest value; retrying stale values forever would only block new data.

### 2.3 Why Recursively Calling `__dp_tx_process` from the Callback Is Safe

The success branch of `__dp_tx_result_cb` calls `__dp_tx_process` to send the next frame, and `__dp_tx_process` in turn calls `tal_zg_send_data` to register a new callback... won't this overflow the stack? No — because the whole chain is **event-driven**: `tal_zg_send_data` merely puts the frame into the SDK queue and returns; the callback is invoked by the SDK's event loop after the send completes. Between two invocations of `__dp_tx_process` lies one complete send process (milliseconds to tens of milliseconds), and the call stack has long since unwound. This is the essential difference between an event-driven architecture and blocking calls.

## 3. Incident Postmortem: How the Queue Deadlock Happened

This is a real failure from the project's actual fix log, and also the key to understanding the "zcl_id" design.

### 3.1 Symptoms

After joining the network, everything worked fine — but after running for a while (hours to days), **all DP reporting silently stopped** — periodic reports, alarms, configuration acknowledgments, all of it. The device was still alive (network joining could still trigger), the Zigbee network was still up (heartbeats normal) — only DP data stopped flowing. A reboot always fixed it, and it always came back after some time.

### 3.2 Investigation: X-Raying the State Machine

After adding logs to every branch of `__dp_tx_process`, we found the state machine stuck in `DP_TX_STATE_SENDING` — after the head-of-queue frame was sent out, `__dp_tx_result_cb` **was never called again**.

Why would the callback go missing? Look at these two lines (seen in Part 5):

```c
/* 应答 0x05 用的 zcl_id */
send_data.zcl_id = 0x68;
...
tal_zg_clear_send_data(ZG_CLEAR_ALL_ZCL_ID, &send_data.zcl_id);   /* 清掉队列里所有 zcl_id=0x68 的帧 */
```

The semantics of `tal_zg_clear_send_data`: **remove all pending frames matching the zcl_id from the SDK's send queue**. Its original intent is "for the same kind of message, the new one supersedes the old" (e.g., the user drags a brightness slider and only the final value should be sent). But the side effect is: **for a cleared frame, its registered callback will never fire either**.

So the complete chain of the deadlock fell into place:

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

**Root cause: two logical channels (queue reporting + acknowledgment) shared a single zcl_id, clearing each other's frames, which caused callback loss and a state machine deadlock.**

### 3.3 The Fix: zcl_id Isolation + Watchdog

The fix was one macro definition plus a watchdog:

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

The two defenses each guard one segment: zcl_id isolation makes callback loss **not happen** (root cause eliminated); the watchdog makes callback loss **non-fatal** (even if some other cause loses a callback in the future, it recovers automatically after 5 seconds, at the cost of the head-of-queue frame possibly being duplicated or lost).

### 3.4 Lessons

1. **Shared namespaces are a breeding ground for concurrency bugs**. A zcl_id is essentially a "channel name" in the send queue; different logical channels must have isolated names — the same principle as TCP ports and HTTP routes;
2. **Asynchronous callbacks must have a timeout fallback**. For any "register callback → wait for callback" pattern, you must ask "what if the callback never comes?" A watchdog is not an elegant solution, but it is the last line of defense for correctness;
3. **`tal_zg_clear_send_data` clears callbacks along with frames**. When using queue-clearing APIs, you must think carefully about whether the queue contains "someone else's" frames.

## 4. The Legacy of Staggering: delay_time and Batch Pacing

The watchdog and zcl_id were fixes; the queue itself also has proactive performance design. `sg_batch_delay_ms` in `__app_dp_transmit_report_internal` (Part 5):

```c
send_data.delay_time = immediate ? 0 : sg_batch_delay_ms;
...
if (!immediate) {
    sg_batch_delay_ms += 200;   /* 每帧多等 200ms */
}
```

This design is no longer the main mechanism after the queue took over pacing, but it's still meaningful for **urgent frames that bypass the queue**: `app_dp_transmit_report_immediate` passes `immediate=TRUE`, forcing delay_time to 0 without touching `sg_batch_delay_ms` — alarm frames are a matter of seconds and must never wait behind the batch staggering.

The three-interface division of labor from Part 5 still holds in the queue era, with slightly adjusted responsibilities:

| Interface | Role in the queue era |
|------|---------------|
| `app_dp_transmit_report_immediate` | Urgent single frames such as alarms/trips, delay=0, QOS_1 |
| `app_dp_transmit_enqueue` | **The main channel for all periodic/batch reporting**, QOS_1 |
| `app_dp_transmit_report_no_clear` | "Not queued but must follow immediately" frames, such as a post-ack report |

## 5. Full Timeline: A 10-Second Periodic Report Through the Queue's Eyes

Connecting the acquisition from Part 8 with the framing from Part 5, let's look at the queue's role:

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

Key observation: **the periodic timer is not restarted during the entire batch report** — it's restarted only after the report completes. This means if the queue gets clogged (poor gateway signal, every frame retrying), the period stretches instead of piling up in parallel — a natural overload protection. The cost is longer report periods under extreme congestion, which is acceptable: meter data changes far more slowly than once every 10 seconds.

## 6. Pitfall Chronicles

**Pitfall 1: No awareness after the queue got stuck.**
In the early days there was no watchdog, and a dead state machine could only be discovered by "the user noticing no data in the app." After the fix, a `watchdog ... force reset` in the log is an early warning — when you see it, investigate why the callback was lost.

**Pitfall 2: QOS_0 creates an illusion of "send success."**
The queue accepts a QOS parameter, and we initially used QOS_0 everywhere — the callback would report OK (the frame did enter the SDK queue), but without an APS-layer ACK, an over-the-air loss goes undetected. After the fix, **all RW configuration DPs use QOS_1**, letting the Zigbee stack's ACK retransmission back it up. Periodic data can use QOS_0 (a loss is covered by the next cycle), **but configuration data must use QOS_1 (a loss corrupts the cloud-side state)**.

**Pitfall 3: Doing heavy work in the callback.**
At one point `__dp_tx_result_cb` directly invoked the reporting function (recursively re-framing), and the nesting in the callback context got dangerously deep. The principle: **only advance state in the callback; do business logic back in the timer or event loop**.

**Pitfall 4: The 64-item queue filling up.**
During debugging we set `PERIODIC_REPORT_INTERVAL_MS` to 1 second; enqueue speed exceeded send speed, all 64 slots filled in an instant, and frames started being silently dropped. A `queue full, drop` in the log is the signal. The queue capacity is sized for "10 s period × worst case 38 items all reported" (38 < 64); when you change the period, redo this inequality.

## 7. Verification Methods

1. **Throughput test**: After the network is stable, trigger a full report (38 frames); capture packets on the gateway side to confirm all arrive in order, with total time < 5 s;
2. **Backpressure test**: Trigger network joining mid-report (creating a management-traffic spike); watch the log for `queue full, wait`, then confirm all frames eventually go out with no `drop`;
3. **Deadlock regression**: Manually `return` at the entry of `__dp_tx_result_cb` (simulating callback loss); after 5 seconds, the log should show a watchdog reset, and the queue should recover and keep working;
4. **Retry test**: Block the antenna to create a weak signal; QOS_1 frames should trigger automatic APS retransmission — `retry 1/3`, `retry 2/3` appear, ending with a final `ok`.

## 8. Summary

- The SDK's 15-slot send queue can't hold 38 DPs; the application-layer queue thoroughly shields the shallow queue with "ring buffer + single-frame-in-flight state machine";
- The state machine has three states, IDLE/SENDING/WAIT_RETRY, driven forward by result callbacks, with backpressure sensing via `tal_zg_send_data_is_busy()`;
- The deadlock's root cause was two logical channels sharing zcl_id 0x68 — `tal_zg_clear_send_data` cleared frames and their callbacks together; the fix = zcl_id isolation (0x69) + a 5-second watchdog;
- QOS policy: configuration must be QOS_1, periodic data may be QOS_0;
- The periodic timer's "restart only after reporting" provides natural overload protection.

The data pipeline is fully connected: acquisition → aggregation → queue → gateway. But the device still lacks a "face" — the next part covers the VK1621 segment LCD driver and NTC temperature sensing, so the meter can be read by humans without the app.

---

*Previous: [08 Memory] · Series Index · Next: [10 Face: VK1621 Segment LCD and NTC Temperature]*
