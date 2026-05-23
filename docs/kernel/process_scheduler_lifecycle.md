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

Rk-C maintains a fixed process table with 32 slots. Each slot represents either a kernel task or a U-mode process and contains scheduling, identity, memory, IPC, and file-descriptor state.

| Process Field Group | Stored State |
| --- | --- |
| Identity | PID, parent PID, UID, GID, executable path, current working directory |
| Scheduling | Lifecycle state, saved context, kernel stack, wait target, CPU tick counters |
| User execution | Page table, image layout, stack, heap bounds, requested and granted capabilities |
| Communication | Per-process structured IPC queue and pending signal mask |
| Files | Per-process FD table with file offsets, device kinds, and pipe handles |

Every process receives a kernel stack of four pages, or 16 KiB.

## Lifecycle States

```text
                 exec / create
 unused  ----------------------------> runnable
                                          |
                                          | selected
                                          v
                                      running
                                      /  |   \
                    wait/sleep/IPC  /   |    \ exit/fault/signal
                                    v    |     v
                                sleeping |   zombie
                                    |    |     |
                              wake  +----+     | wait or detached reap
                                               v
                                             unused
```

| State | Meaning |
| --- | --- |
| `unused` | Slot contains no live process and may be allocated |
| `runnable` | Ready for scheduler selection |
| `running` | Current CPU owner |
| `sleeping` | Blocked on a typed wait target |
| `zombie` | Execution stopped; exit status retained until reaped |

## Context Switching

The software scheduler uses cooperative boundaries plus timer-triggered preemption from U-mode. The low-level context switch preserves only the callee-saved kernel scheduling context:

| Saved Context | Registers |
| --- | --- |
| Control | `ra`, `sp` |
| Callee-saved | `s0` through `s11` |

Full user register state during an interrupt or syscall belongs to the trap frame on that process kernel stack. This separates ordinary kernel task scheduling context from interrupted user execution state.

## Scheduler Selection

Scheduling is round-robin over the fixed table:

1. Reap any detached zombies.
2. Begin scanning immediately after the current process slot.
3. Choose the first runnable non-idle process.
4. Choose the idle task only when no other runnable process exists.
5. Select that process root page table or the kernel root table.
6. Write `satp`, flush the TLB, and update `sscratch` to its kernel stack top.
7. Switch saved kernel contexts unless the same process remains selected.

```text
current slot i
   |
   v
scan i+1, i+2, ... wrapping once
   |
   +-- runnable normal process found --> switch to it
   |
   +-- none found and idle runnable ---> switch to idle
   |
   +-- no available execution path ----> panic
```

The idle task enables supervisor interrupts and executes `wfi`, preventing a busy loop when every user process or service is sleeping.

## Typed Waiting

A sleeping process stores one wait kind plus one numeric target value. This avoids a growing set of independent `waitingFor...` flags.

| Wait Kind | Target Value |
| --- | --- |
| Console input | Sentinel value |
| IPC receive | Sentinel value |
| Child PID | Target PID |
| Filesystem response | Request ID |
| Block response | Request ID |
| Timer sleep | Wake tick |
| Pipe read / write | Pipe ID |
| Poll | Deadline tick |

Wake operations scan sleeping slots, compare kind and target, clear the wait record, and return matching processes to runnable state.

## Process Creation and Execution

Kernel tasks are created with root identity, `/` as current working directory, standard descriptors, and an allocated kernel stack.

Userspace command execution follows a fork-like metadata model without copying the previous user image:

```text
parent process
   |
   | allocate child process slot and kernel stack
   | construct fresh user page table
   | load requested RKX image into child address space
   | copy execution metadata from parent
   v
child: new binary + inherited uid/gid/cwd/fds
```

The inherited FD table retains pipe endpoint references, which is required for shell pipelines and redirect setup. Identity can be explicitly replaced only through the root-authorized execution path used by login to launch a shell for an authenticated user.

## Standard Descriptors and Inheritance

Initial process descriptor assignments are:

| FD | Path | Kind | Access |
| --- | --- | --- | --- |
| `0` | `/dev/stdin` | Standard input device | Read |
| `1` | `/dev/stdout` | Standard output device | Write |
| `2` | `/dev/stderr` | Standard error device | Write |

When a child is created from a parent, descriptors are copied and pipe endpoint reader/writer counts are retained. When a process exits or an FD is closed, pipe endpoints are released and blocked opposite endpoints can be awakened.

## Exit, Signals, and Reaping

Termination converts a process into a zombie, clears wait state, closes its FD table, removes pending signals, and records an exit status. Its memory remains owned until process discard at reap time.

| Event | Stored Exit Status |
| --- | --- |
| Normal `exit(status)` | Supplied status |
| Terminate signal | `143` |
| Interrupt signal | `130` |
| Contained user fault | `255` |

Upon transition to zombie:

- Live children are detached from the exiting parent.
- A parent waiting for that PID is awakened.
- A parent process receives a child-exited signal when one exists.
- Detached zombies are reclaimed automatically during future scheduling.
- A non-detached child is reclaimed when its parent waits and obtains status.

Reclamation releases user image, stack, heap, private page tables, the kernel stack, and process-owned descriptor state before returning the slot to `unused`.

## Runtime Observability

The following actual `ps` result shows the system after the required and optional servers reached ready state and an authenticated root shell was started. The `ps` process itself appears as a child of that shell.

```text
root@Rk-C:/$ ps -e -f -l
pid     ppid    uid     gid     state           mode    cpu     mem     exe
3       0       root    root    sleeping        user    0%      16p     /bin/svcmgtd
4       3       root    root    running         user    0%      11p     /bin/procmgtd
5       3       root    root    sleeping        user    0%      11p     /bin/blockd
6       3       root    root    sleeping        user    0%      16p     /bin/fsd
7       3       root    root    sleeping        user    0%      22p     /bin/userd
8       3       root    root    sleeping        user    0%      25p     /bin/procfsd
9       3       root    root    sleeping        user    0%      27p     /bin/netd
10      0       root    root    sleeping        user    0%      10p     /bin/login
11      10      root    root    sleeping        user    0%      19p     /bin/shell
14      11      root    root    sleeping        user    0%      13p     /bin/ps
root@Rk-C:/$
```

PIDs and page counts are observed values rather than stable ABI values; the important relation is the supervisor-parented server set and the `login -> shell -> command` session tree.

Process metadata exported to service-backed observability includes PID, PPID, UID, GID, lifecycle state, execution mode, CPU ticks and percentage, memory page counts, user segment locations, stack and heap information, capability masks, pending signals, and executable path.
