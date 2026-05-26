---
title: Process Table, Scheduler, and Lifecycle
section: kernel
status: Implemented
updated: 2026-05-24
order: 2
excerpt: Fixed process slots, scheduler decisions, wait states, signals, fork-like execution, and cleanup.
tags: process, scheduler, context-switch, lifecycle, signal
---

## Process Model

Rk-C uses a fixed-size process table with `MaxProcs = 32` slots. Each slot can contain either a kernel task or a user process, and the kernel keeps all scheduling, identity, memory, IPC, and file-descriptor state inside the `Process` object in `src/kernel/task/process.nim`.

| Process State Group | Stored State |
| --- | --- |
| Identity | PID, parent PID, UID, GID, executable path, current working directory |
| Scheduling | `ProcessState`, kernel context, kernel stack, wait target, CPU accounting |
| User execution | user page table, entry PC, stack and heap bounds, capability masks |
| Communication | per-process IPC queue, pending signal bits |
| Files | per-process FD table with flags, offsets, kinds, and pipe IDs |

Each process receives a dedicated kernel stack of `KernelStackPages = 4` pages (16 KiB). User-mode register state is not stored inside `Process.context`; it is preserved separately in the trap frame on the kernel stack when a user trap or syscall happens.

## Lifecycle States

The process state machine is represented by `ProcessState`:

| State | Meaning |
| --- | --- |
| `procUnused` | Slot is available for allocation |
| `procRunnable` | Eligible for scheduler selection |
| `procRunning` | Current CPU owner |
| `procSleeping` | Blocked on one typed wait condition |
| `procZombie` | Terminated; exit status retained until reaped |

A process transitions through these states when it is created, scheduled, blocked, signaled, exited, or reclaimed.

## Context Switching

The low-level context switch preserves only the kernel scheduling context held in `Context`:

- `ra`, `sp`
- `s0`..`s11`

This context is saved for kernel task scheduling in `src/kernel/task/internal/scheduler.nim`. User register state is kept in the trap frame built by the architecture trap entry path, which keeps user execution state separate from kernel scheduling state.

`currentProc` points to the currently selected `Process`. The kernel uses `arch.writeSscratch(next.kernelStack + KernelStackPages * PageSize)` to keep the next process's kernel stack top in `sscratch` before switching.

## Scheduler Selection

Scheduler selection is implemented by `schedule()` in `src/kernel/task/internal/scheduler.nim`.

The selection algorithm is:

1. Call `reapDetachedZombies()` to reclaim any detached zombie slots.
2. Start scanning from the slot immediately after the current process.
3. Select the first process with `state == procRunnable` that is not the idle process.
4. If none is found, consider the idle process if its state is `procRunnable` or `procRunning`.
5. If still none is found, keep the previous process running if it is still `procRunning` or `procRunnable`.
6. If no runnable process exists, panic.

This is a simple round-robin scheduler over the fixed process list.

### Root page table and address space switch

When a next process is selected, the scheduler chooses its page table:

- `next.rootPageTable` if set
- otherwise `kernelPageTable`

It writes the chosen root page table into `satp`, flushes the TLB, and updates `sscratch` to the next process's kernel stack top.

If the next process is different from the current process, `schedule()` performs a `contextSwitch(prev.context, next.context)`.

## Cooperative and Timer-Driven Yielding

The kernel combines explicit yielding with timer-driven preemption.

- `yieldCpu()` marks the current running process as `procRunnable` and calls `schedule()`.
- `requestResched()` sets the global `needResched` flag.
- `maybeYieldOnResched()` checks `needResched`; if true, it clears the flag and calls `yieldCpu()`.

The trap scheduler invokes `maybeYieldOnResched()` at the end of a user-mode trap return path, making timer interrupts an explicit preemption boundary.

## Typed Waiting

Sleeping processes use a single typed wait record `WaitTarget` with:

- `kind: WaitKind`
- `value: U64`

This avoids multiple independent wait flags.

Wait kinds include:

- `waitInput` — ready when console input arrives
- `waitIpc` — ready when an IPC reply arrives for this process
- `waitPid` — ready when a child process exits
- `waitFsReq` — ready when a filesystem request completes
- `waitBlockReq` — ready when a block request completes
- `waitTimer` — ready when a timeout tick is reached
- `waitPipeRead` — ready when pipe data becomes readable
- `waitPipeWrite` — ready when pipe space becomes writable
- `waitPoll` — ready when a poll deadline or event occurs

`sleepCurrentFor(kind, value)` sets the current process state to `procSleeping`, records the wait target, calls `schedule()`, and then runs `deliverCurrentSignals()` after the swap.

### Wake operations

Wake helpers scan the process table and transition matching sleepers back to `procRunnable`:

