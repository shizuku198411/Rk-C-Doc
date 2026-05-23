---
title: Capability Grant and Enforcement
section: kernel
status: Implemented
updated: 2026-05-24
order: 5
excerpt: Requested RKX capabilities, path-trusted grants, syscall gates, service identity checks, and IPC provenance.
tags: capability, security, rkx, authorization, ipc
---

## Purpose

Rk-C separates file ownership permissions from privileged syscall authorization. UID/GID and mode bits answer whether a process may access a filesystem object. Capabilities answer whether a process may invoke privileged kernel mechanisms such as raw device access or service control.

## Capability Bits

| Bit | Capability Name | Protected Purpose |
| --- | --- | --- |
| `0` | `sys_service_manager` | Register and mutate managed services |
| `1` | `sys_raw_fs` | Raw filesystem and FS service operations |
| `2` | `sys_raw_block` | Raw block and block service operations |
| `3` | `sys_raw_net` | Raw network-device operations |
| `4` | `sys_process_list` | Read privileged process information |
| `5` | `sys_process_kill` | Terminate selected processes |
| `6` | `sys_trace_ctl` | Enable or restrict syscall tracing |
| `7` | `sys_shutdown` | Stop the system |

Any RKX image containing unknown capability bits is rejected during validation.

## Request Versus Grant

An RKX header stores what an executable requests. It does not grant authority. During execution the kernel calculates:

```text
effective capability mask =
  RKX requested capability mask AND trusted mask for executable path
```

| Trusted Executable Path | Grantable Capabilities |
| --- | --- |
| `/bin/svcmgtd` | Service manager, process list, process kill |
| `/bin/procmgtd` | Process list, process kill |
| `/bin/procfsd` | Process list |
| `/bin/fsd` | Raw filesystem |
| `/bin/blockd` | Raw block |
| `/bin/netd` | Raw network |
| `/bin/stracectl` | Trace control |
| `/bin/kill` | Process kill |
| `/bin/shutdown` | Shutdown |
| `/bin/svc` | Service manager |
| Other executable paths | No grantable capability |

A copied or modified executable therefore cannot obtain raw authority merely by declaring it in image metadata.

## Syscall Gate

Every ecall reaches the central dispatch gate before its subsystem handler. Protected operations require the effective capability; several additionally require that the calling process is registered in the correct service role.

| Operation Family | Capability Requirement | Service Role Requirement |
| --- | --- | --- |
| Raw filesystem, FS receive/reply | Raw filesystem | Registered `fsd` |
| Raw block, block receive/reply | Raw block | Registered `blockd` |
| Raw network device access | Raw network | Registered `netd` |
| Process listing / FD inspection | Process list | `svcmgtd`, `procmgtd`, or `procfsd` |
| Process kill syscall | Process kill | `svcmgtd` or `procmgtd` |
| Service mutation | Service manager | Registered `svcmgtd` |
| Trace control | Trace control | No additional registered role |
| Shutdown | Shutdown | No additional registered role |

```text
requested in RKX
      |
      v
loader intersects with trusted path policy
      |
      v
effective mask in Process.user.capabilityMask
      |
      v
syscall dispatch gate -- role check when required --> handler or denial
```

## Kill Protection

Process termination is deliberately narrower than possession of a numeric PID:

- PIDs `0` and `1` are never valid kill targets.
- The caller must carry the process-kill capability and be a permitted process management service.
- A registered service PID may be killed only by the service manager, allowing lifecycle supervision rather than arbitrary service removal.

## IPC Provenance

Structured IPC packet metadata is stamped by the kernel at send time, replacing any values supplied by userspace:

| Field | Value Written by Kernel |
| --- | --- |
| `senderPid` | Current process PID |
| `uid` / `gid` | Current process identity |
| `capabilityMask` | Current effective capability mask |

Servers performing privileged work for clients must authorize each request against these stamped credentials. `svcmgtd`, for example, requires root UID and the service-manager capability for start, stop, restart, log, and status administrative operations.

## Relationship to File Permissions

The separation is intentional:

| Concern | Enforcement Mechanism |
| --- | --- |
| Read, write, search, execute, remove filesystem paths | UID/GID plus mode bits and sticky semantics |
| Raw filesystem bypass or service backend actions | Capability plus registered service identity |
| User database administration over service protocol | Kernel-stamped IPC identity checked by server |

Root file ownership alone does not automatically grant raw block access, raw network access, tracing authority, or service-manager authority.

## Audit and Diagnostics

Process status reporting retains both masks:

| Value | Meaning |
| --- | --- |
| Requested capability mask | Authority asked for by the RKX image |
| Effective capability mask | Authority actually granted by the kernel |

This makes it possible to distinguish a malformed declaration, a denied trust policy, and an application that simply did not request a capability.
