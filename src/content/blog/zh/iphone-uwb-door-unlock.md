---
title: iPhone 靠近即解锁：从比亚迪 UWB 数字钥匙拆解，到自研 BLE+UWB 方案落地
description: 拆解比亚迪 UWB 数字钥匙的实现原理，理清苹果生态的三条准入路径，给出一条不依赖苹果授权的自研 BLE+UWB 门禁方案（8~12 周可上线）。
pubDate: 2026-11-23
lang: zh
translationKey: iphone-uwb-door-unlock
tags: [IoT, iOS, BLE, UWB, 技术方案]
category: ios
---

> 手里拎着东西走到车前，车门自己开了——这个体验比亚迪、宝马的用户已经用了很多年。但如果你是一家门禁/智能锁公司，想在 iOS 上实现"人走到门口自动开门"，就会发现这件事远没有想象中直接：**苹果把能力按生态准入切成了三档，选错路，几个月白干。**
>
> 这篇文章做三件事：拆解比亚迪方案的实现原理（行业标杆），理清苹果生态的三条准入路径（决定你能做什么），最后给出一条不依赖苹果授权的自研落地路线（8~12 周可上线）。

---

## 一、先看标杆：比亚迪的"靠近即解锁"是怎么实现的

### 1.1 基本事实

比亚迪是中国首个推出 UWB 数字钥匙的品牌（2022 年 4 月），也是全球首家通过 Apple Car Key MFi 认证的中国车企。首款支持 iPhone UWB 数字钥匙的车型是汉 EV 千山翠限量版（2023 年 11 月），后续唐 DM-p 战神版、腾势 N7/D9、仰望 U8 搭载。

功能表现：携带 iPhone/Apple Watch 约 5 米内自动解锁，人离开自动落锁，**手机无网络也能用**。硬件门槛是 iPhone 11 及以上（内置 U1 芯片，SE/16e 除外）。

### 1.2 关键认知：这不是比亚迪的自研方案，是苹果的标准

"靠近即解锁"的主体能力是 **Apple CarKey 体系 + CCC Digital Key 3.0 标准**，比亚迪做的是车端落地。整体架构是三通道漏斗：

```
┌─ Apple CarKey 体系（MFi 授权准入）────────────────┐
│ 钥匙载体：Apple Wallet      密钥：Secure Element   │
│ 免激活：Express Mode（低电量也能用）                │
├─ 三条无线通道（CCC DK 3.0）───────────────────────┤
│ BLE：发现与带外握手（车广播，手机系统级响应）        │
│ UWB：精确测距与方位（判定"人在车边"的唯一可信依据） │
│ NFC：兜底（手机没电贴 B 柱/后视镜解锁）            │
└─ 车端：UWB 锚点阵列 + BLE + NFC 读卡 + PEPS 逻辑 ─┘
```

### 1.3 解锁流程拆解

```
① 车辆持续广播 BLE 广告帧（低频低功耗）
② iPhone 系统级监听到目标广播——注意：App 无需前台甚至无需启动
③ BLE 带外握手：交换本次 UWB 测距会话参数
④ UWB 测距：车内多个锚点与 iPhone U1 互相测距（ToF 飞行时间，精度 10~30cm，
   多锚点三角定位得到距离+方位），使用 STS 扰乱时间戳防中继
⑤ 车端 PEPS 判定：距离 < 阈值且方位在车门侧 → "车主靠近"
⑥ iPhone SE 用私钥对车端 challenge 签名 → 车端验签 → 确认"这是被授权的钥匙"
⑦ 解锁；人离开（距离持续增大）→ 自动落锁
```

两个必须理解的设计哲学：

1. **触发 ≠ 授权**。UWB 测距只回答"人在哪"，签名验证回答"能不能开"。距离信号只负责发起挑战，绝不单独作为开门依据。
2. **全程没有 App 参与**。iPhone 侧是系统 Wallet/SE + 基带 + U1 芯片协同，App 被删、手机没电关机（Express Mode 续航几小时）、无网络，链路依然工作。

### 1.4 安全设计：为什么敢"无感"

| 机制 | 防什么 |
|------|--------|
| 私钥在 Secure Element 生成、永不出芯片，签名在片内完成 | 越狱/逆向提取密钥 |
| 车端随机 challenge → 钥匙签名 → 验签 | 重放攻击（录一段信号重放无效） |
| UWB ToF + STS 扰乱时间戳 | **中继攻击**——BLE RSSI 可被信号放大器"延长距离"（有真实的汽车钥匙被攻破案例），UWB 测距天然抗中继 |
| 每次 ranging 用会话级密钥，用完即弃 | 会话录制复用 |
| 钥匙与 Apple ID + VIN 绑定，云端可吊销 | 手机丢失滥用 |

