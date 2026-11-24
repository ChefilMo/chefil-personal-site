---
title: "Unlock When Your iPhone Gets Close: Reverse-Engineering BYD's UWB Digital Key, and Shipping a Self-Developed BLE+UWB Solution"
description: A teardown of how BYD's UWB digital key works, a map of Apple's three-tier access rules, and a practical self-developed BLE+UWB door-unlock plan that ships in 8–12 weeks without Apple's authorization.
pubDate: 2026-11-23
lang: en
translationKey: iphone-uwb-door-unlock
tags: [IoT, iOS, BLE, UWB]
category: ios
---

> Walk up to your car with your hands full and the doors unlock themselves — BYD and BMW owners have enjoyed this for years. But if you run an access-control or smart-lock company and want "walk up to the door and it opens" on iOS, you'll find it's far from straightforward: **Apple slices these capabilities into three tiers of ecosystem access, and picking the wrong path costs you months.**
>
> This article does three things: teardown how BYD's solution works (the industry benchmark), map Apple's three access paths (which determine what you're allowed to build), and lay out a self-developed route that ships in 8–12 weeks without Apple's authorization.

---

## 1. The benchmark first: how BYD's "approach to unlock" works

### 1.1 The basics

BYD is the first Chinese brand to launch a UWB digital key (April 2022) and the first Chinese automaker certified under Apple's Car Key MFi program. The first model supporting the iPhone UWB digital key was the Han EV Qianshancui limited edition (November 2023), followed by the Tang DM-p, Denza N7/D9, and Yangwang U8.

The experience: carrying an iPhone or Apple Watch, the car unlocks automatically within ~5 meters and locks again as you walk away — **even with no network on the phone**. The hardware floor is iPhone 11 or newer (with the U1 chip; SE/16e excluded).

### 1.2 The key insight: this is Apple's standard, not BYD's in-house design

The core capability behind "approach to unlock" is the **Apple CarKey system + the CCC Digital Key 3.0 standard**; BYD's work was the vehicle-side implementation. The architecture is a three-channel funnel:

```
┌─ Apple CarKey system (MFi-licensed access) ─────────────┐
│ Key carrier: Apple Wallet   Key material: Secure Element │
│ Express Mode: works even at low battery                  │
├─ Three wireless channels (CCC DK 3.0) ──────────────────┤
│ BLE: discovery + out-of-band handshake                   │
│      (car advertises, phone responds at system level)    │
│ UWB: precise ranging + direction (the only trustworthy   │
│      basis for "the owner is by the car")                │
│ NFC: fallback (unlock by touching the B-pillar / mirror  │
│      with a dead phone)                                  │
└─ Vehicle: UWB anchor array + BLE + NFC reader + PEPS ───┘
```

### 1.3 The unlock flow, step by step

```
① The car continuously broadcasts BLE advertisement frames (low-rate, low-power)
② The iPhone hears the target advertisement at system level — note: the app
   doesn't need to be foreground, or even launched
③ BLE out-of-band handshake: exchange parameters for this UWB ranging session
④ UWB ranging: multiple in-car anchors and the iPhone U1 measure mutual distance
   (ToF, 10–30cm accuracy; multi-anchor triangulation yields distance + bearing),
   using Scrambled Timestamp Sequence (STS) to resist relay attacks
⑤ Vehicle PEPS decision: distance < threshold AND bearing on the door side
   → "owner approaching"
⑥ The iPhone's SE signs the vehicle's challenge with its private key
   → vehicle verifies the signature → "this is an authorized key"
⑦ Unlock; as distance keeps increasing (owner walking away) → auto-lock
```

Two design philosophies you must internalize:

1. **Trigger ≠ authorization.** UWB ranging only answers "where is the person"; the signature answers "are they allowed to open the door." The proximity signal only initiates the challenge — it is never, by itself, grounds to unlock.
2. **No app involved at any point.** On the iPhone, the system Wallet/SE + baseband + U1 chip work together. The app can be deleted, the phone can be powered off (Express Mode keeps working for hours), and there's no network — the chain still works.

### 1.4 The security design: why "zero-interaction" is safe

| Mechanism | Defends against |
|-----------|-----------------|
| Private key generated in the Secure Element, never leaves the chip; signing happens on-chip | Key extraction via jailbreak/reverse engineering |
| Vehicle issues a random challenge → key signs it → vehicle verifies | Replay attacks (recording and re-broadcasting a session is useless) |
| UWB ToF + STS scrambled timestamps | **Relay attacks** — BLE RSSI can be "stretched" by signal amplifiers (real-world car-key thefts have used this); UWB ranging is inherently relay-resistant |
| Session-level ranging keys, discarded after use | Recording and reusing a session |
| Key bound to Apple ID + VIN; revocable from the cloud | Abuse after the phone is lost |

**Why it works offline:** the entire verification chain (UWB ranging + SE signing + local public-key verification) completes on-device. The cloud only handles provisioning, sharing, and revocation.

### 1.5 The costs and risks

- **Access**: MFi certification + CCC membership, 6–12 months end to end, mostly business/compliance effort;
- **Pre-installed hardware**: ~6 UWB anchors in the vehicle plus an NFC reader; older models can't be retrofitted — which is why only high trims support it;
- **Ongoing maintenance**: after iOS 26 shipped, large numbers of BMW/BYD/Volvo owners reported passive entry via UWB breaking. **The core chain is managed by Apple's OS, so every major iOS upgrade is a regression risk** — any digital-key product needs a real-device regression matrix for new iOS versions. This is a hidden recurring cost, not a one-off task.

---

## 2. Apple's access rules: three paths, of which you're eligible for one or two

To replicate the experience above, first understand the three tiers Apple has sliced the capability into:

| Path | Capability | Access | Who it fits |
|------|-----------|--------|-------------|
| **A. Apple CarKey** | Wallet car key + UWB passive entry | **Automakers only**: MFi + CCC dual certification | OEMs |
| **B. NFC & SE Platform** | Secure in-app NFC transactions (access badges / employee cards / hotel keys / student IDs) | Commercial agreement + entitlement; **territory list applies** | Access-control / hotel / campus operators |
| **C. Self-developed BLE + UWB** | In-app BLE unlocking | No barrier | Everyone |

### 2.1 Path A: CarKey (automakers only, 9 steps)

Join CCC and get the Digital Key 3.0 spec → register for MFi → sign agreements and request the `com.apple.developer.carkey.session` entitlement → **integrate your servers with Apple's backend in both sandbox and production** (register / revoke / notify keys) → vehicle-side SE applet (NFC via ECP, UWB via Secure Ranging) → CCC applet certification → self-test with Apple's Car Keys Tests app → testing at an MFi-authorized lab such as DEKRA → Apple's final review.

On the client side, the public part of the CarKey framework (iOS 16+) is the **remote-control** capability for the automaker's app. Key provisioning happens through server-side integration, not a client API:

```swift
import CarKey

// After the key is in Wallet, the automaker's app can remote-control the car
// (lock/unlock, windows)
private var session: CarKeyRemoteControlSession?

func startSession() {
    // Only one active session at a time; the system ends it automatically
    // when the app leaves the foreground
    session = CarKeyRemoteControl.shared.start(delegate: self,
                                               subscriptionRange: .far,
                                               with: nil)
}
```

### 2.2 Path B: NFC & SE Platform (the realistic Apple-ecosystem path for access control)

Since iOS 18.1, Apple opened SE-based secure credentials to third-party apps. Supported use cases explicitly include **home keys, corporate badges (access control), hotel keys, and student IDs**.

The flow: sign a commercial agreement (fees involved) + NDA → the Account Holder submits the request → enroll in Apple Business Register and request the entitlement (`com.apple.developer.secure-element-credential`) → develop the SE applet → third-party lab security review → Apple signs and hosts the applet → the app implements the four API families: Provisioning / Presentment / Lifecycle.

Hard constraints: **a Secure Enclave authorization (Face ID / passcode) is required before every tap**; the terminal side uses ISO 14443-4 / 7816-4; users can set your app as the default contactless app, after which a double-click of the side button — or just bringing the phone near the reader's field — starts the transaction.

**One decisive fact for mainland-China companies**: the eligible-territories list includes Hong Kong, Macau, and Taiwan — **but not mainland China**. The realistic mix for domestic business: self-developed BLE as the backbone + watch for mainland availability; for HK/Macau/overseas projects, start the NFC & SE application immediately; for residential smart locks, evaluate HomeKit HAP + Home Key (Aqara and others have already shipped this in China).

### 2.3 Path C: self-developed BLE + UWB

No access barrier, can start today, ships in 8–12 weeks — this is the protagonist of the rest of this article.

---

## 3. The self-developed architecture: a four-layer funnel

```
┌─ Trigger layer: who wakes the app up? ──────────────────┐
│   Foreground      → full-speed BLE scan                 │
│   Background      → BLE state restoration + keep-alive  │
│                     for favorite doors                    │
│   Killed by OS    → iBeacon region system-level wake ★  │
│   Swiped away     → no solution (hard iOS boundary),    │
│                     NFC fallback                        │
├─ Proximity layer: is the person really at the door? ────┤
│   BLE: filtered RSSI + threshold + N consecutive hits   │
│   UWB: distance circle (<1.5m) + bearing check          │
│        (prevents triggering for the neighbor's door)    │
├─ Authorization layer: credential verification           │
│   (fully decoupled from triggering)                     │
│   short-lived rolling credential + AES-GCM + anti-replay│
├─ Execution layer: BLE write unlock cmd → ack → disconnect│
├─ Degradation chain: auto fail → vibration prompt →      │
│   manual unlock on screen → NFC card tap                │
└──────────────────────────────────────────────────────────┘
```

The core principle: **trigger ≠ authorization**. Any "proximity detection" is only a trigger signal; whether the door opens is decided by the device verifying an encrypted credential — the same philosophy as BYD's solution.

The four layers are decoupled: BLE handles "discovery and communication," iBeacon handles "wake when killed," UWB handles "precise judgment," and credentials handle "authorization." Each layer can be iterated independently.

---

## 4. Implementation in 10 steps

> Suggested team: 2 iOS + 1 embedded + 1 backend, 8–12 weeks.

### Step 0: hardware and protocol prerequisites (most often skipped, most important)

Firmware spec for the embedded team:

| Item | Spec | Why |
|------|------|-----|
| BLE advertisement interval | 100–200ms | The key to iOS discovery speed; >500ms feels noticeably sluggish |
| Advertised payload | service UUID + device identifier | iOS filters scans by service to save power |
| Device identifier | **rolling identifier** (key rotates every 15 min) | Prevents third parties from tracking residents via a fixed broadcast |
| GATT | 1 service: write (withResponse) + notify characteristic | Command downlink + ack channel |
| Concurrent connections | ≥2 | Android/iOS testing doesn't block each other |
| iBeacon frame | interleaved into the advertisement | One chip broadcasts both formats; ~zero extra cost |

Finalize the protocol frame with all three parties: magic/version/cmd/seq/millisecond timestamp/deviceID/userToken/payload(AES-256-GCM)/CRC32 (standard polynomial 0xEDB88320). **Sign off byte order, timestamp units, and the GCM wire format (nonce||cipher||tag) field by field** — every cross-platform pitfall (endianness, Base64 variants, seconds vs. milliseconds, the CRC32 polynomial) gets eliminated at this step.

Two-track credential system: **2-minute rolling credentials** (dedicated to auto-trigger; tiny leak window; independently revocable) + **24-hour offline credentials** (fallback when offline; records sync after reconnect).

**Verification**: a three-party review signs off "Protocol Finalization v1.0."

### Step 1: project configuration

```xml
<key>NSBluetoothAlwaysUsageDescription</key>
<string>Used to discover nearby locks and perform Bluetooth unlocking</string>
<key>NSBluetoothPeripheralUsageDescription</key>
<string>Used to discover nearby locks and perform Bluetooth unlocking</string>
<key>NSLocationWhenInUseUsageDescription</key>
<string>Used to scan for nearby locks</string>
<key>NSLocationAlwaysAndWhenInUseUsageDescription</key>
<string>Used to wake up auto-unlock when you approach a lock</string>
<key>UIBackgroundModes</key>
<array>
    <string>bluetooth-central</string>
    <string>location</string>
</array>
```

Key points: for Bluetooth on iOS 13+, use the Always key (write both old and new keys for iOS 12 compatibility); you must guide users to upgrade location permission to Always — **iBeacon region wake-up depends on Always authorization**; Bluetooth needs no explicit request, but listen for `.unauthorized` and guide the user to Settings.

### Step 2: the BLE main link

**Initialization — add the restoration identifier from day one** (adding it later leaves already-shipped apps unable to restore):

```swift
centralManager = CBCentralManager(
    delegate: self,
    queue: dispatchQueue,   // dedicated serial queue
    options: [CBCentralManagerOptionRestoreIdentifierKey: "com.company.lock.central"]
)
```

**Proximity judgment — dual condition + filtering** (guards against single-spike false triggers):

```swift
final class ProximityJudge {
    private var samples: [Int] = []
    private var consecutiveHit = 0
    private let threshold = -60      // proximity threshold
    private let windowSize = 5       // 5-sample sliding window
    private let requiredHits = 3     // trigger only after 3 consecutive hits

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

**Main flow**: scan (AllowDuplicates to track RSSI) → on hit, stopScan → connect (5s timeout; exponential backoff 1s/2s/4s, max 3 attempts) → discoverServices → discoverCharacteristics → subscribe to notify → write in chunks of `maximumWriteValueLength` with response → wait for ack with 3s timeout fallback → disconnect proactively.

iOS can't negotiate MTU manually (Android can, via requestMtu); slice long commands at the max write length and continue in `didWriteValueFor` callbacks; the protocol header carries totalLength/seq and the device reassembles — the reverse direction (notify粘包, fragmented notifications) is handled the same way via the length field.

**Verification**: walk toward the lock from 5m away and record the trigger distance (target 1–2m); have a colleague at the next desk simulate "the neighbor's door" to verify no false trigger; verify chunking with a 100-byte command.

### Step 3: background and killed-app scenarios (state restoration)

Background keep-alive: keep favorite-door connections alive (the system takes over the connection); drop non-favorite connections and degrade to event-driven wake.

The killed-app three-piece set (Background Modes from Step 1 + RestoreIdentifier from Step 2):

```swift
func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
    // willRestoreState fires before didUpdateState
    if let peripherals = dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral],
       let peripheral = peripherals.first {
        connectedPeripheral = peripheral
        peripheral.delegate = self
        peripheral.discoverServices([lockServiceUUID])  // restored characteristics may
    }                                                   // not be ready; re-discover
    if let services = dict[CBCentralManagerRestoredStateScanServicesKey] as? [CBUUID] {
        central.scanForPeripherals(withServices: services, options: nil)
    }
}
```

Mechanism: when the system kills the app, the system's Bluetooth daemon still holds the central manager, and an incoming event cold-starts the app. **The critical boundary: an app the user force-quits from the app switcher will NOT be restored** — this is a hard iOS boundary. Knowing the boundary and designing product-level countermeasures (a widget for one-tap unlock) is more professional than promising "100% seamless."

### Step 4: iBeacon as a system-level trigger (the biggest fix for "wake when killed")

CoreLocation region monitoring is a system-daemon service, **a different mechanism from the background scan throttling of BLE** — even if the app is killed by the system, region events still wake the app and grant an execution window of several to ten-plus seconds, enough to "connect via BLE quickly + send the unlock command." This is more reliable than BLE state restoration (it doesn't depend on the user not force-quitting, and doesn't require a pre-existing connection).

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

// Even with the app killed, the system still calls back when the user
// approaches the door:
func locationManager(_ manager: CLLocationManager, didEnterRegion region: CLRegion) {
    DeviceManager.shared.handleBeaconWake(doorIdentifier: region.identifier)
}
```

