---
title: Trap and Syscall ABI
section: kernel
status: Implemented
updated: 2026-05-27
order: 2
excerpt: RISC-V trap entry, shared syscall numbers/types, user wrapper conventions, kernel dispatch, capability checks, and error semantics.
tags: trap, syscall, abi, riscv64
---

## Overview

Rk-C exposes kernel services through RISC-V `ecall` traps from user mode. The trap ABI is shared between userland wrappers and kernel dispatch, and it includes:

- a well-defined mechanism for entering supervisor mode from U-mode
- a shared syscall number space in `src/lib/syscall_ids.nim`
- shared syscall-facing types in `src/lib/syscall_types.nim`
- a kernel syscall dispatch path in `src/kernel/trap/syscall.nim`
- capability enforcement in `src/kernel/syscall/syscall_cap.nim`

## Trap Entry and Register Semantics

On trap entry, the kernel uses `sstatus.SPP` to identify the origin privilege:

- if `SPP == 0`, the trap came from U-mode
- if `SPP == 1`, the trap came from S-mode

`trap_entry` in `src/arch/riscv64/trap.S` handles the transition:

1. if the trap is from U-mode, swap `sp` with the kernel stack pointer stored in `sscratch`
2. if the trap is from S-mode, write the current `sp` into `sscratch`
3. clear the supervisor user memory access bit `SUM`
4. allocate `272` bytes for the trap frame on the selected kernel stack
5. save `ra`, `gp`, `tp`, `t0`..`t6`, `a0`..`a7`, `s0`..`s11`
6. save the interrupted `sscratch`, `sepc`, and original `sstatus`
7. set `sscratch` to the top of the saved trap frame and call `trap_handler`
8. restore `sepc`, `sstatus`, all registers, restore `sp`, and return with `sret`

This ensures kernel trap handlers never execute with supervisor memory access enabled for user pages.

## Shared Syscall Number Space

Syscall numbers are 64-bit constants and are shared by both user and kernel code. The current mapping in `src/lib/syscall_ids.nim` includes: 

- `1` — `SysWrite`
- `2` — `SysRead`
- `3` — `SysPs`
- `4` — `SysTicks`
- `5` — `SysExit`
- `6` — `SysLs`
- `7` — `SysTraps`
- `9` — `SysMkdir`
- `11` — `SysExec`
- `12` — `SysWait`
- `13` — `SysUnlink`
- `14` — `SysRmdir`
- `15` — `SysShutdown`
- `16` — `SysGetDateTime`
- `17` — `SysReadFile`
- `18` — `SysWriteFile`
- `19` — `SysGetCwd`
- `20` — `SysSetCwd`
- `21` — `SysGetBitMap`
- `22` / `23` — `SysIpcSend` / `SysIpcReceive`
- `24` — `SysKill`
- `25` .. `27` — filesystem service registration and request/reply
- `28` .. `33` — raw filesystem operations
- `34` .. `38` — block service operations
- `39` .. `41` — service manager/client registration
- `42` — `SysYield`
- `43` — `SysSleep`
- `44` — `SysGetPid`
- `45` — `SysServiceList`
- `46` .. `49` — IPC packet operations
- `50` .. `54` — raw network operations
- `55` — `SysTraceCtl`
- `56` — `SysEntropy`
- `57` .. `63` — file descriptor operations and `SysOpen`
- `64` — `SysServiceReady`
- `65` — `SysGetPpid`
- `66` — `SysCpuInfo`
- `67` — `SysKmsg`
- `68` — `SysPoll`
- `69` — `SysGetCap`
- `70` .. `74` — raw filesystem metadata and rename
- `75` — `SysFsInfo`
- `76` .. `78` — identity and user control
- `79` .. `82` — chmod/chown and raw variants
- `83` — `SysLastError`
- `84` — `SysExecAs`
- `85` — `SysFdList`
- `86` / `87` — `SysBrk` / `SysSbrk`
- `88` — `SysRawWriteRange`

The full numeric map is authoritative in `src/lib/syscall_ids.nim`.

## Shared Syscall Types

Shared syscall-facing structures and constants are defined in `src/lib/syscall_types.nim`.

Important shared types include:

- `SysProcessInfo` — process table entry returned by `SysPs`
- `SysDateTime` — date/time result returned by `SysGetDateTime`
- `SysTrapCount` — trap counters returned by `SysTraps`
- `SysBitmapInfo` — filesystem bitmap metadata returned by `SysGetBitMap`
- `SysFsInfoEntry` — filesystem information returned by `SysFsInfo`
- `SysCpuInfo` — CPU accounting information returned by `SysCpuInfo`

