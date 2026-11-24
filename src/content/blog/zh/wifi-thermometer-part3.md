---
title: 第 3 篇：手搓 I2C——用两根 GPIO 从传感器里"抠"出温湿度
description: I2C 时序逐位拆解：从开漏+上拉的电气规则，到用两个普通 GPIO 手工模拟总线，从 GXHT40 里读出温湿度——全系列第一篇"有难度"的文章。
pubDate: 2026-11-24
lang: zh
translationKey: wifi-thermometer-part3
tags: [嵌入式, STM32, 教程]
series: wifi-thermometer
seriesOrder: 3
---

> 上一篇单片机已经会说话了（UART）。本篇给它装上"感觉"：把 GXHT40 温湿度传感器接上，**用两个普通 GPIO 脚手工模拟 I2C 总线**，把温湿度读出来，打印到电脑上。
> 警告：本篇是全系列第一篇"有难度"的文章。I2C 时序环环相扣，任何一个 bit 的时序错了，总线就死给你看。但啃完它，你对"总线协议"的理解会超过大多数只用过硬件 I2C 的人。

---

## 一、本篇目标与效果

**目标**：面包板上接好 GXHT40，单片机每 2 秒读一次温湿度，串口输出：

```
temp=25.3C  hum=52.1%
temp=25.4C  hum=52.3%   ← 对着传感器哈一口气，数字蹭蹭涨
```

**做完你会懂**：I2C 总线的电气规则（为什么是开漏+上拉）、起始/停止/ACK 三种关键信号、一次完整读事务的时序拼图、以及 GPIO 模拟总线的完整手法。

## 二、原理 10 分钟

### 2.1 I2C 的电气基石：开漏 + 上拉

I2C 只有两根线：**SCL（时钟）** 和 **SDA（数据）**。它的电气规则和 UART 截然不同：

- 两根线各接一个**上拉电阻**到 3.3V；
- 每个器件（包括主控）都只能用**开漏（Open-Drain）输出**：要么输出低电平，要么"松手"（高阻态，让上拉电阻把线拉成高电平）。

这个设计带来一个绝妙的性质——**"线与"**：任何一个器件把线拉低，整条线就是低；所有人都松手，线才是高。这意味着：

1. 多个器件共享一条线不会短路（不存在两个输出"一个推高一个拉低"对打的局面）；
2. 从机甚至可以把 SCL 拉住不放（时钟延展），逼主机等它——这是硬件 I2C 的高级特性，本系列用不到，但要知道存在。

**GPIO 模拟的关键技巧就藏在这里**：把引脚配成开漏输出后，写 0 = 主动拉低，写 1 = 松手交给上拉电阻。想读总线电平时，先写 1 松手，再读引脚输入寄存器。整个模拟过程**不需要切换引脚方向**，一个"开漏输出"模式打天下。

### 2.2 三种信号：起始、停止、ACK

I2C 时序看着复杂，其实只有三种"特殊动作"，其余全是逐位传输。记这张图（SCL 为高时 SDA 的跳变方向是灵魂）：

```
起始(START)：          停止(STOP)：
  SDA ──┐                 ┌── SDA
        │╲                │ ╱
        │ ╲  SCL高时      │╱  SCL高时
  SCL ──┴──╱──            ───╱──┴── SCL
     下降沿                 上升沿

ACK（应答）：主机发完 8bit 后，第 9 个时钟
  SCL ──┐ ╔═╗ ╔═╗ ╔═╗ ╔═╗ ╔═╗ ╔═╗ ╔═╗ ╔═╗ ╔═╗
        └═╩═╩═╩═╩═╩═╩═╩═╩═╩═╩═╩═╩═╩═╩═╩═╩═╩═┘
  SDA  ──b7──b6──b5──b4──b3──b2──b1──b0──ACK
                                            ↑
                                     从机拉低=收到(ACK)
                                     从机松手=没收到(NACK)
```

