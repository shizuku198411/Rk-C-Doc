---
title: Kernel Boot and Initial Service Startup
section: architecture
status: Implemented
updated: 2026-05-24
order: 2
excerpt: From OpenSBI handoff and linker layout through the readiness gate that starts login.
tags: boot, opensbi, linker, riscv64, services, login
---

## Purpose

This document describes the cold-boot path of Rk-C on the QEMU `virt` machine, from firmware handoff to the first interactive login prompt. It is intended for developers changing linker placement, early initialization, or service startup ordering.

## Firmware and Image Handoff

The default QEMU launch uses OpenSBI generic `fw_jump.bin` as firmware and passes `kernel.elf` as the kernel image. OpenSBI transfers control into the kernel entry point in supervisor mode using the standard firmware handoff registers:

| Register | Value at Kernel Entry |
| --- | --- |
| `a0` | Hardware thread ID (`hartid`) |
| `a1` | Flattened Device Tree address |

Rk-C currently runs only hart 0. Any secondary hart is parked before it can touch the shared boot stack.

## Linker Placement

The kernel is linked at a fixed physical and virtual identity-mapped base of `0x80200000`. Early boot executes without requiring relocation.

| Region | Placement and Size Rule | Initial Permission after Sv39 |
| --- | --- | --- |
| Kernel `.text` | Starts at `0x80200000`, page-aligned section end | Read + execute |
| Kernel `.rodata` | Next 4 KiB aligned boundary | Read only |
| Kernel `.data` and `.bss` | Next 4 KiB aligned ranges | Read + write |
| Kernel stack | Immediately after aligned kernel end, 64 KiB | Read + write |
| Allocator reservation | Immediately after stack, 128 MiB | Read + write |

The allocator reservation is a `NOLOAD` linker region. Its first pages hold the physical allocation bitmap; all remaining pages become allocator-managed storage for page tables, process stacks, user segments, and heap pages.

```text
low address

0x80200000  +---------------------------+  __kernel_base
            | kernel text        r-x    |
page align  +---------------------------+
            | rodata             r--    |
page align  +---------------------------+
            | data + bss         rw-    |
page align  +---------------------------+  __kernel_end
            | kernel boot stack  rw-    |  64 KiB
            +---------------------------+  __free_ram_start
            | bitmap pages              |
            +---------------------------+  managedRegionStart
            | allocator-managed pages   |  remainder of 128 MiB
            +---------------------------+  __free_ram_end

high address
```

## Entry Sequence

The assembly entry performs only state that must exist before Nim code can safely execute:

1. Reject non-zero harts into an interrupt-disabled `wfi` loop.
2. Establish the global pointer using the linker-generated global data anchor.
3. Set `sp` to the top of the 64 KiB kernel stack.
4. Store that stack pointer in `sscratch` for trap entry usage.
5. Transfer control to `kernel_main(hartid, dtb)`.

`kernel_main` verifies hart 0 again, calls the bootstrap routine, and finally enters the scheduler. Returning from scheduling is considered a kernel panic.

## Bootstrap Initialization Order

Bootstrap intentionally separates operations that can run before translation from operations that require process state or interrupts.

```text
OpenSBI
   |
   v
boot entry: gp / sp / sscratch
   |
   v
kernel_main
   |
   +-- clear .bss
   +-- install S-mode trap vector
   +-- initialize physical page bitmap allocator
   +-- initialize process table and idle task
   +-- create kernel Sv39 table and enable address translation
   +-- initialize filesystems and packaged application access
   +-- program and enable timer interrupt
   +-- create boot_task
   |
   v
scheduler starts runtime tasks
```

The root Sv39 page table identity maps protected kernel regions and QEMU MMIO needed by privileged mechanisms. Every subsequent user process receives its own root page table with the same kernel mappings plus process-specific U-mode mappings.

## Boot Task and Readiness Gate

The initial kernel task does not start every server itself. It launches `/bin/svcmgtd`, then observes the kernel service registry while the service manager launches and registers managed servers.

```text
boot_task (kernel)
   |
   | exec /bin/svcmgtd
   v
svcmgtd registers itself as ready
   |
   +-- exec/register/wait procmgtd  [required]
   +-- exec/register/wait blockd    [required]
   +-- exec/register/wait fsd       [required]
   +-- exec/register/wait userd     [required]
   +-- exec/register/wait procfsd   [optional]
   +-- exec/register/wait netd      [optional]
   |
kernel observes registry availability
   |
   +-- all ready before deadline --------> exec /bin/login
   |
   +-- deadline with required ready -----> degraded boot; exec /bin/login
   |
   +-- deadline without required ready --> kernel panic
```

The kernel-side initial wait deadline is 250 timer ticks. Within `svcmgtd`, each managed service receives its own ready deadline of 200 ticks. The manager can restart failed required services and mark optional services degraded.

## Login and Shell Start

`/bin/login` is the first user-facing process created by the kernel boot path. It begins with root-owned initial process metadata and waits for authentication through `userd`. After authentication:

1. Login changes its current working directory to the selected user's home directory.
2. Login creates `/bin/shell` using the authenticated UID and GID.
3. Login waits for that shell to exit.
4. Login returns to its prompt and can start a new session.

This keeps shell session identity out of early bootstrap logic while making `userd` a required dependency of normal interactive startup.

## Actual Boot Output

Addresses, entry counts, PIDs, and service-ready ticks may change as the image is rebuilt.

```text
[boot] initial setup:
[boot]   clear bss OK
[boot]   set trap vector OK
[boot]   initialize memory allocator OK
[boot]   initialize process OK
[boot]   enable Sv39 OK
[boot] initialize file system:
[boot]   virtio-blk OK blocks = 32768
[boot]   formatting disk
[boot]   mounted /bin entries = 41
[boot]   mounted tmpfs on /tmp
[boot]   enable timer interrupt OK
...
[svcmgtd] service management server started pid=3
[svcmgtd] service started procmgtd pid=4
[svcmgtd] service ready procmgtd pid=4
[svcmgtd] service started blockd pid=5
[svcmgtd] service ready blockd pid=5
[svcmgtd] service started fsd pid=6
[svcmgtd] service ready fsd pid=6
[svcmgtd] service started userd pid=7
[svcmgtd] service ready userd pid=7
[svcmgtd] service started procfsd pid=8
[svcmgtd] service ready procfsd pid=8
[svcmgtd] service started netd pid=9
[svcmgtd] service ready netd pid=9

login: root
password:

root@Rk-C:/$
```

## Failure Surfaces

| Failure Point | Result |
| --- | --- |
| BSS clearing, allocator, page table, filesystem, or boot task creation fails | Kernel panic during bootstrap |
| Required service unavailable after initial deadline | Kernel panic; login is not started |
| Optional service unavailable after initial deadline | Degraded boot; login is allowed |
| Shell exits | Login remains alive and offers another authenticated session |
