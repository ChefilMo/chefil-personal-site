---
title: "第 16 篇：OTA Bootloader——Flash 分区、跳转术，以及\"只收一帧就死\"之谜"
description: "搭双工程最小 OTA 系统：Flash 分区规划、Bootloader 跳转判定、自写 Flash 的物理限制，以及一个教科书级真实 bug——OTA 总是只收到第一帧就失败，没有报错没有异常。"
pubDate: 2026-11-24
lang: zh
translationKey: wifi-thermometer-part16
tags: [嵌入式, STM32, 教程]
series: wifi-thermometer
seriesOrder: 16
category: embedded
---

> 功能拼图只剩最大的一块：OTA。固件出了 bug 怎么办？设备卖到全国各地，不可能收回来拆机重烧——必须让它自己能给自己换固件。
> 这一篇的知识密度是全系列最高之一：**Flash 分区规划、Bootloader 的跳转判定、自写 Flash 的物理限制**，以及一个教科书级的真实 bug：OTA 总是"只收到第一帧就失败"，没有报错，没有异常。

---

## 一、本篇目标与效果

**目标**：搭一个双工程最小系统——Bootloader 工程 + App 工程：

1. 上电时 Bootloader 检查升级标志：无升级请求 → 2 秒倒计时后跳转 App；
2. 按住按键（或串口命令）→ 留在升级模式，接收一段"固件数据"写入 App 区；
3. 写完置"升级成功"标志，复位后 Bootloader 把控制权交给新 App；
4. 升级中途断电再重启 → 不会跳转残缺固件（防砖）。

**做完你会懂**：为什么 App 不能给自己升级、分区表怎么画、Bootloader 跳转的五行关键代码、以及标志位设计的防砖哲学。

## 二、原理 10 分钟

### 2.1 为什么必须有个 Bootloader

最直觉的 OTA 方案：App 收到新固件，直接写自己的 Flash。物理上不成立——**Cortex-M 从 Flash 取指执行，很多芯片不允许对正在取指的同一块 Flash 做擦写**（擦除瞬间总线挂起，取指失败即崩溃）。就算硬件支持，"一边跑一边拆自己脚下的地板"也太冒险。

所以所有 MCU OTA 的标准结构都是**两段式**：

```
Flash 布局（产品真实分区）：

0x0000_0000 ┌─────────────┐
            │  Bootloader │  8 KB（实际占 4.5 KB）
            │  常驻，管升级 │
0x0000_2000 ├─────────────┤
            │             │
            │    App      │  15 KB，平时的你
            │             │
0x0000_5C00 ├─────────────┤
            │ OTA 标志区   │  UPDATE_REQUEST / UPDATE_OK
            │ + 设置存储   │
0x0000_6000 └─────────────┘
```

上电永远先跑 Bootloader，它做个简单的选择题：

```
检查 OTA 标志：
  UPDATE_REQUEST？ → 进升级模式，收数据写 App 区
  UPDATE_OK？      → 清标志，跳 App（新固件上任）
  都不是           → 直接跳 App（平时走这里，耗时毫秒级）
```

升级期间擦写 Flash 的是 Bootloader，App 根本不在场——2.1 的物理矛盾 elegantly 消解。

### 2.2 跳转的五行代码

Bootloader 把 CPU 交给 App，本质是"伪造一次复位"：设栈指针、设程序计数器。App 链接在 0x2000，所以：

```c
#define APP_ADDR   0x08002000    // 学习版 F103 可用 0x08004000，原理相同

static void jump_to_app(void)
{
    uint32_t app_sp = *(volatile uint32_t *)APP_ADDR;        // App 的栈顶
    uint32_t app_pc = *(volatile uint32_t *)(APP_ADDR + 4);  // App 的复位向量

    if (app_sp < 0x20000000 || app_sp > 0x20005000) return;  // 栈指针合法性检查
                                                             // （App 区是空的/残缺的，
                                                             //  这里第一个拦下）

    __disable_irq();                 // 关中断，拆除所有回调
    SysTick->CTRL = 0;               // 停掉滴答

    __set_MSP(app_sp);               // ① 换栈
    SCB->VTOR = APP_ADDR;            // ② 中断向量表重定位！（漏了它就等着死）
    __set_CONTROL(0);                // ③ 回到特权模式、用主栈
    ((void (*)(void))app_pc)();      // ④ 跳！（不再返回）
}
```

