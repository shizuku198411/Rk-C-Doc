---
title: Address Spaces, Memory, and User Execution
section: architecture
status: Implemented
updated: 2026-05-24
order: 3
excerpt: Sv39 mappings, fixed virtual address windows, RKX loading, heap growth, and usercopy boundaries.
tags: memory, paging, sv39, rkx, heap, usercopy
---

## Translation Model

Rk-C uses Sv39 virtual memory with 4 KiB pages. The kernel creates a root page table during bootstrap and writes `satp` with Sv39 mode enabled. Each user process then receives a separate root page table that contains:

- Shared identity mappings for kernel execution and required QEMU MMIO.
- Private U-mode mappings for that process image, stack, and dynamic heap.

Only the lower canonical Sv39 range below `0x0000004000000000` is accepted for user pointer copying. This prevents a userspace syscall argument from reaching kernel or high-half virtual mappings through usercopy.

## Kernel and Device Identity Mappings

Kernel mappings use equal virtual and physical addresses. Sizes for linker sections vary with the compiled image; the fixed platform device mappings are:

| Mapping | Address Range | Permission | Purpose |
| --- | --- | --- | --- |
| Kernel text | From `0x80200000` through aligned text end | `r-x` | Privileged executable code |
| Kernel rodata | Aligned linker-defined range | `r--` | Immutable kernel data |
| Kernel writable area | Data start through `__free_ram_end` | `rw-` | Data, BSS, stack, bitmap, managed pages |
| RTC | `0x00101000` - `0x00101fff` | `rw-` | Goldfish RTC time source |
| PLIC window | `0x0c000000` - `0x0c3fffff` | `rw-` | Interrupt-controller window |
| UART / MMIO window | `0x10000000` - `0x1000ffff` | `rw-` | UART and VirtIO MMIO slots |

VirtIO MMIO probing starts at `0x10001000`, advances in `0x1000` increments, and examines up to eight devices. The default QEMU wiring places block at virtio-mmio bus slot 0 and network at slot 1.

## User Virtual Address Windows

The shell uses its own fixed virtual window. All other application and server images use the common app window, but each runs in a distinct page table and therefore cannot observe another process using the same addresses.

| Process Class | Image Base | Stack Top | Maximum Image VA Window |
| --- | --- | --- | --- |
| `/bin/shell` | `0x01000000` | `0x01100000` | 1 MiB from image base |
| Login, servers, and commands | `0x01200000` | `0x01300000` | 1 MiB from image base |

```text
Example normal application virtual address window

0x01300000  +---------------------------+  fixed stack top
            | user stack         rw- NX |  1..16 pages from RKX header
            +---------------------------+
            | unmapped guard page       |  1 page minimum
            +---------------------------+  heapLimit
            | growable heap       rw- NX|  brk/sbrk mapped pages
            |                           |
            +---------------------------+  heapStart = imageBase + imagePages * 4096
            | BSS                rw- NX |
            | data               rw- NX |
            | rodata             r-- NX |
            | text               r-x    |
0x01200000  +---------------------------+  image base
```

The stack is never executable. Heap mappings are also read/write only. The loader maintains write-xor-execute behavior for the mapped RKX sections.

## RKX Executable Loading

User programs are stored as RKX version 2 images. An RKX header declares the entry point, section locations and sizes, requested capability mask, stack page count, and any UID allowlist for executable access.

| Validation Rule | Enforced Boundary |
| --- | --- |
| Image magic | `RKX1` (`0x31584b52`) |
| RKX version | Version `2` |
| Maximum mapped image pages | 64 pages |
| Image VA window | At most 1 MiB starting at the expected class base |
| Entry point | Must lie inside mapped text |
| Segments | Page-aligned, non-overlapping, and file ranges bounded by image size |
| Stack allocation | Default 4 pages; minimum 1; maximum 16 |
| Requested capabilities | Must use known mask bits and are reduced to path-trusted grants |
| UID allowlist | At most eight UIDs; checked when commands are executed |

Image sections are materialized into newly allocated pages with individual permissions:

| Section | User Permission |
| --- | --- |
| Text | Read + execute |
| Read-only data | Read only |
| Initialized data | Read + write |
| BSS | Read + write, zero initialized |
| Stack | Read + write |

## Heap Growth

After loading an RKX image, a process begins with an empty heap:

```text
heapStart = imageBase + mappedImagePages * 4096
heapEnd   = heapStart
heapLimit = stackBottom - 4096
```

The gap of one page below the stack is reserved as a guard region. `brk` and `sbrk` can map heap pages only inside this range. Heap growth allocates and maps pages one at a time; if any page cannot be mapped, already mapped pages from that growth operation are rolled back. Shrinking the heap unmaps pages, zeroes their physical storage during release, and returns them to the bitmap allocator.

## Physical Page Allocator

The linker reserves 128 MiB after the kernel stack for dynamic physical pages. The allocator aligns the reservation to page boundaries, stores a compact allocation bitmap in its first pages, and manages the remaining pages.

The allocator guarantees:

- Newly allocated physical pages are zero initialized.
- Released pages are zeroed before their allocation bits are cleared.
- Page tables, kernel process stacks, user image pages, stacks, and heaps all consume pages from the same accounted managed region.

## Usercopy Trust Boundary

Kernel handlers do not dereference arbitrary U-mode addresses directly. Copy-in and copy-out operations validate:

1. The pointer is non-null when data length is non-zero.
2. Address arithmetic does not overflow.
3. The range is in the allowed lower Sv39 user domain.
4. The range lies inside the current process image, stack, or current heap.
5. Every page is mapped with `U` permission and the required read or write permission.

The S-mode `SUM` permission is enabled only while the actual memory copy is in progress, then restored immediately.

## Reclamation

When a user process is discarded, Rk-C releases all user image pages, stack pages, and heap pages, followed by the private page-table pages. Intermediate page tables are also pruned when dynamic mappings become empty. This keeps short-lived shell commands and nested sessions from consuming allocator bitmap pages permanently.
