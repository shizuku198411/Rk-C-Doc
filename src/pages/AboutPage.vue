<template>
  <section class="page-card prose-page">
    <p class="page-label">Project</p>
    <h1 class="page-title">About Rk-C</h1>
    <p class="page-description">
      Rk-C is a microkernel-style operating system implemented in Nim for the
      RISC-V 64-bit architecture and developed on QEMU with OpenSBI.
    </p>

    <div class="prose-block">
      <h2>Documentation Scope</h2>
      <p>
        This site records architecture choices, kernel internals, userspace
        services, syscall and IPC contracts, and the workflows used to build
        and test Rk-C.
      </p>
      <p>
        Documents are intended to explain the current implementation and its
        interfaces, rather than act as chronological development posts.
      </p>

      <h2>Implementation Focus</h2>
      <ul>
        <li>RISC-V 64-bit supervisor and user mode execution</li>
        <li>Userspace services connected through structured IPC</li>
        <li>Virtual filesystem, process management, networking, and shell tooling</li>
        <li>Documented APIs for continued kernel and userspace development</li>
      </ul>

      <h2>Github Repository</h2>
      <p>
        <a href="https://github.com/shizuku198411/Rk-C" target="_blank" rel="noopener noreferrer">
          https://github.com/shizuku198411/Rk-C
        </a>
      </p>
    </div>
  </section>
</template>