**无网可用的原因**：验证链路（UWB 测距 + SE 签名 + 本地公钥验签）全在端侧完成，云端只负责开通/分享/吊销。

### 1.5 代价与风险

- **准入**：MFi 认证 + CCC 会员，整体周期 6~12 个月，商务认证占大头；
- **硬件预埋**：车内 6 个左右 UWB 锚点 + NFC 读卡器，老车型无法后装——所以只有高配车支持；
- **持续维护成本**：iOS 26 发布后，大量 BMW/比亚迪/沃尔沃车主反馈 UWB 被动进入失效。**核心链路由苹果系统托管，系统大版本升级就是回归风险**——数字钥匙类产品必须建立 iOS 新版本真机回归矩阵，这是隐性长期成本，不是一次性工作。

---

## 二、苹果的准入规则：三条路，你只有资格走其中一两条

想复刻上面的体验，先认清苹果把能力切成的三档：

| 路径 | 能力 | 准入 | 谁适合 |
|------|------|------|--------|
| **A. Apple CarKey** | Wallet 车钥匙 + UWB 无感进入 | **仅车企**：MFi + CCC 双重认证 | 主机厂 |
| **B. NFC & SE Platform** | App 内安全 NFC 交易（门禁卡/工卡/房卡/校园卡） | 签商业协议 + entitlement，**有地区名单** | 门禁/酒店/校园运营方 |
| **C. 自研 BLE + UWB** | App 内 BLE 开锁 | 无门槛 | 所有人 |

### 2.1 路径 A：CarKey（车企专属，9 步）

CCC 会员拿 Digital Key 3.0 规范 → MFi 注册 → 签协议申请 `com.apple.developer.carkey.session` entitlement → **服务端与 Apple 后端双环境集成**（注册/吊销/通知钥匙）→ 车端 SE applet（NFC 走 ECP、UWB 走 Secure Ranging）→ CCC applet 认证 → 苹果提供的 Car Keys Tests App 自测 → DEKRA 等 MFi 授权实验室测试 → Apple 终审。

客户端代码部分，CarKey framework（iOS 16+）公开的部分是车企 App 的**远控**能力，钥匙的开通是服务端集成完成的，不在客户端 API 里：

```swift
import CarKey

// 钥匙已在 Wallet 后，车企 App 远程控车（锁车/开窗）
private var session: CarKeyRemoteControlSession?

func startSession() {
    // 同一时刻只允许一个活跃会话；App 退后台系统自动 end
    session = CarKeyRemoteControl.shared.start(delegate: self,
                                               subscriptionRange: .far,
                                               with: nil)
}
```

### 2.2 路径 B：NFC & SE Platform（门禁的现实苹果生态路径）

iOS 18.1 起，苹果把 SE 安全凭证开放给第三方 App，支持的用例直接包含 **home keys、corporate badges（企业工卡/门禁）、hotel keys、student ID**。

流程：签商业协议（含费用）+ 保密协议 → Account Holder 提交申请 → 入驻 Apple Business Register 申请 entitlement（`com.apple.developer.secure-element-credential`）→ 开发 SE applet → 第三方实验室安全评审 → Apple 签名托管 applet → App 实现 Provisioning/Presentment/Lifecycle 四类 API。

机制上有几个硬约束：**刷卡前必须过 Secure Enclave 授权**（Face ID/密码）；终端侧走 ISO 14443-4/7816-4；用户可把你家 App 设为默认免接触 App，之后双击侧边键或贴读卡器磁场即可拉起交易。

**但有一个对国内公司决定性的事实**：eligible territories 名单包含港澳台，**不包含中国大陆**。国内业务的现实组合是：BLE 自研为主 + 关注大陆开放时间；港澳/海外项目可立即启动 NFC & SE 申请；家用智能锁可评估 HomeKit HAP + Home Key（Aqara 等已在国内落地）。

### 2.3 路径 C：自研 BLE + UWB

无准入门槛，现在就能做，8~12 周可上线——这是本文余下部分的主角。

---

## 三、自研方案总体架构：四层漏斗

