---
title: Console, Timer, RTC, and VirtIO Runtime
section: kernel
status: Implemented
updated: 2026-05-24
order: 6
excerpt: Kernel-resident platform mechanisms behind console input, time, block service, and network service access.
tags: device, virtio, uart, timer, rtc, qemu
---

## Hardware Boundary

Although Rk-C exposes block and network policy through userspace servers, the kernel still owns the low-level QEMU device access path and the memory used for VirtIO queues. Raw device syscalls are restricted to the corresponding registered service.

## Fixed Device Addresses

| Device or Window | Base Address | Notes |
| --- | --- | --- |
| Goldfish RTC | `0x00101000` | Nanosecond time registers |
| PLIC mapped window | `0x0c000000` | Kernel maps 4 MiB for interrupt-controller access |
| UART0 | `0x10000000` | Console receive register and line-status register |
| VirtIO MMIO scan start | `0x10001000` | First candidate slot |
| VirtIO MMIO stride | `0x1000` | Consecutive device slot interval |
| VirtIO slots inspected | `8` | Maximum scan count |

The QEMU launch configuration places a VirtIO block device on slot 0 and a VirtIO network device on slot 1, while drivers still identify devices using the MMIO magic, version, device ID, and vendor ID.

## Console and Input Buffer

Output is issued through the SBI console character call and is mirrored into a 16 KiB kernel circular log for retrieval by diagnostic tools. Input is polled from UART0 and stored in a 128-byte ring buffer.

```text
UART0 RX ----> kernel input ring (128 bytes) ----> stdin readers
                                                      ^
timer interrupt polls input and wakes waiters --------+

kernel print ----> SBI console output
       |
       +---------> klog ring (16384 bytes)
```

Input waiters sleep when no character is available. Timer interrupts poll UART availability and wake sleepers when input enters the ring; the idle task can therefore remain in `wfi` rather than spin on keyboard input.

## Timer and RTC

| Component | Use |
| --- | --- |
| Supervisor timer compare | Scheduler tick source, programmed at `now + 200000` |
| CPU accounting window | Snapshot every `100` ticks |
| Goldfish RTC registers | Wall-clock seconds converted to calendar date/time |

The timer drives scheduling, sleeps, polls, CPU accounting, and console input wakeups. The RTC provides date/time data and is separate from scheduling tick accounting.

## Shared VirtIO MMIO Support

The shared VirtIO layer supports modern VirtIO MMIO devices with:

- Magic `0x74726976`.
- QEMU vendor ID `0x554d4551`.
- Version at least `2`.
- Feature negotiation including `VERSION_1`.
- Physical descriptor, available, and used rings stored in allocator pages.

Each virtual queue stores descriptors at the beginning of its allocated memory, the available ring after descriptor entries, and the used ring aligned at 4096 bytes.

## VirtIO Block Mechanism

| Property | Value |
| --- | --- |
| Logical block size | `512` bytes |
| Maximum addressed blocks in driver policy | `32768` |
| Queue length | `8` descriptors |
| Queue memory | `8192` bytes aligned to `4096` |
| Request chain | Request header, data sector, one-byte status |
| Completion behavior | Poll used ring with timeout and one recovery retry |

The filesystem initialization path initializes the raw block mechanism before rootfs and appfs reads are possible. After `blockd` is available, service bridging provides the userspace boundary; low-level physical transactions continue to be performed by the kernel raw mechanism on behalf of authorized block service requests.

```text
filesystem mechanism
   |
   v
block service bridge <----> blockd
   |
   v
raw VirtIO block mechanism
   |
   v
virtqueue request chain -> QEMU block device
```

## VirtIO Network Mechanism

| Property | Value |
| --- | --- |
| Queue length | `32` descriptors for receive and transmit queues |
| Queue memory per queue | `8192` bytes aligned to `4096` |
| Receive / transmit buffer allocation | `32` physical pages each |
| Packet capacity exposed by syscall ABI | `1514` bytes |
| Internal descriptor buffer size | `2048` bytes |
| Negotiated options | MAC feature when present; merged receive buffers when present |

The network mechanism is initialized on demand through raw network operations used by registered `netd`. It extracts the MAC address from device configuration when the feature is offered and supports RX descriptor requeueing after packets are copied out of the virtqueue buffer.

### Actual Network Device Initialization Output

The following actual startup result shows initialization with a VirtIO-net device attached. MMIO placement follows the current machine arguments; MAC and configured addresses are runtime-visible device and configuration values.

```text
[svcmgtd] service started netd pid=9
[netd] virtio-net:
[netd]   mmio   = 0x10002000
[netd]   device = 1
[netd]   vendor = 0x554d4551
[netd]   mac    = 52:54:00:12:34:56
[netd] interface:
[netd]   address = 10.0.1.10
[netd]   subnet  = 255.255.255.0
[netd]   gateway = 10.0.1.1
[svcmgtd] service ready netd pid=9
```

## Driver Failure Policy

| Failure | Behavior |
| --- | --- |
| VirtIO block device missing or unusable during filesystem initialization | Kernel panic; boot cannot continue |
| Block I/O completion timeout | Attempt queue/device recovery once, then return failure |
| Network device unavailable | `netd` cannot become ready; optional-service degraded behavior applies |
| UART input absent | Readers sleep and timer/interrupt flow continues normally |

This distinction reflects current boot dependencies: storage is needed for executables and core services, while networking is optional for local system availability.