- `wakeWaiters(kind, value, wakeAll)` wakes matching sleepers by exact kind/value match
- `wakeInputWaiters()` wakes `waitInput` processes and poll waiters
- `wakeIpcWaiter(pid)` wakes the user process waiting for IPC from `pid`
- `wakeFsWaiter(reqId)` wakes filesystem waiters for a request ID
- `wakeBlockWaiter(reqId)` wakes block waiters for a request ID
- `wakePidWaiters(pid)` wakes parents waiting for a child PID
- `wakeTimerWaiters(tick)` wakes timer and poll waiters whose deadline has passed
- `wakePipeReaders(pipeId)` / `wakePipeWriters(pipeId)` wake pipe waiters
- `wakePollWaiters()` wakes poll waiters independently of the specific event

## Kernel and User Process Creation

Kernel tasks are created by `createKernelProcessInternal()` with root identity, `/` cwd, standard file descriptors, and an allocated kernel stack. The idle task is created at boot and becomes `idleProc`.

User processes are allocated through `allocUserProcessFromParent()`:

- allocates a kernel task slot using `createKernelProcessInternal(userProcessBootstrap, false, "user_proc")`
- marks `user.active = true`
- inheriting metadata from the parent if requested
- sets the initial state to `procSleeping`

`configureUserProcess()` then assigns:

- the user root page table
- executable path and argument metadata
- user text/data/rodata/bss mappings
- stack top and user stack pointer
- heap bounds and heap limit
- capability masks

It computes the user heap limit using a one-page guard between heap and stack.

### User process bootstrap

User processes start in `processBootstrap()`:

- the process entry function is `userProcessBootstrap`
- `processBootstrap()` invokes `currentProc.entry()`
- when that entry returns, the process is marked `procZombie`
- `schedule()` is called so the kernel can switch away from the dead process

`userProcessBootstrap()` enters user mode via `arch.enterUser()` with the configured user PC, stack, and arguments.

## Descriptor Inheritance and Pipes

When a user process is created from a parent, `inheritProcessMetadata()` copies:

- parent identity and current working directory
- parent file descriptor entries

The child inherits pipe endpoint counts so shell pipelines and redirections work correctly.

Standard descriptors are initialized for each process:

| FD | Path | Kind | Access |
| --- | --- | --- | --- |
| `0` | `/dev/stdin` | standard input | read |
| `1` | `/dev/stdout` | standard output | write |
| `2` | `/dev/stderr` | standard error | write |

When an FD is closed, pipe endpoint counts are decremented and opposite endpoints are awakened if they were blocked.

## Exit, Signals, and Reaping

Process termination is handled by `markProcessZombie()` in `src/kernel/task/internal/wait_signals.nim`.

On exit, the kernel:

- detaches any live child processes
- records `exitStatus`
- clears the wait target
- clears file state and pending signals
- sets `state = procZombie`
- wakes any waiters on this PID
- sends `SysSignalChildExited` to the parent if one exists

Detached zombies are automatically reclaimed by `reapDetachedZombies()` during `schedule()`. A process is detached when its parent has gone away or when it has been explicitly orphaned.

`reapDetachedZombies()` calls `discardProcess()` to free:

- user address space pages and page tables
- the kernel stack
- file state, IPC queue, and kernel-side resources
- the process slot itself by resetting it to `procUnused`

`killCurrentUserProcess(status)` kills the current runnable user process from a kernel path by marking it zombie and calling `schedule()`.

## Signal Delivery

Signals are represented as bit flags in `pendingSignals`.

- `sendProcessSignal(pid, signal)` sets the bit and wakes the target process via `wakeProcessForSignal()`.
- `wakeProcessForSignal()` converts a sleeping process to `procRunnable` and requests rescheduling.
- `deliverCurrentSignals()` runs when a user process returns from a trap; it checks for `SysSignalTerminate` and `SysSignalInterrupt` and kills the current process with a status of `143` or `130`, respectively.

`takeProcessSignal()` selects the highest-priority pending signal for a process, returning `SysSignalTerminate`, `SysSignalInterrupt`, `SysSignalChildExited`, or `SysSignalServiceStopped`.

## Idle Task Behavior

The idle task is a special kernel process that runs when no normal user process is runnable. Its loop is:

1. `maybeYieldOnResched()`
2. enable supervisor interrupts by setting `SstatusSie`
3. `arch.wfi()`

This prevents busy-waiting when all user processes are sleeping and allows timer interrupts to wake scheduling decisions.

## Observability

Process metadata exposed by `ps` and service-backed observability includes:

- PID, PPID, UID, GID
- lifecycle state and execution mode
- CPU ticks and window CPU percentage
- memory page counts and address-space segment sizes
- stack and heap bounds
- capability masks and pending signals
- executable path and current working directory

This metadata is derived from the `Process` object rather than being a separate runtime table.