- **START**：SCL 为高时，SDA 从高→低；
- **STOP**：SCL 为高时，SDA 从低→高；
- **ACK/NACK**：每传 8 位，第 9 个时钟由接收方控制 SDA——拉低是应答（ACK），松手是拒绝（NACK）。主机读数据时，最后一个字节要回 NACK 告诉从机"读够了"。

**逐位传输的规矩**：SCL 低电平时 SDA 允许变化；SCL 高电平时 SDA 必须稳定（对方就在这个高电平窗口里采样）。所以代码骨架永远是：

```
置位/清零 SDA → 拉高 SCL（对方采样）→ 拉低 SCL → 下一个 bit
```

### 2.3 一次完整的读事务

I2C 地址是 7 位，后面紧跟 1 位读写标志：0=写，1=读。GXHT40 的地址是 `0x44`（部分批次是 `0x45`，买不到读通的时候先怀疑它）。

读一次温湿度的完整流程：

```
START
发 [0x44<<1 | 0] = 0x88      ← 地址+写
等 ACK
发 0xFD                       ← "开始测量"命令
等 ACK
STOP? 不！直接发 START（重复起始）
发 [0x44<<1 | 1] = 0x89      ← 地址+读
等 ACK
读 字节1（温度高8位）→ 回 ACK
读 字节2（温度低8位）→ 回 ACK
读 字节3（温度CRC）  → 回 ACK
读 字节4（湿度高8位）→ 回 ACK
读 字节5（湿度低8位）→ 回 ACK
读 字节6（湿度CRC）  → 回 NACK ← 最后一个字节！
STOP
```

测量命令发出后，传感器内部要换算约 **10 ms** 才出数，所以"发命令"和"读数据"之间要留 10 ms 延时。原始值换算公式（ datasheet 给定）：

```
温度 = -45 + 175 × (t_raw / 65535)   单位 ℃
湿度 =  -6 + 125 × (h_raw / 65535)   单位 %RH
```

每个数据后面还跟 1 字节 CRC-8 校验（多项式 0x31，初值 0xFF）。学习阶段可以先不校验，但产品里必须验——总线受干扰读出的野数据，CRC 是最后一道防线（第 17 篇产测会看到它的价值）。

## 三、动手写代码

### 第一步：接线

```
GXHT40 模块        蓝色药丸
  VCC   ────►  3.3V
  GND   ────►  GND
  SCL   ────►  PB6
  SDA   ────►  PB7
```

模块上一般自带 4.7K~10K 上拉电阻。如果你买的是裸传感器（4 个引脚的小黑块），自己加两个 4.7K 电阻上拉到 3.3V，缺一不可。

### 第二步：GPIO 模拟 I2C 核心代码

