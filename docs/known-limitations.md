# Known limitations (V1)

Kept honest and current; each item says what would close it.

## Execution and security
- **Independent security assessment** of the execution plane has not been done; SECURITY §7 requires
  one before broad public repository execution.
- **One worker does orchestration and verification**, so the execution plane is isolated by subnet,
  security group, egress firewall and gVisor, but not by a separate AWS account. Splitting a sandbox
  controller out of the worker is the prerequisite for that.
- **gVisor is verified in CI on Linux**; on the Windows development machine only the stand-in tests
  run (installing runsc there was not possible in this environment). Local development uses the
  Docker driver, which production refuses.
- **Dependency installation** runs only through the opt-in fetch step (B-4) and, under gVisor, only
  with an egress-allowlisting proxy.

## Product scope
- **GitLab and Bitbucket** are out of V1 (`releases/V1.md`).
- **PR and failing-check tasks** run against the latest indexed default-branch snapshot, not the PR
  head or the failing commit, so a failure that exists only on another branch cannot be reproduced
  by the run. Check-run webhooks are not consumed (tasks are created through the API/UI).
- **Failing-check tasks from GitHub Actions** need the App's optional `actions:read` permission to
  include the job log; without it the task has only the check's metadata and annotations.
- **Quotas**: runs waiting at approval gates count as active; one model call can overshoot the token
  quota by its own budget because the check runs before the call.
- **Imported titles** become part of the run's objective text; they are redacted and bounded but are
  still untrusted text inside application-owned intent.

## Models and evaluation
- A 7B local model on CPU is slow (15–25 minutes of model time per run) and its patches vary in
  quality; verification and approvals are the safety net, not the model.
- The retrieval benchmark's CI numbers use a hashed bag-of-words test embedding; live-embedding
  results are still to be recorded (`docs/evaluations/retrieval.md`).
- Live GitHub validation covers sign-in, install, indexing, pull requests, PR and failing-check
  tasks, and webhooks through a smee tunnel, all on one small test repository.

## Operations and deployment
- The AWS Terraform has been validated, never applied; the web image needs the API origin at build
  time, so it is built per environment.
- Traces need an OTLP collector (none is deployed by default); metrics and structured logs work.
- Storage is a shared filesystem (EFS on AWS); there is no object-store driver yet.
- Browser E2E runs in Chromium, Firefox and WebKit on fixtures; the live suite runs in Chromium.
