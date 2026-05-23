---
title: Service and IPC Architecture
section: architecture
status: Implemented
updated: 2026-05-24
order: 4
excerpt: Service registration, supervision, structured IPC provenance, and the required-service boot contract.
tags: services, ipc, svcmgtd, capabilities, supervision
---

## Design Intent

Rk-C uses userspace service processes as the primary extension boundary for OS policy. Applications communicate with servers using structured IPC packets, while the kernel supplies protected primitives: process queues, sender provenance, routing state, usercopy validation, and restricted raw operations.

This split enables service failure handling and later protocol evolution without putting every feature inside the privileged syscall dispatcher.

## Service Inventory

The service manager itself is registered directly during startup. It then owns the lifecycle of six managed service processes described by the shared service catalog.

| Service Kind | Process | Required | Primary Contract |
| --- | --- | --- | --- |
| Manager | `svcmgtd` | Yes | Lifecycle supervision and service control |
| Process | `procmgtd` | Yes | Process list and controlled process management |
| Block | `blockd` | Yes | Block request service endpoint |
| Filesystem | `fsd` | Yes | Filesystem operations exposed to applications |
| User | `userd` | Yes | User/group database and password authentication |
| Proc filesystem | `procfsd` | No | Dynamic `/proc` system views |
| Network | `netd` | No | ICMP, UDP, TCP, DNS-facing network service operations |

## Registry and Manager Roles

There are two complementary sources of service state:

| Owner | Maintains | Why It Remains Privileged or Unprivileged |
| --- | --- | --- |
| Kernel registry | Kind-to-PID binding, registered flag, ready flag, process availability check | Syscall routing and boot readiness must not trust an arbitrary server |
| `svcmgtd` | Startup state, restart count, ready deadlines, last failures, event log, administrative command handling | Lifecycle policy can be managed in userspace |

```text
               kernel boot_task
                      |
                      | launches
                      v
                 +---------+
                 |svcmgtd  |
                 +----+----+
                      |
      exec + register + await ready packet
     +----------------+----------------+----------------+
     v                v                v                v
 procmgtd          blockd            fsd             userd       required
 procfsd           netd                                          optional
     |                |                |                |
     +----------------+----------------+----------------+
                      |
                      v
              kernel service registry
```

## Registration and Ready Handshake

Each managed service becomes usable through a two-step protocol:

1. `svcmgtd` creates the server process and registers its service kind with the new PID in the kernel registry.
2. After its own initialization, the server sends a service-ready packet to `svcmgtd`.
3. The manager accepts the ready packet only if the packet sender PID equals the PID it started, the service is still in the starting state, and the advertised service kind matches.
4. `svcmgtd` requests the kernel to mark the matching registered service ready.

```text
svcmgtd               kernel registry               server
   |                         |                         |
   | exec server             |                         |
   |--------------------------------------------------->|
   | register(kind, pid)     |                         |
   |------------------------>| registered, not ready   |
   |                         |                         |
   |      IPC ready(kind), kernel-stamped sender PID   |
   |<---------------------------------------------------|
   | validate PID + kind     |                         |
   | ready(kind, pid)        |                         |
   |------------------------>| registered and ready    |
```

`svcmgtd` permits up to 200 ticks for an individual starting server to become ready. The kernel boot task independently waits up to 250 ticks for initial service availability before deciding between normal boot, degraded boot, and fatal required-service failure.

## Required and Optional Failure Policy

| Condition | Required Service | Optional Service |
| --- | --- | --- |
| Startup fails | Kept unavailable and prevents successful initial readiness | Marked degraded |
| Ready deadline expires | Stopped or restarted according to manager state | Marked degraded |
| Process exits after running | Automatically restarted | Unregistered and marked degraded |
| Administrative stop request | Rejected | May be stopped |
| Initial boot dependency | Login waits for availability | Login may proceed after timeout |

The optional policy currently applies to `procfsd` and `netd`; a system may therefore retain local shell and storage operation even if dynamic `/proc` views or networking are absent.

## Structured IPC Transport

Every process owns an IPC queue of structured packets. Sending enqueues a packet into the target process queue and wakes a sleeping receiver. Receiving can block until a packet arrives or use a non-blocking try-receive operation.

Most service protocols use request/reply messages with request IDs. Kernel bridges for filesystem and block operations keep pending request records and sleep the calling process until the matching service reply arrives or the registered service is no longer available.

```text
application syscall
     |
     v
kernel service bridge -- allocate request id --> pending table
     |
     | structured packet
     v
service IPC queue --> service handles request --> structured reply
     |                                           |
     +------------- wake waiting caller <-------+
```

## Sender Provenance and Authorization

Applications cannot set the effective identity of an IPC sender. Before enqueuing a packet, the kernel overwrites protected metadata with values from the currently running process:

| Packet Metadata | Kernel Source |
| --- | --- |
| Sender PID | Current process PID |
| UID | Current process identity UID |
| GID | Current process identity GID |
| Capability mask | Granted capability mask stored in the loaded process |

Services use this stamped information when evaluating privileged requests. For example, service-manager control requests require root UID and the service manager capability; executable RKX metadata may request capabilities, but the loader grants only the subset trusted for that executable path.

## Extending the Service Set

A new persistent service should follow this architectural sequence:

1. Define a shared service kind and packet operations.
2. Add lifecycle metadata to the shared managed-service catalog.
3. Add the userspace server binary and its RKX capability request, if needed.
4. Register and report ready only after the service can accept requests.
5. Expose an application library wrapper around structured IPC instead of duplicating packet assembly in each client.
6. Decide whether missing service availability must prevent login or should produce degraded operation.