```c
#include "stm32f103xb.h"

#define I2C_SCL_H   GPIOB->BSRR = GPIO_BSRR_BS6     // 写1=松手（开漏）
#define I2C_SCL_L   GPIOB->BSRR = GPIO_BSRR_BR6     // 写0=拉低
#define I2C_SDA_H   GPIOB->BSRR = GPIO_BSRR_BS7
#define I2C_SDA_L   GPIOB->BSRR = GPIO_BSRR_BR7
#define I2C_SDA_IN  ((GPIOB->IDR >> 7) & 1)         // 读 SDA 电平

static void i2c_init(void)
{
    RCC->APB2ENR |= RCC_APB2ENR_IOPBEN;
    // PB6/PB7 开漏输出 2MHz：CNF=01, MODE=10 → 0x6
    GPIOB->CRL &= ~((0xF << 24) | (0xF << 28));
    GPIOB->CRL |=  ((0x6 << 24) | (0x6 << 28));
    I2C_SCL_H; I2C_SDA_H;                        // 初始都松手，总线空闲为高
}

static void i2c_delay(void)                      // 半周期 5us → 100kHz
{                                                // （8MHz 主频下 SysTick 数 40 拍）
    SysTick->LOAD = 40 - 1; SysTick->VAL = 0;
    SysTick->CTRL = 5;
    while ((SysTick->CTRL & SysTick_CTRL_COUNTFLAG_Msk) == 0) { }
    SysTick->CTRL = 0;
}

static void i2c_start(void)
{
    I2C_SDA_H; I2C_SCL_H; i2c_delay();
    I2C_SDA_L; i2c_delay();                      // SCL高时 SDA 下降沿
    I2C_SCL_L; i2c_delay();
}

static void i2c_stop(void)
{
    I2C_SDA_L; i2c_delay();
    I2C_SCL_H; i2c_delay();                      // 先拉高 SCL
    I2C_SDA_H; i2c_delay();                      // 再释放 SDA → STOP
}

/* 发 1 字节，返回 0=收到ACK, 1=收到NACK */
static int i2c_write_byte(uint8_t data)
{
    for (int i = 7; i >= 0; i--) {               // MSB 先行
        if (data & (1 << i)) I2C_SDA_H; else I2C_SDA_L;
        i2c_delay();
        I2C_SCL_H; i2c_delay();                  // 高电平窗口对方采样
        I2C_SCL_L; i2c_delay();
    }
    I2C_SDA_H;                                   // 释放 SDA，交出第 9 拍控制权
    i2c_delay();
    I2C_SCL_H; i2c_delay();
    int nack = I2C_SDA_IN;                       // 采样 ACK
    I2C_SCL_L; i2c_delay();
    return nack;
}

/* 读 1 字节，ack=1 回ACK(还要读), ack=0 回NACK(读完了) */
static uint8_t i2c_read_byte(int ack)
{
    uint8_t data = 0;
    I2C_SDA_H;                                   // 松手，让从机驱动 SDA
    for (int i = 7; i >= 0; i--) {
        i2c_delay();
        I2C_SCL_H; i2c_delay();
        data |= (uint8_t)(I2C_SDA_IN << i);      // 高电平窗口采样
        I2C_SCL_L;
    }
    if (ack) I2C_SDA_L; else I2C_SDA_H;          // 第 9 拍：我们当接收方，回 ACK/NACK
    i2c_delay();
    I2C_SCL_H; i2c_delay();
    I2C_SCL_L; i2c_delay();
    I2C_SDA_H;
    return data;
}
```

### 第三步：读 GXHT40

```c
#define GXHT40_ADDR   0x44
#define CMD_MEASURE   0xFD

static int gxht40_read(int16_t *temp_x10, int16_t *hum_x10)
{
    uint8_t t_msb, t_lsb, h_msb, h_lsb;

    i2c_start();
    if (i2c_write_byte((GXHT40_ADDR << 1) | 0)) goto fail;   // 地址+写
    if (i2c_write_byte(CMD_MEASURE))             goto fail;   // 测量命令
    i2c_stop();

    delay_ms(10);                                // 等传感器换算

    i2c_start();
    if (i2c_write_byte((GXHT40_ADDR << 1) | 1))  goto fail;   // 地址+读
    t_msb = i2c_read_byte(1);                    // 温度高8位，ACK
    t_lsb = i2c_read_byte(1);                    // 温度低8位，ACK
    (void)i2c_read_byte(1);                      // 温度CRC，先不校验
    h_msb = i2c_read_byte(1);                    // 湿度高8位，ACK
    h_lsb = i2c_read_byte(1);                    // 湿度低8位，ACK
    (void)i2c_read_byte(0);                      // 湿度CRC，NACK 收尾
    i2c_stop();

    uint32_t t_raw = ((uint32_t)t_msb << 8) | t_lsb;
    uint32_t h_raw = ((uint32_t)h_msb << 8) | h_lsb;
    *temp_x10 = (int16_t)(((-45 + 175.0 * t_raw / 65535) + 0.05) * 10);
    *hum_x10  = (int16_t)(((- 6 + 125.0 * h_raw / 65535) + 0.05) * 10);
    return 0;
fail:
    i2c_stop();
    return -1;
}
```

主循环每 2 秒调一次，用第 2 篇的 `uart_puts` 配合简易整数转字符串打印（`*_x10` 是"放大 10 倍的整数"，25.3℃ 存成 253——避免浮点，这也是产品代码的习惯）。

## 四、烧录、验收与开挂时刻

