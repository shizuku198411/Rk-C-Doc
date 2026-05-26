---
title: Trap Entry and Syscall Runtime
section: kernel
status: Implemented
updated: 2026-05-24
order: 1
excerpt: S-mode trap-frame construction, syscall dispatch, timer interrupts, faults, and syscall tracing.
tags: trap, syscall, riscv64, timer, strace
---

## Responsibility

The trap subsystem is the kernel's transition point for user `ecall`s, timer interrupts, and synchronous faults. It preserves interrupted register state, hardens supervisor handler state, classifies the event, and either resumes user execution, requests rescheduling, terminates a process, or halts the kernel.

## Bootstrapping Trap Entry

At boot, `src/kernel/init/bootstrap.nim` writes the trap entry address into `stvec` using `arch.writeStvec(cast[U64](arch.trapEntry))`. The scheduler initializes each user process by storing the process's kernel stack top in `sscratch`:

- On a trap from U-mode, `trap_entry` exchanges the current `sp` with the kernel stack top stored in `sscratch`.
- On a trap from S-mode, `trap_entry` keeps the current supervisor stack and updates `sscratch` with that value.

The privilege origin is detected from `sstatus.SPP`.

### `trap_entry` runtime sequence

1. Read `sstatus`, mask `SPP`, branch on previous mode.
2. If previous mode is U-mode, swap `sp` and `sscratch`.
3. If previous mode is S-mode, store the current `sp` into `sscratch`.
4. Clear the SUM bit in `sstatus` before running kernel code.
5. Allocate `8 * 34` bytes on the kernel stack.
6. Save `ra`, `gp`, `tp`, `t0`-`t6`, `a0`-`a7`, and `s0`-`s11`.
7. Save the interrupted user `sscratch`, `sepc`, and original `sstatus`.
8. Set `sscratch` to point at the saved trap frame top.
9. Initialize the kernel global pointer and call `trap_handler`.
10. Restore `sepc`, `sstatus`, all registers, swap back `sp`, and execute `sret`.

By clearing `SUM` inside the trap entry and restoring the original `sstatus` only at the end, the kernel ensures supervisor handlers never inherit user-accessible memory permissions.

## Trap Frame Layout

The trap frame is a 34-word object (`272` bytes) stored on the kernel stack. `src/kernel/trap/trap_types.nim` defines it explicitly.

| Group | Fields |
| --- | --- |
| Return and globals | `ra`, `gp`, `tp` |
| Temporaries | `t0` through `t6` |
| Arguments | `a0` through `a7` |
| Callee-saved | `s0` through `s11` |
| Interrupted control state | original `sp`, `sepc`, `sstatus` |
| Reserved | `reserved0` (alignment / future use) |

The saved `sp` is the interrupted user stack pointer; the current kernel `sp` is the frame pointer into the saved trap frame. The kernel handler receives `a0` as a pointer to this frame, and all fields are restored before `sret`.

## Trap Dispatch and Runtime

`trap_handler` in `src/kernel/trap/trap.nim` is the central dispatch point. It reads `scause`, `stval`, and the interrupted program counter from the saved frame, then dispatches by trap class.

The helper `trapFromUser(frame)` returns true when `(frame.sstatus and SstatusSpp) == 0`, i.e. the interrupt came from U-mode.

### Recognized trap classes

| Event | Constant | Kernel Behavior |
| --- | --- | --- |
| U-mode environment call | `ScauseEnvironmentCallFromUMode` | `handleSyscall(frame)`; `frame.sepc += 4`; deliver signals; maybe yield |
| S-mode environment call | `ScauseEnvironmentCallFromSMode` | `panicMsg("Environment Call from S-Mode", ...)` |
| Supervisor timer interrupt | `ScauseSupervisorTimer` | tick accounting, wake waits, schedule request, optional user reschedule |
| Instruction/Load/Store page fault | `ScauseInstructionPageFault`, `ScauseLoadPageFault`, `ScauseStoreAMOPageFault` | `faultOrPanic(...)` |
| Misaligned/access/illegal/breakpoint | `ScauseInstructionAddressMisaligned`, `ScauseLoadAccessFault`, `ScauseStoreAMOAccessFault`, `ScauseIllegalInstruction`, `ScauseBreakpoint` | `faultOrPanic(...)` |

Each class increments a per-trap counter before handling. `trap_handler` treats user-mode faults as process termination events and supervisor-mode faults as kernel panics.

## Syscall ABI and Dispatcher

Userspace issues syscalls via `ecall` with the syscall number in `a3`. The kernel saves all argument registers in the trap frame, so the runtime preserves the full register state across the trap.