```
┌─ 触发层：谁负责把 App 叫醒？────────────────────────┐
│   前台  → BLE 全速扫描                              │
│   后台  → BLE 状态恢复 + 常用门 keep-alive           │
│   被杀  → iBeacon region 系统级唤醒 ★               │
│   划杀  → 无解（iOS 硬边界），NFC 兜底               │
├─ 距离判定层：确认"人真的在门前"？───────────────────┤
│   BLE：RSSI 滤波 + 阈值 + 连续 N 次                  │
│   UWB：距离圈（<1.5m）+ 方向角对准（防隔壁误触）     │
├─ 授权层：凭证验证（与触发完全解耦）─────────────────┤
│   短期滚动凭证 + AES-GCM + 防重放                    │
├─ 执行层：BLE 写开锁指令 → 等回执 → 断开             │
├─ 降级链：自动失败 → 震动提示 → 亮屏手动 → NFC 刷卡  │
└────────────────────────────────────────────────────┘
```

核心原则：**触发 ≠ 授权**。任何"靠近检测"只是触发信号，开门与否由设备侧验证加密凭证决定——和比亚迪方案同一个哲学。

四者的分工解耦：BLE 负责"发现和通信"，iBeacon 负责"被杀唤醒"，UWB 负责"精准判定"，凭证负责"授权"。任何一层可独立迭代。

---

## 四、详细实施（10 步）

> 建议配置：2 名 iOS + 1 名嵌入式 + 1 名后端，8~12 周。

### 第 0 步：硬件与协议前置（最容易被跳过，最重要）

给嵌入式团队的固件规格：

| 项目 | 规格 | 原因 |
|------|------|------|
| BLE 广播间隔 | 100~200ms | iOS 发现速度的关键，>500ms 体感明显变慢 |
| 广播内容 | service UUID + 设备标识 | iOS 按 service 过滤扫描省电 |
| 设备标识 | **rolling identifier**（每 15 分钟密钥轮换） | 防第三方固定广播追踪住户 |
| GATT | 1 service：write（withResponse）+ notify 特征 | 指令下发 + 回执通道 |
| 并发连接 | ≥2 | Android/iOS 双端测试不互相占线 |
| iBeacon 帧 | 周期性插入广播 | 一枚芯片发两种广播，成本≈0 |

协议帧三方定稿：magic/version/cmd/seq/毫秒时间戳/deviceID/userToken/payload(AES-256-GCM)/CRC32（标准多项式 0xEDB88320）。**字节序、时间戳单位、GCM 密文封装格式（nonce||cipher||tag）逐字段签字**——双端互通的坑（字节序、Base64 变体、时间戳秒/毫秒、CRC32 多项式）全部在这一步消灭。

凭证体系双轨：**2 分钟滚动凭证**（自动触发专用，泄露窗口极小，可独立吊销）+ **24 小时离线凭证**（断网兜底，恢复联网补传记录）。

**验证**：三方评审会签《协议定稿 v1.0》。

### 第 1 步：工程配置

```xml
<key>NSBluetoothAlwaysUsageDescription</key>
<string>用于发现附近门锁并执行蓝牙开锁</string>
<key>NSBluetoothPeripheralUsageDescription</key>
<string>用于发现附近门锁并执行蓝牙开锁</string>
<key>NSLocationWhenInUseUsageDescription</key>
<string>用于扫描附近门锁</string>
<key>NSLocationAlwaysAndWhenInUseUsageDescription</key>
<string>用于在您靠近门锁时自动唤醒开门功能</string>
<key>UIBackgroundModes</key>
<array>
    <string>bluetooth-central</string>
    <string>location</string>
</array>
```

要点：蓝牙 iOS 13+ 用 Always 键（老键双写兼容 iOS 12）；定位权限必须引导升级 Always——**iBeacon region 被杀唤醒依赖 Always 授权**；蓝牙无需主动申请，但监听 `.unauthorized` 引导用户去设置。

### 第 2 步：BLE 主链路

**初始化——恢复标识从第一天就加上**（后补会导致线上存量 App 无法恢复）：

```swift
centralManager = CBCentralManager(
    delegate: self,
    queue: dispatchQueue,   // 独立串行队列
    options: [CBCentralManagerOptionRestoreIdentifierKey: "com.company.lock.central"]
)
```

**贴近判定——双条件 + 滤波**（防单次尖峰误触）：

