---
title: Filesystem Dispatch, File Descriptors, and Pipes
section: kernel
status: Implemented
updated: 2026-05-24
order: 4
excerpt: Rootfs, appfs, tmpfs, dev paths, filesystem service bridging, fd semantics, and stream plumbing.
tags: filesystem, vfs, fd, pipe, permissions, fsd
---

## Filesystem Views

The kernel retains filesystem representation and permission enforcement while normal application operations are bridged through the userspace filesystem service when it is registered and available.

| View | Mount or Prefix | Storage / Provider | Writable |
| --- | --- | --- | --- |
| Root filesystem | `/` | Disk-backed NFS2-style node table and fixed file blocks | Yes, with permission checks |
| Application filesystem | `/bin` | Read-only appfs package holding RKX binaries | No |
| Temporary filesystem | `/tmp` | In-memory tmpfs mounted through VFS routing | Yes, sticky public directory policy |
| Device namespace | `/dev` | Kernel virtual entries for console descriptors | Device-specific |
| Process filesystem | `/proc` | `procfsd` service-facing dynamic content | No normal writes |

## Rootfs and Appfs Disk Layout

Storage block size is 512 bytes. Rootfs and appfs occupy separate disk regions.

| Property | Value |
| --- | --- |
| Rootfs magic | `NFS2` / `0x4e465332` |
| Maximum rootfs nodes | `40` |
| Node name maximum | `16` bytes |
| Rootfs metadata blocks | `4` |
| Rootfs file allocation | `8` blocks per file, 4096 bytes maximum |
| Rootfs data start block | `8` |
| Appfs magic | `APFS` / `0x41504653` |
| Appfs start block | `4096` |
| Maximum appfs entries | `64` |

During filesystem initialization, the kernel ensures root directory structure and built-in metadata including `/tmp`, `/bin`, `/etc`, `/dev`, `/var`, `/var/log`, `/home`, `/home/rkc`, and `/etc/os-release`. Appfs entries are loaded for executable access under `/bin`, and tmpfs is mounted on `/tmp`.

## Permission Enforcement

Filesystem access is authorized using the caller process UID and primary GID together with owner/group/other mode bits. This layer is separate from syscall capabilities.

| Operation | Required Authority |
| --- | --- |
| Read file or list directory | Read permission and directory search permission along the path |
| Write existing file | Write permission on the file |
| Create node | Search and write permission on the parent directory |
| Remove node | Search and write permission on parent plus sticky-directory ownership rules |
| Execute `/bin` image | Search permission on `/bin` and executable appfs file policy |
| `chmod` | Root or owner, as implemented by filesystem permission checks |
| `chown` | Root UID only |

`/bin` and `/proc` deny normal modifications. `/tmp` applies sticky directory behavior so one non-root user cannot remove another user's temporary entry.

## Filesystem Service Bridge

Application-visible filesystem syscalls do not hand untrusted pointers to `fsd`. The kernel validates the application buffers, constructs bounded requests, and waits on a pending request record.

| Bound | Value |
| --- | --- |
| Path copied by ordinary FS syscall handler | `128` bytes |
| File I/O syscall staging size | `4096` bytes |
| Directory entries returned per chunk | `32` |
| Filesystem pending requests | `8` |
| Shared request data capacity | `4096` bytes |

```text
application
   | open/read/write/ls/mkdir/... syscall
   v
kernel permission and usercopy checks
   |
   | SysFsRequest(id, op, uid, gid, path, data)
   v
fsd service receives request
   |
   | performs raw-fs syscall as registered service
   v
kernel filesystem mechanism
   |
   | SysFsResponse(id, result, data)
   v
wake waiting caller and copy validated result to user buffer
```

Before `fsd` has been registered, bootstrap-time operations may fall back to the raw kernel filesystem path. Once the service is registered, an unavailable or failed service does not silently fall back for normal callers.

## File Descriptor Table

Each process owns eight file-descriptor slots. A descriptor records kind, access flags, current offset, remembered size, an optional pipe ID, and a 128-byte path field.

| Descriptor Kind | Example | Behavior |
| --- | --- | --- |
| File | `/home/rkc/note.txt` | Routed through filesystem service; maintains offset |
| Standard input | `/dev/stdin` | Reads from console input |
| Standard output | `/dev/stdout` | Writes to console output |
| Standard error | `/dev/stderr` | Writes to console output |
| Console | `/dev/console` | Console-oriented descriptor |
| Pipe | `/dev/pipe` | Kernel ring-buffer endpoint |

Open supports read, write, create, truncate, and append flags. Reads and writes are staged through bounded kernel buffers and re-check filesystem permissions for each operation. Therefore, changing mode bits can affect an already-open descriptor on a subsequent access.

## Pipes and `dup2`

The pipe layer supplies eight global pipe slots with 512 bytes of buffered data per pipe. Each pipe records reader and writer reference counts and wakes blocked opposite endpoints as endpoints close or data availability changes.

```text
shell: left | right

 create pipe -> [read fd, write fd]

 left child                         right child
 dup2(write fd, stdout=1)           dup2(read fd, stdin=0)
 close unused ends                  close unused ends
      |                                   ^
      v                                   |
  write_fd(1) ---> 512-byte pipe ---> read_fd(0)
```

Descriptor tables are inherited during child execution, and `dup2` retains pipe references correctly. The same FD replacement mechanism implements output redirection by opening a target file and placing that descriptor at stdout.

## Polling and Wait Integration

`poll` accepts at most 16 events and can observe:

| Event | Condition |
| --- | --- |
| FD read | Pipe has data or file is readable |
| FD write | Pipe has capacity or output/file target is writable |
| IPC read | Current process IPC queue contains a packet |
| PID exit | Selected process is a zombie |
| Timer | Poll deadline has elapsed |

Blocked pipe and poll operations integrate with the process wait-state system, allowing idle execution to use `wfi` instead of spinning while data is absent.
