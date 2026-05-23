---
title: Physical Allocator and Sv39 Page Tables
section: kernel
status: Implemented
updated: 2026-05-24
order: 3
excerpt: Bitmap page allocation, three-level page table mechanics, mapping flags, usercopy validation, and heap teardown.
tags: memory, allocator, paging, sv39, usercopy
---

## Physical Allocation Region

The kernel linker reserves a 128 MiB `NOLOAD` region following the initial kernel stack. Memory initialization aligns this reservation to 4 KiB pages and divides it into allocation metadata and usable pages:

```text
__free_ram_start
      |
      v
+----------------------+  page-aligned
| allocation bitmap    |  enough pages to describe managed pages
+----------------------+  managedRegionStart
| allocatable page 0   |
| allocatable page 1   |
| ...                  |
+----------------------+  __free_ram_end
```

The bitmap size is solved iteratively because bitmap pages themselves reduce the remaining managed page count.

## Allocator Guarantees

| Operation | Behavior |
| --- | --- |
| Allocate `n` pages | Searches for a contiguous free run and zeroes all returned pages |
| Free `n` pages | Validates address alignment, managed range, and allocated bits; zeroes pages before clearing bits |
| Bitmap reporting | Counts currently allocated managed pages for `total`, `used`, and `free` statistics |

The same allocator backs page tables, kernel process stacks, user image pages, user stacks, heaps, VirtIO queues, and device buffers. This makes leakage visible through the runtime bitmap inspection path.

## Sv39 Table Structure

Rk-C uses three levels of Sv39 page tables and 4 KiB leaf mappings.

| Property | Value |
| --- | --- |
| Page shift | `12` |
| VPN bits per level | `9` |
| Entries per table | `512` |
| `satp` mode value | `8 << 60` |
| Accepted low user virtual range | Below `0x0000004000000000` |

```text
 virtual address
 +---------+---------+---------+------------+
 | VPN[2]  | VPN[1]  | VPN[0]  | page offset|
 | 9 bits  | 9 bits  | 9 bits  | 12 bits    |
 +---------+---------+---------+------------+
      |         |         |
      v         v         v
   root L2 -> L1 table -> L0 table -> physical 4 KiB page
```

Intermediate tables are allocated from the physical page allocator on demand. When unmapping makes an intermediate path empty, those table pages are pruned and returned to the allocator.

## Page Table Entry Flags

| Flag | Purpose |
| --- | --- |
| `V` | Valid mapping or child table |
| `R` | Read permission |
| `W` | Write permission |
| `X` | Execute permission |
| `U` | Accessible from U-mode |
| `A` | Accessed flag installed on leaf mappings |
| `D` | Dirty flag installed on leaf mappings |

Kernel image mappings omit `U`. User text receives `U|R|X`; user data, BSS, stack, and heap receive `U|R|W`. No user loader path maps a writable executable page.

## Root Page Tables

Bootstrap creates the kernel root page table and uses identity mappings for kernel regions and MMIO. For each user process, execution creates a new root page table with equivalent protected kernel mappings, then adds private U-mode segments.

The scheduler changes `satp` on process selection and performs a full TLB flush. Dynamic map and unmap operations also flush when required, including heap shrinking and address-space teardown.

## Heap Mapping Semantics

Process heap metadata records:

| Field | Meaning |
| --- | --- |
| `heapStart` | First possible heap byte, immediately after mapped image pages |
| `heapEnd` | Current program break requested by userspace |
| `heapLimit` | Maximum break, one unmapped guard page below user stack |

The `brk` handler permits queries with argument `0`. A new break below `heapStart` or above `heapLimit` is rejected. Growth maps only newly needed pages; a partial growth failure unmaps pages added during that call. Shrinkage unmaps surplus pages and allows empty page-table branches to be pruned.

## Usercopy Validation

Syscall buffers and strings are transferred through validated copy helpers. For each requested range the kernel checks:

| Validation | Reason |
| --- | --- |
| Non-null pointer for non-empty transfer | Reject invalid absent data |
| Addition does not overflow | Avoid wrapping into a different mapping |
| Both endpoints are low canonical user addresses | Exclude kernel/high ranges |
| Range belongs to the declared image, stack, or active heap extent | Exclude unrelated mappings |
| Each PTE has `U` plus requested `R` or `W` permission | Enforce mapping-level access |

`SUM` is enabled only during the actual copy instruction sequence, then the previous `sstatus` is restored. Trap entry clears SUM before dispatch, making unexpected supervisor dereference of U-mode pages fail closed.

## Teardown Path

The address-space teardown sequence for a user process is:

```text
unmap and free image pages
  -> unmap and free stack pages
  -> unmap and free heap pages
  -> recursively free remaining private page-table pages
  -> release kernel process stack during complete process discard
```

This path is invoked when a zombie is reaped or a partially constructed process fails to execute, preventing failed loads and short-lived commands from leaking allocator pages.