```swift
final class ProximityJudge {
    private var samples: [Int] = []
    private var consecutiveHit = 0
    private let threshold = -60      // 贴近阈值
    private let windowSize = 5       // 5 点滑动窗口
    private let requiredHits = 3     // 连续 3 次达标才触发

    func evaluate(rssi: Int) -> Bool {
        samples.append(rssi)
        if samples.count > windowSize { samples.removeFirst() }
        let filtered = Double(samples.reduce(0,+)) / Double(samples.count)
        if filtered > threshold {
            consecutiveHit += 1
            return consecutiveHit >= requiredHits
        }
        consecutiveHit = 0
        return false
    }
}
```

**主流程**：扫描（AllowDuplicates 跟踪 RSSI）→ 命中 stopScan → 连接（超时 5s，失败指数退避 1s/2s/4s 上限 3 次）→ discoverServices → discoverCharacteristics → 订阅 notify → 按 `maximumWriteValueLength` 分包 withResponse 写入 → 等回执 3s 超时兜底 → 主动断开。

iOS 不能手动协商 MTU（Android 可以 requestMtu），超长指令按最大写入长度切片，在 `didWriteValueFor` 回调里按序续写；协议头带 totalLength/seq，设备侧重组——反向的 notify 粘包同理，按协议长度字段缓冲。

**验证**：从 5 米外走向门锁记录触发距离（目标 1~2m）；隔壁工位模拟"隔壁"场景验证不误触；100 字节指令验证分包。

### 第 3 步：后台与被杀场景（状态恢复）

后台保活：常用门 keep-alive 不断开（系统接管连接），非常用门断开退化为事件唤醒。

被杀场景三件套（第 1 步勾 Background Modes + 第 2 步传了 RestoreIdentifier）：

```swift
func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
    // willRestoreState 先于 didUpdateState 回调
    if let peripherals = dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral],
       let peripheral = peripherals.first {
        connectedPeripheral = peripheral
        peripheral.delegate = self
        peripheral.discoverServices([lockServiceUUID])  // 恢复的特征可能未就绪，重新发现
    }
    if let services = dict[CBCentralManagerRestoredStateScanServicesKey] as? [CBUUID] {
        central.scanForPeripherals(withServices: services, options: nil)
    }
}
```

机制：App 被系统杀死时，系统蓝牙守护进程仍持有 central manager，事件到来时冷启动 App。**关键边界：用户在多任务界面主动划掉的 App 不会被恢复**——这是 iOS 硬边界，能讲出边界并给出产品层对策（小组件一键开门），比吹嘘"100% 无感"专业。

### 第 4 步：iBeacon 系统级触发器（解决"被杀唤醒"的最大痛点）

CoreLocation 的 region monitoring 是系统守护进程服务，**和 BLE 扫描的后台降频不是一套机制**——即使 App 被系统杀死，region 事件依然能唤醒 App 并获得数秒~十余秒的执行窗口，足够完成"BLE 快速连接 + 下发开锁"。这比 BLE 状态恢复更可靠（不依赖用户没划杀、不要求预建连接）。

```swift
import CoreLocation

func register(door: Door) {
    let region = CLBeaconRegion(uuid: UUID(uuidString: door.beaconUUID)!,
                                major: CLBeaconMajorValue(door.major),
                                minor: CLBeaconMinorValue(door.minor),
                                identifier: "door_\(door.id)")
    region.notifyOnEntry = true
    locationManager.startMonitoring(for: region)
}

// App 被杀后靠近门，系统仍回调：
func locationManager(_ manager: CLLocationManager, didEnterRegion region: CLRegion) {
    DeviceManager.shared.handleBeaconWake(doorIdentifier: region.identifier)
}
```

要点：region 上限几十个，覆盖用户所有门 + 常去楼栋；唤醒窗口只有 ~10 秒，`BGProcessingTask` 续命是系统审批制，只能当优化不能当依赖；iBeacon 精度只有"几米区域"且穿墙也报，**只能当触发器，不能当安全判定**。

### 第 5 步：UWB 测距升级

App 侧 Nearby Interaction 是公开 API 无需 entitlement；**配件侧固件需 MFi 授权**（实现 Apple 测距协议），提前与芯片方案商确认。交互：BLE 连接建立后读门锁的 UWB 配置特征 → 启动 NISession → 持续回调 distance/direction → 距离圈判定：

