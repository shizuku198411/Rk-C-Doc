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

The trap subsystem is the kernel's transition point for user ecalls, timer interrupts, and synchronous faults. It must preserve interrupted register state, harden supervisor execution state, classify the event, and either resume, reschedule, terminate a user process, or stop the kernel.

## Trap Vector and Stack Transition

Bootstrap installs the trap entry address in `stvec`. User execution stores the current process kernel stack top in `sscratch`. On entry, assembly examines the previous privilege encoded in `sstatus.SPP`:

| Origin | Stack Handling |
| --- | --- |
| U-mode | Exchange user `sp` with the kernel stack held in `sscratch` |
| S-mode | Keep the current supervisor stack and update `sscratch` |

The handler disables supervisor interrupts during frame construction and clears `sstatus.SUM` before any Nim kernel handler executes. The saved interrupted `sstatus` is restored before `sret`, so SUM is never unintentionally inherited as kernel handler state.

```text
interrupted U-mode                         kernel trap handler

 user sp ----+                         +--> classify scause
             |   csrrw sp,sscratch,sp |    syscall / timer / fault
 kernel sp <-+------------------------+    mutate saved frame as needed
                 save TrapFrame       |    maybe schedule
                 SUM forced off       |
                 kernel gp restored   +--> restore frame, sret
```

## Trap Frame Layout

Trap entry allocates 34 machine words, or 272 bytes, on the selected kernel stack. The meaningful saved fields are:

| Group | Fields |
| --- | --- |
| Return and globals | `ra`, `gp`, `tp` |
| Temporaries | `t0` through `t6` |
| Arguments | `a0` through `a7` |
| Callee-saved | `s0` through `s11` |
| Interrupted control state | original `sp`, `sepc`, `sstatus` |

The trap dispatcher receives a pointer to this saved frame. Syscall results are written back to `a0`; resuming execution restores all registers from the same frame.

## Recognized Trap Classes

| Event | `scause` Value | Kernel Behavior |
| --- | --- | --- |
| U-mode environment call | `0x08` | Dispatch syscall and advance `sepc` by 4 |
| S-mode environment call | `0x09` | Panic |
| Supervisor timer interrupt | interrupt bit plus `0x05` | Account tick, wake waits, request reschedule |
| Instruction page fault | `0x0c` | Kill user process or panic if from S-mode |
| Load page fault | `0x0d` | Kill user process or panic if from S-mode |
| Store/AMO page fault | `0x0f` | Kill user process or panic if from S-mode |
| Misaligned, access-fault, illegal, or breakpoint exceptions | `0x00` through `0x07` as defined by RISC-V | Kill user process or panic if privileged |

Trap counters are incremented per class and exposed through the trap observability path.

## Syscall ABI

Userspace enters the kernel with `ecall`. The ABI currently uses:

| Register | Meaning on Entry | Meaning on Return |
| --- | --- | --- |
| `a0` | First argument | Result or negative failure encoded in `U64` |
| `a1` | Second argument | Preserved only as ordinary register-frame state |
| `a2` | Third argument | Preserved only as ordinary register-frame state |
| `a3` | Syscall numeric identifier | Preserved only as ordinary register-frame state |

Syscall identifiers are shared between kernel and userspace. The defined range currently extends through:

| Number | Syscall | Role |
| --- | --- | --- |
| `1` | `write` | Compatibility stdout write path |
| `11` | `exec` | Start a child RKX application |
| `22` / `23` | `ipc_send` / `ipc_receive` | Text IPC |
| `47` - `49` | Packet IPC operations | Structured IPC transport |
| `57` - `63` | FD, pipe, and `dup2` operations | Stream I/O foundation |
| `64` | `service_ready` | Registry readiness mutation |
| `68` | `poll` | Wait for FD, IPC, PID, or timer events |
| `86` / `87` | `brk` / `sbrk` | Per-process heap management |

The dispatch layer is intentionally thin: it performs tracing, centralized capability gating, dispatch to a subsystem handler, and `last_error` handling. Implementations live in domain-specific kernel syscall modules.

```text
U-mode wrapper
  -> ecall with a3 = syscall number
  -> trap_entry constructs TrapFrame
  -> handleSyscall()
       -> trace enter
       -> capability policy gate
       -> subsystem handler
       -> update last_error
       -> trace exit
  -> sepc += 4
  -> deliver pending signals
  -> reschedule if requested
  -> sret
```

## Timer and Preemption Path

The timer device is programmed with an interval of `200000` time units. Every supervisor timer interrupt:

1. Increments global and current-process tick accounting.
2. Records idle ticks when the idle process is running.
3. Produces CPU usage snapshots every 100 timer ticks.
4. Wakes processes sleeping until an expired tick deadline.
5. Polls UART input and wakes input waiters when bytes arrive.
6. Programs the next timer deadline.
7. Sets the reschedule request flag.

If the interrupt arrived from U-mode, the return path immediately observes that request and may context-switch. Supervisor work is not involuntarily switched mid-handler; it reaches an explicit scheduling boundary.

## Fault Containment and Panic Logs

Fault handling differs by privilege boundary:

| Fault Origin | Result |
| --- | --- |
| U-mode process | Print a fault message, append one diagnostic line to `/var/log/user_panic.log`, mark the process zombie with status `255`, then schedule |
| Kernel or S-mode context | Print `PANIC` diagnostic and enter an infinite `wfi` loop |

The userspace panic log stores PID, executable path, `scause`, `stval`, `sepc`, `sp`, and argument registers `a0` through `a3`, capped to a 512-byte formatted line per fault event.

## Syscall Tracing

The kernel trace subsystem can trace all processes or a selected PID and can optionally preview byte buffers. It prints:

- PID and executable path.
- Syscall symbolic name and numeric identifier.
- Named syscall arguments for known calls.
- Return value.
- An escaped data preview for selected write operations in verbose mode, limited to 48 bytes.

The following actual execution result shows one `/bin/ls` child under syscall tracing. Output from the traced program is expected to appear between `write_fd` entry and return records because both trace logging and application stdout share the console.

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

Pointer formatting uses validated usercopy helpers, so a malformed pointer in a traced syscall is rendered as a bad pointer rather than being directly dereferenced by the tracing path.
