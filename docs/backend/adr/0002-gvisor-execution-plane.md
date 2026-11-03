# ADR-0002: gVisor (`runsc`) as the production execution plane

Status: accepted · Date: 2026-11-03 · Scope: `releases/V1.md` (package C)

## Context
SECURITY §7 says a container is not a sufficient boundary for hostile multi-tenant code and asks
for "microVMs or a specialized sandbox runtime", a separate execution account/VPC, a strict egress
proxy, and an independent security assessment. Until now the only driver was a hardened Docker
container, refused in production. Development happens on Windows with WSL2, where neither a KVM
microVM (Firecracker) nor a Docker runtime plug-in is practical.

## Decision
Add `EXECUTION_DRIVER=gvisor` (`apps/api/src/execution/gvisor-sandbox.ts`), the only driver
allowed in production:

- Every verification profile runs under gVisor: a user-space kernel that intercepts the sandboxed
  process's system calls, so repository code never reaches the host kernel. It also enforces seccomp
  on its own sentry.
- The worker writes a fresh OCI bundle per run and calls `runsc run` directly. It needs **no Docker
  daemon or socket**. Image root filesystems are provisioned ahead of time
  (`scripts/sandbox/prepare-rootfs.sh`), so the worker never pulls images.
- The OCI spec keeps every control of the Docker driver: uid/gid 65534, no capabilities,
  `noNewPrivileges`, read-only root, a fresh empty network namespace (`--network=none`), memory,
  PID and CPU limits, `RLIMIT_NOFILE`/`FSIZE`/`NPROC`/`CORE`, a `noexec` tmpfs, masked `/proc`
  paths, a fixed environment with nothing from the host, and the disposable workspace as the only
  writable bind. Output is bounded and redacted by the same `runBounded()` the Docker driver uses.
- The dependency fetch step (B-4) is refused under gVisor unless the operator sets
  `SANDBOX_GVISOR_FETCH_NETWORK=host` together with an egress-allowlisting `SANDBOX_FETCH_PROXY`;
  production config refuses `host` without the proxy.
- `SANDBOX_PATH_STYLE=wsl` lets a Windows development worker call runsc inside WSL; production
  refuses it.

Firecracker microVMs remain the documented AWS target for the strongest isolation (`infra/aws/`);
the driver contract (`SandboxDriver`) is what a Firecracker driver would implement.

## Consequences
- Production no longer needs `ANVAYA_ALLOW_CONTAINER_SANDBOX_IN_PRODUCTION`.
- Unit tests cover the generated spec and the driver's process handling with a stand-in runsc;
  `test/gvisor.live.spec.ts` runs hostile probes (network, root FS writes, `/tmp` exec, host env,
  fork bomb, wall clock) against real runsc when `ANVAYA_TEST_RUNSC=1`.
- Still required before broad public execution (SECURITY §7): a separate execution account/VPC and
  egress proxy (modelled in `infra/aws/`) and an independent security assessment.