| Register | Entry role | Return semantics |
| --- | --- | --- |
| `a0` | arg0 / pointer | result or encoded negative error |
| `a1` | arg1 / pointer | preserved in saved frame |
| `a2` | arg2 / pointer | preserved in saved frame |
| `a3` | syscall number | preserved in saved frame |
| `a4` .. `a7` | additional args | preserved in saved frame |

`handleSyscall(frame)` performs:

1. `traceSyscallEnter(frame)`
2. `canSyscallByNumber(frame.a3)` capability check
3. `case frame.a3` dispatch to subsystem handler
4. `setLastError` / `clearLastError` update
5. `traceSyscallExit(frame)`

If `canSyscallByNumber` rejects the syscall, the runtime sets `last_error` to `SysErrCap` and returns `-1` in `a0`.

### Dispatch categories

The syscall dispatcher in `src/kernel/trap/syscall.nim` forwards calls to handlers in:

- `src/kernel/syscall/task/process_ops.nim`
- `src/kernel/syscall/fs/file_ops.nim`
- `src/kernel/syscall/fs/fs_service_ops.nim`
- `src/kernel/syscall/ipc/ipc_ops.nim`
- `src/kernel/syscall/mm/memory_ops.nim`
- `src/kernel/syscall/net/net_ops.nim`
- `src/kernel/syscall/service/service_ops.nim`
- `src/kernel/syscall/system/system_ops.nim`

The implementation covers ordinary user syscalls such as `SysRead`, `SysWrite`, `SysOpen`, `SysClose`, `SysPoll`, `SysExec`, `SysWait`, and `SysKill`, plus raw and service operations, process controls, trace control, entropy, and error reporting.

### `last_error` handling

After syscall dispatch, if the return value in `a0` has the sign bit set and the syscall is not `SysLastError`, the kernel may propagate `SysErrInval` when no other error was recorded. Otherwise, successful return values clear the process `last_error`.

## Timer and Preemption Path

Supervisor timer interrupts are the kernel's soft preemption point. `trap_handler` calls:

- `countUpTimerTick()`
- `countCurrentProcessCpuTick()`
- `countUpIdleTick()` when the idle process is running
- `snapshotProcessCpuWindow()` and `snapshotCpuWindow()` when a CPU-window boundary is reached
- `wakeTimerWaiters(timerTickCount)`
- `pollInput()` and `wakeInputWaiters()` for UART-driven events
- `setNextTimer()` to program the next tick deadline
- `requestResched()` to request a context switch

For interrupts delivered from U-mode, the handler also runs `deliverCurrentSignals()` and `maybeYieldOnResched()` before returning. The kernel does not forcibly preempt supervisor-mode work mid-handler.

## Fault Containment and Panic Logs

`faultOrPanic(...)` differentiates user and kernel faults:

- User-mode page faults and bad traps write a diagnostic entry to `/var/log/user_panic.log` and kill the faulting process with exit code `255`.
- Kernel-mode or S-mode faults invoke `panicMsg(...)`, emit a panic banner, and spin in `arch.wfi()`.

The panic log is constructed in `writeUserPanicLog` and includes:

- `pid`
- `exe`
- `scause`
- `stval`
- `sepc`
- `sp`
- `a0` .. `a3`

The line is capped at `512` bytes.

## Syscall Tracing

The trace subsystem in `src/kernel/trap/syscall_trace.nim` provides:

- global trace enable/disable
- per-PID filtering via `syscallTracePid`
- verbose buffer preview via `syscallTraceVerbose`

`traceSyscallEnter` prints the syscall name and named arguments for known syscall IDs. Arguments that refer to user memory are validated through `copyUserCString` or `copyFromUser`; invalid user pointers render as `<badptr>` instead of causing kernel memory faults.

`traceSyscallExit` prints the syscall return value after execution.

### Example trace output

```text
root@Rk-C:/$ stracectl -v ls /etc
[strace] -> pid=23 exe=/bin/ls sys=ls#6(path="/etc")
[strace] <- pid=23 sys=ls#6 ret=0x8
[strace] -> pid=23 exe=/bin/ls sys=write_fd#59(fd=1, buf=0x12ffd32, len=10, preview="os-release")
os-release[strace] <- pid=23 sys=write_fd#59 ret=0xa
[strace] -> pid=23 exe=/bin/ls sys=write_fd#59(fd=1, buf=0x12ffd56, len=6, preview="passwd")
passwd[strace] <- pid=23 sys=write_fd#59 ret=0x6
[strace] -> pid=23 exe=/bin/ls sys=write_fd#59(fd=1, buf=0x12ffd7a, len=6, preview="shadow")
shadow[strace] <- pid=23 sys=write_fd#59 ret=0x6
...
[strace] -> pid=23 exe=/bin/ls sys=exit#5(status=0)
root@Rk-C:/$
```

This trace log shows kernel trace output interleaved with process stdout, because both share the console device.
