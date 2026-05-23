# Rk-C Documentation Site

Vue and Markdown based documentation portal for the Rk-C RISC-V 64-bit
microkernel.

## Document Layout

Markdown documents live under `docs/<collection>/<document>.md`. Each
document provides front matter used by the library view:

```md
---
title: Kernel Boot and Userspace Startup
section: architecture
status: Implemented
updated: 2026-05-24
order: 1
excerpt: Short description shown in the document library.
tags: boot, opensbi, riscv64
---
```

Supported sections are `architecture`, `kernel`, `userspace`, `api`, and
`operations`.

## Development

```bash
npm install
npm run dev
```
