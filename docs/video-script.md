# Demo video script

About 5 minutes. It uses runs that have already finished, so nothing on camera depends on the
local model behaving that day. A live run takes about 20 minutes on this laptop; show one starting,
then cut to a finished run and say so.

## Before recording

1. Close Chrome tabs you do not need, IntelliJ and anything else heavy.
2. Start the stack: `powershell -ExecutionPolicy Bypass -File scripts\dev-stack.ps1 start`, then
   `... dev-stack.ps1 status`. All four services should say `True`.
3. Sign in at `http://localhost:3000` and open workspace `pritblitz`.
4. Open these in tabs, in this order:
   - `/w/pritblitz/runs/e223d4ae-ae8a-4872-bb2c-457143373de5` (failing check fixed, PR #6)
   - `/w/pritblitz/runs/37cea529-b4c5-41b9-8d8a-8b26fc992f8e` (refused: tests failed)
   - `https://github.com/PritBlitz/testRepo/pull/6`
5. Do not show `.env`, the terminal, the smee URL or GitHub App settings: they contain secrets or
   private channel details.

## Shots

| # | Time | Screen | Do | Say |
|---|---|---|---|---|
| 1 | 0:00 | Home page | Scroll slowly | "AI coding agents are fast, but who checks what they did? Anvaya is an engineering workflow where AI proposes and people approve." |
| 2 | 0:20 | Repository, code view | Open a file, a symbol, the dependency map | "It indexes your repository first, so every claim can point at real code." |
| 3 | 0:45 | Q&A | Ask "Where is word counting implemented?" | "Answers cite files and lines. With no evidence, it says so instead of guessing." |
| 4 | 1:10 | New task dialog | Show the source options, pick the failing check | "Work can start from a task, an issue, a pull request, or a failing CI check. Here, a real GitHub Actions failure on master." |
| 5 | 1:35 | Run e223d4ae, task context | Show the imported traceback | "Anvaya pulled the failing step's log: a test expected 4 words and got 3. Imported text is treated as untrusted data." |
| 6 | 1:55 | Investigation and plan | Show evidence links, then the plan | "The model investigates, then proposes a plan tied to evidence. Nothing changes until a person approves this plan." |
| 7 | 2:25 | Changes | Show the one-line diff | "It found the bug: an off-by-one that skipped the first word. One line changed, in a disposable workspace." |
| 8 | 2:50 | Verification | Show commands, exit codes, test selection | "Pass or fail comes from real commands in a sandbox, not from the model's opinion." |
| 9 | 3:15 | Review | Show the finding | "The AI reviewer raises concerns, labelled separately from the deterministic results. This one is a false alarm, which is why a person decides." |
| 10 | 3:40 | Pull request step, then GitHub PR #6 | Show the approval, then the PR | "A person approves this exact patch, and only then is a pull request opened. Nothing is ever merged automatically." |
| 11 | 4:05 | Run 37cea529 | Show the failed verification | "Here is what matters most. The model wrote a wrong test, tried to repair it, and failed. So no pull request was opened." |
| 12 | 4:30 | Settings: AI policy, audit log | Scroll both | "Teams control which models run, budgets and limits, and every decision is in an audit log." |
| 13 | 4:50 | Run list | Hold | "Anvaya: AI does the work, evidence backs it up, and people stay in charge." |

## Keep the claims honest

- These runs used a small local model (7B) on a laptop, with no cloud AI.
- A run takes about 20 minutes on this machine. If you show one starting, say the video skips ahead.
- The model does not always succeed. Say so: refusing a bad patch is the point of the product.
- Local runs use a Docker sandbox. gVisor is the production design and has not had an independent
  security assessment, and the AWS deployment has not been applied.
- Do not claim a success rate from these few runs.
