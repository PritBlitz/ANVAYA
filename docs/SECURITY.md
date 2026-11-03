# ANVAYA — Security Architecture and Threat Model

**Security classification:** Core product requirement  
**Trust posture:** Repository content, user-provided content, model output, and execution output are untrusted.

## 1. Security objectives

1. Protect tenant data from cross-workspace access.
2. Protect source code, credentials, and artifacts.
3. Prevent repository code from compromising control-plane services or hosts.
4. Prevent unauthorized Git provider writes.
5. Constrain AI tools and resist prompt injection.
6. Preserve integrity of approval and audit records.
7. Limit compute, storage, network, and model abuse.
8. Make data egress and retention visible and governable.

## 2. Assets

- User identities, sessions, and workspace roles.
- GitHub App private key and installation tokens.
- Source code, snapshots, embeddings, and engineering documents.
- Model provider API keys and prompts.
- Workflow state, plans, patches, and checkpoints.
- Sandbox filesystems and processes.
- Test/build logs and artifacts.
- Pull-request credentials and approval records.
- Usage, audit, and security events.

## 3. Trust boundaries

- Browser to API.
- API to Git provider.
- API to queue and workers.
- Orchestrator to AI provider.
- Orchestrator to execution control.
- Execution sandbox to host/network/object storage.
- Workspace to workspace.
- Local model environment to optional hosted inference provider.

All repository content, issue descriptions, PR comments, commit messages, README instructions, source comments, dependency scripts, test output, and model output are untrusted.

## 4. Threat model and controls

| Threat | Attack example | Required controls |
|---|---|---|
| Broken access control | Change repository/run UUID in URL | Tenant-scoped authorization, IDOR tests, optional RLS |
| Credential exposure | Token appears in log or prompt | Secret manager, short-lived tokens, redaction, no secret context |
| Webhook spoofing | Fake GitHub event | Signature verification on raw body, replay protection |
| Prompt injection | README asks agent to exfiltrate secrets | Treat content as data, no secrets, narrow tools, sandbox boundaries |
| Arbitrary execution | Model returns destructive shell command | No generic shell tool; server-side command profiles |
| Sandbox escape | Malicious build script attacks host | Hardened isolation; microVMs for hostile multi-tenant workloads |
| Resource exhaustion | Fork bomb or huge output | CPU/RAM/PID/disk/time/output limits |
| Network exfiltration | Build process uploads repository | Egress deny by default, no credentials in sandbox |
| Malicious dependency | Install lifecycle script executes code | Dependency policy, network restrictions, lockfile review |
| PR abuse | Agent pushes without user approval | State gate, server-side approval check, idempotency |
| Hallucinated verification | AI says tests passed | Only deterministic exit status determines result |
| Cross-tenant vector leakage | Similarity search returns another tenant's chunk | Tenant filter before ranking, authorization tests |
| SSRF | URL feature reaches cloud metadata endpoint | Egress proxy, destination allowlist, private IP blocking |
| Log leakage | stderr includes secrets | Redaction, bounded output, access controls, retention |

## 5. Identity and access control

- Use secure sessions and session rotation.
- Workspace roles: owner, admin, member, viewer.
- Enforce role and resource access in backend services.
- Use repository installation permissions as a separate authorization check.
- Revalidate permissions before external writes.
- Use short-lived installation tokens.
- Never rely on frontend hiding controls as authorization.
- Test direct API access across tenants and roles.

## 6. GitHub App security

- Use GitHub App, not broad personal access tokens.
- Request minimum permissions.
- Keep private key in secret manager.
- Mint short-lived installation tokens only when needed.
- Verify webhook signature using raw body and constant-time comparison.
- Persist delivery IDs and reject duplicates.
- Re-check repository installation and permissions before branch/commit/PR writes.
- Separate read and write permission configuration.
- Disconnecting installation stops future jobs and revokes access where possible.

## 7. Execution sandbox security