- [ ] 上电后串口每 2 秒输出一行温湿度，数值合理（室温量级）；
- [ ] 对着传感器哈一口气，2 秒内湿度飙升到 70%+——传感器活了；
- [ ] **开挂时刻**：把逻辑分析仪的 CH0 接 SCL、CH1 接 SDA，采样率 1MHz，PulseView 里把解码器设为 I2C。你会在屏幕上看到清清楚楚的波形：START、地址字节 `0x88`、ACK 凹槽、`0xFD`、重复 START、`0x89`、6 个数据字节、最后的 NACK 和 STOP。**软件代码和硬件波形第一次在你眼前对应起来**，这个瞬间值回逻辑分析仪的二十五块钱；
- [ ] （排障演练）把 SDA 杜邦线拔掉再插回去，大概率收到的是 `gxht40_read` 返回失败——注意看 ACK 检测是怎么救你一命的。

**不出数排障三板斧**（按顺序）：万用表量 SDA/SCL 空闲时是否都被上拉到 3.3V → 逻辑分析仪看有没有 START 波形 → 看地址字节的 ACK 位是不是低（NACK 就是地址错了，怀疑 0x45 变体）。

## 五、原版对照（CIU32F003）

产品的处境比学习版更硬核：**CIU32F003 的 I2C 硬件只支持从机模式**，想当主机读传感器，模拟 I2C 不是"为了学习"，是唯一出路。产品里有两路独立模拟 I2C：传感器走 PB3/PB4，LCD 走 PA1/PA0，主从地址、速率（100 kHz）、超时宏全部集中在板级配置头文件里。

另一个差异：产品的模拟实现走的是"**SDA 方向切换**"路线（发送时推挽输出，接收/释放时切输入），而不是本篇的开漏输出路线。两条路线都合法：开漏路线代码简单，方向切换路线在某些管脚驱动能力弱的芯片上更稳妥。但方向切换有一个致命的时序窗口——留到彩蛋讲。

## 六、彩蛋：一根被拉死的 SDA

产品联调时出过一次"总线猝死"：上电后第一次读传感器正常，某个时刻之后，**所有 I2C 操作全部超时失败**，复位软件无效，只能断电重启。

用万用表一量，SDA 被死死钳在低电平。谁拉的？顺藤摸瓜：是传感器。为什么会这样？看时序——主机读完最后一个字节、刚发完 NACK 的时候，**传感器还沉浸在"我要在下一个时钟把数据位放出来"的状态里**，正把 SDA 往低电平驱动。如果这时主机的软件已经抢先把 SDA 切回了推挽输出、并且急着输出高电平……主机输出高、从机输出低，直接对打。STM32 类的 IO 推挽驱动能力通常赢过传感器，看起来没事；但 CIU32F003 的 IO 驱动偏弱，这一下没打赢，时序就此错乱，传感器以为事务没结束，一直攥着 SDA 不放——总线锁死。

修复是把 SDA 切回输出方向的时刻严格卡在 STOP 条件完整发出之后，并且在总线初始化时加了一段"SDA 被钳低则手动打 9 个时钟脉冲帮从机退出发送状态"的解锁序列（I2C 协议的标准急救手法，值得抄进你的工具箱）。

教训两条：

1. **多主机共享一根线时，"什么时候松手、什么时候接管"是时序设计的核心**，差半个时钟就是事故；
2. 总线锁死不要只会断电——"打 9 个时钟 + 发 STOP"的软件解锁，是 I2C 从业者的保命技。

## 七、下篇预告

温湿度读出来了，但一个电池产品还必须知道自己还剩多少电、外接探头的温度是多少——这两个都是"模拟电压"问题。下一篇第 4 篇《ADC：测电池、测 NTC 温度》：模数转换原理、电阻分压、以及一段会出现在所有 NTC 代码里的查表插值算法。搞完它，这个产品的全部"感知能力"就齐了。

---

*本系列基于真实量产项目改编，文中踩坑记录均出自真实开发过程。建议按顺序阅读，篇间有依赖。*