Key points: the region limit is a few dozen — cover all the user's doors plus frequently visited buildings; the wake window is only ~10 seconds; `BGProcessingTask` extensions are subject to system approval — treat them as an optimization, never a dependency; iBeacon accuracy is only "a few-meter zone" and fires through walls, so **it's a trigger only, never a security judgment**.

### Step 5: the UWB ranging upgrade

On the app side, Nearby Interaction is a public API needing no entitlement; **the accessory firmware requires an MFi license** (it must implement Apple's ranging protocol) — confirm with your chip vendor early. Interaction: after the BLE connection is up, read the lock's UWB configuration characteristic → start an NISession → receive continuous distance/direction callbacks → distance-circle judgment:

```swift
func session(_ session: NISession, didUpdate nearbyObjects: [NINearbyObject]) {
    guard let object = nearbyObjects.first,
          let distance = object.distance else { return }
    if distance < 1.5 {          // trigger circle
        onApproachConfirmed?()     // distance + bearing; BLE RSSI can't do direction
        stop()
    }
}
```

Switching strategy: after connecting, read a capability characteristic; for UWB-capable locks, hand the judgment to UWB (higher accuracy, prevents the neighbor-door problem); older locks fall back to the dual-condition BLE RSSI check.

### Step 6: protocol codec and credentials

Use AES-256-GCM for the codec: GCM instead of CBC+HMAC because one algorithm provides both encryption and integrity; **the nonce is random per message and never reused under the same key** (reuse leaks the authentication key); the plaintext protocol header is bound as AAD, so changing any header byte inevitably fails decryption/verification; seq + millisecond timestamp provide dual anti-replay.

Credentials must live in the Keychain, not UserDefaults, with `kSecAttrAccessibleAfterFirstUnlock` — **the credential must still be readable after the app is killed and woken**, a hard requirement of the region-wake chain:

```swift
final class CredentialStore {
    /// Hot-path policy: read from in-memory cache (no network) → rotate async when
    /// near expiry → fall back to the 24h offline credential when offline
    func credential(for doorId: String) async throws -> DoorCredential {
        if let cached = rollingCache[doorId], !cached.isExpired {
            if cached.shouldRotate {
                Task { try? await refreshRolling(doorId: doorId) }  // don't block this unlock
            }
            return try validated(cached)
        }
        if let fresh = try? await refreshRolling(doorId: doorId) { return try validated(fresh) }
        if let offline = loadOfflineCredential(doorId: doorId), !offline.isExpired {
            return try validated(offline)
        }
        throw CredentialError.notFound(doorId: doorId)
    }
    // Revocation: local blacklist (persisted in Keychain) + cloud sync on
    // launch / push — two channels
}
```

### Step 7: the orchestration layer (funnel and degradation)

One unified state machine: `idle → scanning → connecting → discovering → ready → unlocking → disconnected`. All BLE callbacks only translate state; the UI only subscribes to state.

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
            beacon.ensureMonitoring(door: door)   // wait for a region wake
        }
    case .terminated:
        break  // passive chain: region wake / BLE restoration both converge
               // on executeUnlock
    }
}
```

**Degradation chain**: auto-unlock fails → retry once (seq is idempotent; a lock is a side-effecting device, and blind retries are risky) → vibration + local notification "tap to open" → after 30s of no response, guide the user to tap an NFC card.

**Safety convergence**: rate-limit to one auto-trigger per door per 10s window; >20 auto-triggers in an hour → risk-control downgrade to manual mode + report. Log an audit record for every auto-unlock (trigger source / RSSI or UWB distance / credential ID / timestamp) — this is what you rely on when tracing false-trigger complaints.

### Steps 8–10: server, testing, release

**Server**: credential issuance/rotation/revocation (2-minute rolling and 24-hour offline tracks use separate keys and channels), full audit logging of unlocks, remote configuration (thresholds / feature flags / gradual rollout — new logic can roll back without an app release).

**Test matrix** (real devices × iOS versions):

| Scenario | Foreground | Background | Killed by OS | Force-quit |
|----------|-----------|------------|--------------|------------|
| Auto-unlock | ✅ | ✅ keep-alive/region | ✅ region+restore | NFC only |

Device coverage: with U1 (12+), without U1 (SE/16e), and the oldest supported system version. Specific checks: ≥99.5% success over 100 consecutive attempts; weak-signal success rate; **recorded-and-replayed sessions must fail**; flipping any header byte must fail GCM verification; a revoked credential must stop working within 1 minute; power: 8 hours under Instruments with Bluetooth power draw <2%.

**Release**: permission prompts must match functionality (location prompt must state the "auto-unlock on approach" purpose); complete the Privacy Manifest's Required Reason APIs; prepare App Review talking points for background modes; ship behind a gradual-rollout flag; build a funnel metrics dashboard (region wake rate → scan hit rate → connection success rate → unlock success rate — fix whichever layer leaks).

---

## 5. Rollout plan and risks

| Phase | Scope | Timeline |
|-------|-------|----------|
| P0 | BLE main link + project configuration | 1–2 months |
| P1 | Proximity judgment + iBeacon trigger + credential system | 1–2 months (parallel with P0) |
| P2 | UWB (start the MFi accessory licensing 2 months early; doesn't block the main line) | License cycle 3–6 months |
| P3 | NFC & SE Platform application (HK/Macau/overseas projects) / Home Key evaluation | Business cycle |

**Risk warnings** (defuse these early):

1. Firmware advertisement interval out of spec → slow iOS discovery; benchmark on real hardware at Step 0.
2. Location-permission denial rate → the entire region-trigger chain dies; build the onboarding guide and the degradation chain.
3. Force-quit complaints → set expectations (it's a hard system boundary); guide with product copy + a widget.
4. Major iOS release week → run the real-device regression matrix first (the lesson of the iOS 26 car-key failures).

---

## 6. Summary

Three bodies of knowledge, one picture:

```
BYD solution (Apple-managed)      Self-developed solution (no license)
┌──────────────────────┐          ┌──────────────────────────────────┐
│ Wallet + SE keys     │          │ Keychain credentials             │
│ BLE discovery +      │  ===>    │ (AfterFirstUnlock)               │
│ UWB judgment         │          │ BLE scan + RSSI/UWB judgment     │
│ System-level,        │          │ iBeacon region fills the         │
│ app-independent      │          │ "killed-app wake" gap            │
│ MFi+CCC, 6–12 months │          │ Ships in 8–12 weeks, zero license│
└──────────────────────┘          └──────────────────────────────────┘
  Trigger ≠ authorization, three-channel funnel, relay resistance —
  the philosophy is identical