### Required baseline
- Execution service runs separately from API and AI services.
- Disposable environment per task/run.
- Non-root user.
- No privileged container.
- No Docker socket mount.
- No host home directory or application secret mounts.
- No access to Postgres, Redis, internal control-plane endpoints, or cloud metadata.
- Read-only root filesystem where practical.
- Dedicated writable workspace.
- Drop Linux capabilities.
- seccomp and AppArmor/SELinux where supported.
- CPU, memory, PID, disk, wall-time, and output limits.
- Deny network egress by default.
- Explicit allowlist for any required package/network access.
- Bounded artifact collection and cleanup.
- Separate scoped credentials only for artifact upload if needed.

### Production requirement
A container is not a sufficient security boundary for arbitrary hostile code in a public multi-tenant product. Use microVMs or a specialized sandbox runtime, separate execution account/VPC, strict egress proxy, and independent security assessment before enabling broad public repository execution.

### Command execution policy
- The model never supplies an arbitrary command string.
- The server maps approved profile IDs to fixed executable/arguments.
- Repository-defined scripts are untrusted and run only inside the sandbox.
- Dependency installation is a distinct high-risk operation.
- Command output is bounded and redacted.
- Execution policy is versioned and auditable.

## 8. Prompt injection and agent security

- System policy is separate from retrieved content.
- Retrieved content is labeled untrusted.
- No secrets are sent to models.
- Tools are narrow and stage-specific.
- File path normalization prevents traversal and symlink escape.
- Patch validator checks approved scope, size, and file count.
- No direct production credentials are available to agents.
- No autonomous merge/deploy.
- Reviewer cannot approve its own work.
- Human approvals are bound to exact plan/patch hashes.
- Model output is validated before use.

Prompt instructions are not a security boundary by themselves; enforcement must exist in application code, tool permissions, and sandbox policy.

## 9. Data protection and privacy

- Local-only inference must not make outbound model API calls.
- Cloud inference is opt-in and shows provider/data disclosure.
- Exclude secrets and sensitive files from indexing.
- Redact known tokens and secret patterns before logs.
- Encrypt data in transit and at rest.
- Store provider keys in a secret manager or encrypted store.
- Retention settings apply to snapshots, logs, embeddings, and artifacts.
- Provide disconnect and deletion workflows.
- Do not use private repository data for model training.
- Clearly document any third-party provider data handling.

## 10. Application security

- CSRF protection for cookie-authenticated mutations.
- Strict CORS allowlist.
- Secure, HttpOnly, SameSite cookies.
- Rate limits and request size limits.
- DTO/schema validation.
- Parameterized database queries.
- Output encoding and XSS protection.
- SSRF defenses.
- Dependency and secret scanning in CI.
- TLS and security headers.
- Safe error handling with request IDs.
- Audit privileged actions.

## 11. Audit events

Record:
- Authentication and session changes.
- Workspace membership and role changes.
- Git installation connect/disconnect.
- Repository access and deletion.
- Provider policy and cloud inference changes.
- Plan and PR approvals/rejections.
- Sandbox policy changes.
- PR creation.
- Data export/deletion.
- Administrative overrides.

Audit records should be append-only from application behavior and protected against ordinary user modification.

## 12. Incident response

1. Stop affected jobs and disable the affected integration/provider.
2. Revoke or rotate credentials.
3. Isolate affected execution workers.
4. Preserve redacted logs and audit events.
5. Identify impacted tenants and data.
6. Assess exposure and notification obligations.
7. Patch and test the vulnerability.
8. Document root cause and corrective actions.

## 13. Security release gates

- Cross-tenant authorization tests pass.
- Webhook signature and replay tests pass.
- No secret in prompts/logs/artifacts.
- Sandbox cannot reach control-plane data services.
- Sandbox limits and cleanup verified.
- Prompt injection benchmark executed.
- Path traversal and symlink tests pass.
- PR approval cannot be bypassed.
- Cancellation terminates execution.
- Dependency and secret scans pass.
- Threat model updated for new integrations/tools.