```swift
func session(_ session: NISession, didUpdate nearbyObjects: [NINearbyObject]) {
    guard let object = nearbyObjects.first,
          let distance = object.distance else { return }
    if distance < 1.5 {          // 触发圈
        onApproachConfirmed?()     // 距离+方位判定，BLE RSSI 做不到方向判断
        stop()
    }
}
```

切换策略：连接后读 capability 特征，支持 UWB 的门判定权交给 UWB（精度高、防隔壁误触），老门回退 BLE RSSI 双条件。

### 第 6 步：协议编解码与凭证

编解码用 AES-256-GCM：选 GCM 而非 CBC+HMAC 是因为一个算法同时提供加密和完整性认证；**nonce 每次随机、同密钥下绝不复用**（复用会泄露认证密钥）；协议明文头作为 AAD 绑定，攻击者改头部任一字节解密认证必然失败；seq + 毫秒时间戳双防重放。

凭证存储必须 Keychain 而非 UserDefaults，且权限用 `kSecAttrAccessibleAfterFirstUnlock`——**App 被系统杀死唤醒后仍能读到凭证**，这是 region 唤醒链路的硬性要求：

```swift
final class CredentialStore {
    /// 热路径策略：内存缓存直读（不碰网络）→ 快过期异步轮换 → 无网用 24h 离线凭证
    func credential(for doorId: String) async throws -> DoorCredential {
        if let cached = rollingCache[doorId], !cached.isExpired {
            if cached.shouldRotate {
                Task { try? await refreshRolling(doorId: doorId) }  // 不阻塞当前开锁
            }
            return try validated(cached)
        }
        if let fresh = try? await refreshRolling(doorId: doorId) { return try validated(fresh) }
        if let offline = loadOfflineCredential(doorId: doorId), !offline.isExpired {
            return try validated(offline)
        }
        throw CredentialError.notFound(doorId: doorId)
    }
    // 吊销：本地黑名单（Keychain 持久化）+ 启动/推送时云端同步，双通道
}
```

### 第 7 步：业务编排层（漏斗与降级）

统一状态机 `idle → scanning → connecting → discovering → ready → unlocking → disconnected`，所有 BLE 回调只翻译状态，UI 只订阅状态。

```swift
func attemptAutoUnlock(door: Door, source: TriggerSource) {
    guard isTriggerAllowed(door: door), !state.isBusy else { return }
    switch appLifecycleState {
    case .foreground:
        transition(to: .scanning); ble.startScan()
    case .background:
        if door.isFavorite {
            ble.isConnected(to: door) ? executeUnlock(door: door, source: source)
                                      : ble.reconnectFavorite(door)
        } else {
            beacon.ensureMonitoring(door: door)   // 等 region 唤醒
        }
    case .terminated:
        break  // 被动链路：region 唤醒 / BLE 恢复后殊途同归到 executeUnlock
    }
}
```

**降级链**：自动失败 → 重试 1 次（seq 幂等，锁是副作用设备，盲目重试有风险）→ 震动 + 本地通知"点此开门" → 30 秒无响应引导 NFC 刷卡。

**安全收敛**：同门 10 秒窗口限频；一小时内自动触发 >20 次 → 风控降级手动并上报。每次自动开门记审计日志（触发源/RSSI 或 UWB 距离/凭证 ID/时间）——误触投诉的回溯就靠它。

### 第 8~10 步：服务端、测试与发布

**服务端**：凭证签发/轮换/吊销（2min 滚动与 24h 离线分开密钥和通道）、开锁记录全量审计、远程配置（阈值/开关/灰度——新逻辑不发版可回滚）。

**测试矩阵**（真机 × iOS 版本）：

| 场景 | 前台 | 后台 | 被杀 | 划杀 |
|------|------|------|------|------|
| 自动开锁 | ✅ | ✅ keep-alive/region | ✅ region+恢复 | 仅 NFC |

机型覆盖有 U1（12+）、无 U1（SE/16e）、最低系统机型。专项：连续 100 次成功率 ≥99.5%；弱信号成功率；**重放攻击录制重放必须失败**；篡改帧头任一字段 GCM 必须失败；吊销后 1 分钟内不可开；功耗挂 Instruments 8 小时目标蓝牙耗电 <2%。

**发布**：权限文案与功能一致（定位必须写明"靠近自动开门"用途）、Privacy Manifest 补齐 Required Reason API、准备后台模式审核答复话术、灰度开关上线、漏斗埋点看板（region 唤醒率 → 扫描命中率 → 连接成功率 → 开锁成功率，哪层掉量补哪层）。