Important shared constants include:

- filesystem flags: `SysOpenRead`, `SysOpenWrite`, `SysOpenCreate`, `SysOpenTrunc`, `SysOpenAppend`
- seek types: `SysSeekSet`, `SysSeekCur`, `SysSeekEnd`
- fd kinds: `SysFdKindFile`, `SysFdKindStdout`, `SysFdKindConsole`, `SysFdKindPipe`
- poll events: `SysPollFdRead`, `SysPollFdWrite`, `SysPollIpcRead`, `SysPollPidExit`, `SysPollTimer`
- error codes: `SysErrOk`, `SysErrPerm`, `SysErrNoEnt`, `SysErrAccess`, `SysErrNotDir`, `SysErrIsDir`, `SysErrInval`, `SysErrCap`

The shared types are used to ensure user side and kernel side agree on data size, packing, and field ordering.

## User Wrapper Conventions

Userland wrappers are implemented in `src/user/lib/core/syscall.nim` and expose a friendly API for application code.

The low-level entry point is the assembly function `user_raw_syscall3` in `src/user/lib/runtime/syscall.S`:

```asm
.global user_raw_syscall3
user_raw_syscall3:
    mv t0, a3
    mv a3, a0
    mv a0, a1
    mv a1, a2
    mv a2, t0
    ecall
    ret
```

This entrypoint expects:

- `a0` = syscall number
- `a1` = arg0
- `a2` = arg1
- `a3` = arg2

As a result, the current user wrapper set can pass three explicit syscall arguments in addition to the syscall number. Calls requiring four or more logical arguments generally pack additional data into a single `U64` argument.

Example wrapper behavior:

- `sysWrite(buf, len)` calls `rawSyscall3(SysWrite, buf, len, 0)`
- `sysExec(path, arg, detached)` packs `detached` as `U64`
- `sysReadFd(fd, buf, len)` calls `rawSyscall3(SysReadFd, fd, buf, len)`

## Kernel Dispatch Path

The kernel receives traps in `src/kernel/trap/trap.nim`. For U-mode environment calls, `trap_handler`:

1. increments `trapCount.environmentCallFromUMode`
2. calls `handleSyscall(frame)`
3. advances `frame.sepc` by `4`
4. delivers pending signals via `deliverCurrentSignals()`
5. evaluates `maybeYieldOnResched()` to perform user rescheduling

`handleSyscall(frame)` in `src/kernel/trap/syscall.nim` does:

1. `traceSyscallEnter(frame)`
2. `canSyscallByNumber(frame.a3)` capability check
3. syscall dispatch via `case frame.a3`
4. `setLastError` / `clearLastError`
5. `traceSyscallExit(frame)`

Dispatch is performed by forwarding syscall IDs to subsystem handlers in:

- `src/kernel/syscall/task/process_ops.nim`
- `src/kernel/syscall/fs/file_ops.nim`
- `src/kernel/syscall/fs/fs_service_ops.nim`
- `src/kernel/syscall/ipc/ipc_ops.nim`
- `src/kernel/syscall/mm/memory_ops.nim`
- `src/kernel/syscall/net/net_ops.nim`
- `src/kernel/syscall/service/service_ops.nim`
- `src/kernel/syscall/system/system_ops.nim`

The kernel writes the syscall return value into `frame.a0`.

## Capability and Error Semantics

Syscall capability enforcement is centralized in `src/kernel/syscall/syscall_cap.nim`.

If `canSyscallByNumber(frame.a3)` returns false, the kernel:

- sets `last_error` to `SysErrCap`
- writes `-1` into `frame.a0`
- skips dispatch

After normal dispatch, the kernel updates process error state as follows:

- if `frame.a0` has the sign bit set and the syscall is not `SysLastError`, the kernel may preserve or set `SysErrInval`
- otherwise, successful returns clear the process `last_error`

`SysLastError` is a special syscall that returns the current process `last_error` rather than invoking ordinary dispatch.

## Error Return Layout

The user-facing syscall return convention is:

- successful results are returned in `a0`
- failure is returned as a negative `U64` value in `a0`
- the process `last_error` field records a machine-readable error code

This mirrors common Unix-style syscall semantics while keeping the kernel's userland ABI simple and stable.

## Source References

- `src/lib/syscall_ids.nim`
- `src/lib/syscall_types.nim`
- `src/user/lib/core/syscall.nim`
- `src/user/lib/runtime/syscall.S`
- `src/kernel/trap/trap.nim`
- `src/kernel/trap/syscall.nim`
- `src/kernel/syscall/syscall_cap.nim`
