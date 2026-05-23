export const sectionDefinitions = [
  {
    id: "architecture",
    title: "Architecture",
    description: "Boot flow, system boundaries, and design decisions.",
  },
  {
    id: "kernel",
    title: "Kernel Internals",
    description: "Memory, traps, scheduling, and privileged mechanisms.",
  },
  {
    id: "userspace",
    title: "Userspace & Services",
    description: "Servers, shell, applications, and service lifecycle.",
  },
  {
    id: "api",
    title: "API Reference",
    description: "Syscalls, IPC messages, ABIs, and file formats.",
  },
  {
    id: "operations",
    title: "Build & Operations",
    description: "Build, QEMU execution, testing, and debugging workflows.",
  },
];


export function getSectionDefinition(sectionId) {
  return sectionDefinitions.find((section) => section.id === sectionId);
}