---

## 五、落地路线与风险

| 阶段 | 内容 | 周期 |
|------|------|------|
| P0 | BLE 主链路 + 工程配置 | 1~2 月 |
| P1 | 贴近判定 + iBeacon 触发器 + 凭证体系 | 1~2 月（可与 P0 并行） |
| P2 | UWB（MFi 配件授权提前 2 个月启动，不阻塞主线） | 授权周期 3~6 月 |
| P3 | NFC & SE Platform 申请（港澳/海外项目）/ Home Key 评估 | 商务周期 |

**风险预警**（提前排雷）：

1. 固件广播间隔不达标 → iOS 发现慢，第 0 步就要样机实测；
2. 定位权限被拒率 → region 触发链路全灭，引导页和降级链必须做；
3. 划杀投诉 → 管理预期（这是系统硬边界），产品文案引导 + 小组件；
4. iOS 大版本发布周 → 真机回归矩阵优先跑（iOS 26 车钥匙失效事件的教训）。

---

## 六、总结

把三份知识收拢成一张图：

```
比亚迪方案（苹果托管）          我们的自研方案（无授权）
┌────────────────────┐        ┌────────────────────────────┐
│ Wallet + SE 密钥    │        │ Keychain 凭证（AfterFirstUnlock）│
│ BLE 发现 + UWB 判定 │  ===>  │ BLE 扫描 + RSSI/UWB 判定     │
│ 系统级响应，App 无关 │        │ iBeacon region 补"被杀唤醒"   │
│ MFi+CCC 认证 6~12月 │        │ 8~12 周上线，零授权           │
└────────────────────┘        └────────────────────────────┘
   触发 ≠ 授权，三层通道漏斗，防中继设计——哲学完全一致
```

两者的架构哲学完全同构：**触发与授权分离、三通道漏斗、抗中继优先**。差别在于苹果方案把密钥托管进 Secure Element、响应下沉到系统层，换来"App 无关、没电可用"的极致体验，代价是 MFi 认证和硬件预埋；自研方案用 Keychain + 凭证体系换取零门槛快速落地，代价是被杀/划杀场景的边界要靠 iBeacon 和产品设计去补。

对国内门禁公司，现实的组合是：**BLE 自研方案现在就能上线跑通主链路，iBeacon 补齐可靠性，UWB 做体验升级，NFC & SE Platform 等待大陆开放**——每一步都不阻塞下一步。

---

## 参考资料

**比亚迪方案拆解：**
- [车质网：比亚迪汉EV千山翠推出iPhone UWB数字钥匙](https://www.12365auto.com/news/20231114/516415.shtml)
- [汽车之家：比亚迪所有车型标配NFC/UWB首搭车型](https://chejiahao.autohome.com.cn/info/13980392)
- [中关村在线：iPhone如何开通比亚迪UWB数字钥匙](https://m.zol.com.cn/article/8430173.html)
- [网易：比亚迪全系标配NFC数字钥匙，首个推出UWB](https://www.163.com/dy/article/ILAOMN0C0547IE2P.html)
- [The Weekly Driver: Apple Car Key Guide](https://theweeklydriver.com/2025/12/apple-car-key-guide/)
- [WWDC20: Introducing Car Keys](https://developer.apple.com/videos/play/wwdc2020/10006/)

**苹果生态准入：**
- [Apple Developer: NFC & SE Platform](https://developer.apple.com/support/nfc-se-platform/)
- [Apple Newsroom: In-app NFC transactions using the Secure Element](https://www.apple.com/newsroom/2024/08/developers-can-soon-offer-in-app-nfc-transactions-using-the-secure-element/)
- [Apple Developer: CarKey framework](https://developer.apple.com/documentation/CarKey)
- [MFi Program: How It Works](https://mfi.apple.com/en/how-it-works.html)
- [DEKRA: CarKey 授权测试实验室](https://www.dekra.com/en/dekra-expands-its-scope-and-locations-as-an-mfi-authorized-test-laboratory-for-car-key/)

**系统适配风险案例：**
- [MacRumors: iOS 26 被动车钥匙失效讨论](https://forums.macrumors.com/threads/ios-26-passive-car-key-i-e-phone-in-pocket-functionality-not-working-anyone-else-seeing-this.2466892/)
- [Apple Discussions: iOS 26 Digital Key 失效](https://discussions.apple.com/thread/256155099)
