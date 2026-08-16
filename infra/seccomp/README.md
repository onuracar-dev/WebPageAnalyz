# Worker Chromium seccomp profile

`playwright-worker.json` is the Microsoft Playwright Docker profile from
commit `ae935a43d9e376e4759548f6b3c6905c7b282333` at
`microsoft/playwright/utils/docker/seccomp_profile.json` (retrieved
2026-08-14). The profile keeps the Docker default `SCMP_ACT_ERRNO` policy and
its default syscall allowlist, with the Playwright-documented user-namespace
allowance for `clone`, `setns`, and `unshare`. The normalized checked-in file
hash is
`17e2d449ab7c2c6fefc5b9f978224a49929864eb1d5a42f4f9002266c9300de2`.

Compose applies this profile only to `analysis-worker`, alongside `USER node`,
`read_only`, `cap_drop: ALL`, `no-new-privileges`, resource limits, and the
worker-only egress network. It does not grant `SYS_ADMIN`, disable seccomp, or
provide a Chromium `--no-sandbox` fallback. The Docker Desktop probe remains
fail-closed when the host kernel rejects Chromium's namespace operation.