```

The architectures are isomorphic: **trigger/authorization separation, a three-channel funnel, relay resistance first**. The difference: Apple's design custodies keys in the Secure Element and sinks the response into the OS layer, trading MFi certification and pre-installed hardware for the ultimate "app-independent, works when dead" experience; the self-developed design trades a zero-barrier fast launch via Keychain + credentials, with the killed/force-quit boundary backfilled by iBeacon and product design.

For a China-based access-control company, the realistic combination is: **ship the self-developed BLE solution now to get the main chain live, use iBeacon to backfill reliability, use UWB as the experience upgrade, and wait for NFC & SE Platform to open in the mainland** — no step blocks the next.

---

## References

**BYD solution teardown:**
- [12365auto: BYD Han EV Qianshancui launches iPhone UWB digital key](https://www.12365auto.com/news/20231114/516415.shtml)
- [Autohome: NFC/UWB standard across BYD models](https://chejiahao.autohome.com.cn/info/13980392)
- [ZOL: How to enable the BYD UWB digital key on iPhone](https://m.zol.com.cn/article/8430173.html)
- [NetEase: BYD makes NFC digital keys standard, first to launch UWB](https://www.163.com/dy/article/ILAOMN0C0547IE2P.html)
- [The Weekly Driver: Apple Car Key Guide](https://theweeklydriver.com/2025/12/apple-car-key-guide/)
- [WWDC20: Introducing Car Keys](https://developer.apple.com/videos/play/wwdc2020/10006/)

**Apple ecosystem access:**
- [Apple Developer: NFC & SE Platform](https://developer.apple.com/support/nfc-se-platform/)
- [Apple Newsroom: In-app NFC transactions using the Secure Element](https://www.apple.com/newsroom/2024/08/developers-can-soon-offer-in-app-nfc-transactions-using-the-secure-element/)
- [Apple Developer: CarKey framework](https://developer.apple.com/documentation/CarKey)
- [MFi Program: How It Works](https://mfi.apple.com/en/how-it-works.html)
- [DEKRA: MFi-authorized CarKey test laboratory](https://www.dekra.com/en/dekra-expands-its-scope-and-locations-as-an-mfi-authorized-test-laboratory-for-car-key/)

**System-adaptation risk cases:**
- [MacRumors Forums: iOS 26 passive car key not working](https://forums.macrumors.com/threads/ios-26-passive-car-key-i-e-phone-in-pocket-functionality-not-working-anyone-else-seeing-this.2466892/)
- [Apple Discussions: iOS 26 digital key failure](https://discussions.apple.com/thread/256155099)
