---
title: System Architecture Overview
section: architecture
status: Implemented
updated: 2026-05-24
order: 1
excerpt: The execution model, privileged boundary, userspace servers, and major runtime paths of Rk-C.
tags: architecture, microkernel, riscv64, services, ipc
---

## Scope

Rk-C is a microkernel-style operating system for the QEMU RISC-V 64-bit `virt` platform. It is implemented in Nim, enters supervisor mode through OpenSBI, and runs system policy in userspace servers wherever the current hardware and syscall boundaries allow it.

This document is the entry point for developers extending the kernel or adding servers and applications. It describes the current implemented architecture, not a target-only design.

## Platform Profile

| Item | Current Choice |
| --- | --- |
| ISA and ABI | RISC-V 64-bit, `rv64gc`, `lp64` |
| Machine model | QEMU `virt`, 256 MiB RAM in the default run target |
| Firmware | OpenSBI generic `fw_jump.bin` |
| Kernel privilege level | Supervisor mode |
| User privilege level | User mode |
| Address translation | Sv39, 4 KiB pages |
| Kernel image base | `0x80200000` |
| Disk transport | VirtIO MMIO block device |
| Network transport | VirtIO MMIO network device |
| Executable format | RKX container generated from user ELF binaries |

## Architectural Boundary

The system is microkernel-style rather than a pure minimal microkernel. The kernel retains direct hardware mechanisms and protected state, while named userspace servers expose higher-level system services over IPC.

```text
 U-mode applications
 +---------+ +-------+ +--------+ +------+ +----------+
 | shell   | | curl  | | passwd | | svc  | | user app |
 +----+----+ +---+---+ +---+----+ +--+---+ +----+-----+
      |          |         |         |          |
      | syscalls / structured IPC request-reply |
      v          v         v         v          v
 U-mode system servers
 +----------+ +---------+ +--------+ +------+ +-------+ +-------+ +-------+
 | svcmgtd  | |procmgtd | | blockd | | fsd  | |userd  | |netd   | |procfsd|
 +-----+----+ +----+----+ +---+----+ +--+---+ +---+---+ +---+---+ +---+---+
       |           |          |         |         |         |         |
 ------+-----------+----------+---------+---------+---------+---------+------
 S-mode kernel boundary
 +--------------------------------------------------------------------------+
 | traps/syscalls | scheduler/processes | IPC queues | registry | usercopy |
 | page allocator | Sv39 mappings       | raw FS/blk/net device mechanisms |
 +------------------------------+-------------------------------------------+
                                |
                   QEMU virt MMIO and OpenSBI
```

## Kernel Responsibilities

The kernel currently owns mechanisms that require privilege, address-space authority, or protection from untrusted processes:

- S-mode trap entry, syscall dispatch, timer-driven scheduling, and user fault containment.
- Physical page allocation, per-process Sv39 page tables, executable mapping, user heap growth, and address-space reclamation.
- Process records, UID/GID state, working directory inheritance, file descriptor tables, pipes, wait states, and process IPC queues.
- User pointer validation and copy-in/copy-out across the U-mode boundary.
- Service registration and readiness state used to route service-backed work.
- Low-level VirtIO and kernel filesystem mechanisms needed behind server-facing interfaces.

## Userspace Responsibilities

Userspace is split into interactive programs and persistent service processes. Services are launched and supervised by `svcmgtd`.

| Server | Architecture Role | Boot Requirement |
| --- | --- | --- |
| `svcmgtd` | Registers, starts, monitors, and restarts services | Required, launched by kernel boot task |
| `procmgtd` | Process listing and process-control service path | Required |
| `blockd` | Block-service endpoint for storage operations | Required |
| `fsd` | Filesystem-service endpoint | Required |
| `userd` | Account, group, shadow, and authentication service | Required |
| `procfsd` | Dynamic `/proc` content provider | Optional |
| `netd` | Network protocol and socket-like service endpoint | Optional |

Optional services allow a degraded boot: shell login may become available without `/proc` or networking after the initial service wait timeout, as long as every required service is available.

## Major Runtime Paths

### Application Execution

Interactive commands are RKX images in `/bin`. A command launched from the shell receives a new process and a newly constructed user address space. The child inherits process metadata that must follow execution context, including UID, GID, current working directory, and file descriptors. This inheritance is what enables pipelines and output redirection to work for arbitrary applications.

```text
shell parses command
  -> create child process
  -> inherit identity / cwd / fd table
  -> load and validate RKX image
  -> map text, rodata, data, bss, stack
  -> enter U-mode at RKX entry point
```

### Service Request

Service clients do not trust user-provided identity metadata. When an IPC packet crosses into the kernel, the kernel stamps it with the actual sender PID, UID, GID, and granted capability mask before it reaches the server.

```text
client packet
  -> IPC send syscall
  -> kernel attaches sender credentials
  -> target process queue
  -> service validates operation and credentials
  -> reply packet
  -> client receives response
```

### Fault Handling

Kernel faults are fatal because they indicate a privileged implementation failure. User page faults and illegal memory actions terminate the current userspace process while keeping the kernel and remaining services alive.

## Related Architecture Documents

- `Kernel Boot and Initial Service Startup` describes the OpenSBI handoff, bootstrap order, and login readiness gate.
- `Address Spaces, Memory, and User Execution` documents fixed addresses, permissions, heaps, and RKX loading.
- `Service and IPC Architecture` describes service supervision, registry state, IPC provenance, and required/optional behavior.