四个动作里，②最容易漏：**中断向量表默认在 Flash 起始处（Bootloader 的向量表）**，不重定位的话，App 里第一个中断（比如 SysTick）就会跳进 Bootloader 的中断函数里——魔幻症状，排查费时。Keil 里做 App 工程时，Target 选项卡里把起始地址改成 App 分区、scatter 文件同步改，启动代码里 VTOR 就位，四步缺一不可。

③检查也值一句：如果升级中途断电，App 区是半截固件，栈顶位置可能是个野值。先验证"栈指针落在合法 SRAM 范围"，非法就**不跳**——这是防砖的第一道闸。

### 2.3 标志位：写在最后的才算数

升级流程的完整时间线：

```
云端推包 → App 收到升级通知 → 置 UPDATE_REQUEST 标志 → 复位
  → Bootloader 见标志 → 收包写 Flash（逐页擦写）
  → 全部写完、校验通过 → 置 UPDATE_OK 标志 → 复位
  → Bootloader 见 OK → 跳新 App
```

注意顺序的讲究：**UPDATE_OK 必须在所有数据写完之后才写**。如果反过来——先置 OK 再写数据——中途断电的后果是"标志说成功了，App 区却是半截"，一上电就跳进残缺固件，砖了。"标志最后写"就是原子提交的嵌入式版：数据是草稿，标志是提交按钮。

同理，UPDATE_REQUEST 用掉后要及时清除（进升级模式第一件事就清），避免升级完成后下次上电又误进升级模式。

### 2.4 写入：解锁的幽灵回来了

第 12 篇写设置时学过 Flash 解锁五部曲。OTA 写固件是同一套，但量大得多（15 KB 一页页擦、半字半字写）。这里先埋一句话：**解锁序列漏一步，写操作静默丢弃**——不报错，不异常，读回还是旧数据。记住这个幽灵，彩蛋见。

## 三、动手：双工程最小 OTA

### 第一步：两个 Keil 工程

- **Bootloader 工程**：普通工程，芯片选型一致，链接地址不动（0x08000000）；
- **App 工程**：Options → Target → IROM1 起始 `0x08004000`、大小 `0xC000`（学习版给 Bootloader 留 16 KB）；勾选生成 .bin（fromelf 命令或 Keil 的 User 选项卡添加 `fromelf --bin -o ...`）。

App 的 `main()` 开头加：

```c
SCB->VTOR = 0x08004000;    // 向量表重定位（2.2 的②，App 侧也要做）
```

### 第二步：Bootloader 主流程

```c
#define MAGIC_REQUEST   0x5A5A
#define MAGIC_OK        0xA5A5
#define FLAG_ADDR       0x0800FC00          // 用最后一页做标志区

int main(void)
{
    clock_uart_gpio_init();
    flash_unlock();                          // 早解锁，省得忘了

    uint16_t flag = *(volatile uint16_t *)FLAG_ADDR;

    if (flag == MAGIC_OK) {                  // 升级成功：清标志，上新固件
        flash_erase_page(FLAG_ADDR);
        flash_write_halfword(FLAG_ADDR, 0xFFFF);
        jump_to_app();
    }

    if (flag == MAGIC_REQUEST) {             // 有升级任务
        flash_erase_page(FLAG_ADDR);         // 先清请求标志
        ota_receive_and_write();             // 收数据写 App 区（2.4 + 第 12 篇的函数）
        flash_erase_page(FLAG_ADDR);
        flash_write_halfword(FLAG_ADDR, MAGIC_OK);   // ★ 最后才写成功标志
        system_reset();
    }

    /* 平时：倒计时跳 App，按键打断进升级模式（五连击的角色由它客串） */
    uart_puts("boot: press key for OTA, else jump app in 2s\r\n");
    for (int i = 0; i < 20; i++) {
        if (key_pressed()) {
            flash_erase_page(FLAG_ADDR);
            flash_write_halfword(FLAG_ADDR, MAGIC_REQUEST);
            system_reset();
        }
        delay_ms(100);
    }
    jump_to_app();
}
```

### 第三步：简化版 OTA 传输

学习版的"固件数据"用一个极简文本协议代替真实 OTA 协议（真实的帧序号/偏移/CRC 机制留给你按同一思路扩展）：

```
上位机（串口助手/脚本）逐行发：
  :ADDRHHLL:DATAHEX\n
Bootloader 收到：解析地址+数据 → 半字写入 → 回 'K'
结束行：:DONE\n → Bootloader 校验几个关键字节 → 置 OK 标志
```

教学重点不在协议而在**节奏**：每写若干半字留意 Flash 编程时间、每跨页先擦页——正是这些"理所当然"的步骤里藏着彩蛋的那个 bug。

### 实验剧本

- [ ] 只烧 App 工程：复位后 Bootloader 倒计时直接跳 App，App 打印版本号 v1（App 必须先烧 Bootloader 再烧 App，顺序不能反）；
- [ ] 按住按键上电：进入升级模式，串口回显等待数据；
- [ ] 发送模拟固件数据（一个小数组即可），逐行收到 'K' 应答；
- [ ] 发送 :DONE：复位后 Bootloader 清 OK 标志跳进"新"App——教学版这里读出写入的数据验证一致性即可，想真换固件就把编译好的 App.bin 按行发进去（进阶）；
- [ ] **防砖测试**：升级到一半断电，重新上电——Bootloader 停在升级模式等待重刷，**绝不跳进半截固件**；
- [ ] **VTOR 实验**（破坏性学习）：把 App 里 `SCB->VTOR` 那行注释掉，观察跳过去之后第一个 SysTick 中断时的魔幻死机——然后恢复，体会 2.2 的②为什么单独标红。

## 四、原版对照（CIU32F003）

产品 Bootloader 的完整形态，本篇元素全有对应：

1. **分区**：Bootloader 8 KB（实际占 4.5 KB）+ App 15 KB + 标志/设置保留区，scatter 文件分别配置；
2. **进入方式**：五连击（第 14 篇）置 OTA 标志 → 长鸣 2 秒（第 15 篇，**鸣完再复位**）→ Bootloader 主导升级；云端推送升级时走同一条标志路径；
3. **传输协议**：真实涂鸦 OTA 协议——云端分包推送，Bootloader 逐包接收、校验、按偏移写入，Uart/帧缓冲区为此加大到 512 B；
4. **防砖**：OK 标志最后写 + 栈指针合法性检查 + 升级失败留在升级模式，三板斧齐备；
5. **版本号纪律**（回收第 9 篇伏笔）：App 的 `MCU_VER` 和 Bootloader 的版本宏**必须一致**，发版时同步递增。两边不一致时，云端和 MCU 对版本的理解会错位，升级流程出灵异问题。

## 五、彩蛋：那个"只收一帧就死"的幽灵

产品的 OTA 联调现场：云端开始推包，第一帧完美——接收、应答、写入，一切顺利。第二帧开始，**永远失败**。

没有错误码，没有 HardFault，没有异常帧。Bootloader 的接收中断还在跳（日志证明），数据也进来了——就是写不进去。

排查链最终指向 2.4 埋下的那句话：Flash 控制器的解锁状态是**易失**的——完成一次编程操作后，硬件会**自动重新上锁**！第一帧写入时解锁成功；写完第一帧，锁悄悄回来了；第二帧的写操作就此全部静默丢弃。接收流程毫无感知，因为它只管收——写的人沉默地失败了。

修复是在每个写入事务前重新执行完整解锁序列。一行事的 bug，一天的排查——因为它的沉默。这个案子之后，团队 checklist 多了一条：**"写 Flash 前无条件解锁，把它当肌肉记忆，不要当条件判断。"**

第 10 篇说过"静默失败是嵌入式最贵的 bug 类型"，本篇是第二例证。两次之后你应该能总结出规律了：**凡是"硬件替你决定成败、软件无感知"的操作（Flash 写入、低功耗进入、时钟切换），都值得在代码旁加一行验证或日志**——贵，但比事后排查便宜两个数量级。

## 六、下篇预告

代码写完了，能跑、能睡、能升级。但"能跑"和"敢发货"之间还隔着一条产线。下一篇第 17 篇《产测与量产》：工厂里如何快速判断每台设备是好的（产测路由扫描、全显目检、14 项冒烟清单）、发版流程怎么走、以及那个"产测模式下每秒滴一声"的设计——最后一块拼图，收官篇的前奏。

---

*本系列基于真实量产项目改编，文中踩坑记录均出自真实开发过程。建议按顺序阅读，篇间有依赖。*
