---
description: Plan a task as a disk-backed task graph, then run the leaf steps on cheap subagents. Use with a task description, or "run <plan-dir>" to resume a plan.
agent: orchestrator
---

# decompose-plan

Arguments: `$ARGUMENTS`

- If the first word is `run` → skip to **Phase 6** using the rest as `PLAN_DIR`.
- If the first word is `status` → run `TG status <dir>`, report it, and stop.
- Otherwise the arguments are the task. Start at **Phase 1**.

`TG` below means: `{{TASKGRAPH}}`

Standing rules for the whole run:

- All state lives on disk in the plan dir. After any compaction or new turn,
  re-read `graph.json` via `TG status` before acting. Never track progress in
  your head.
- You plan, dispatch, and judge. You do not implement leaf steps yourself
  unless a step has already failed twice.

## Phase 1 — Understand and outline

1. Create `.plans/<yyyymmdd>-<short-slug>/` in the project root, with a
   `steps/` subfolder. Call it `PLAN_DIR`.
2. Investigate the codebase yourself (read/grep/glob; `scout` subagents are
   fine for broad sweeps). Record concrete facts: file paths, existing
   patterns, test command, lint command, build command, language/version.
3. Write `PLAN_DIR/outline.md`:
   - Goal and explicit non-goals
   - Facts discovered (paths, commands, conventions)
   - Key design decisions, made now and stated as decisions
   - Level-1 steps `T1..Tn`, one line each, with dependencies
   - Risks / unknowns. If an unknown would change the design, ask the user
     now rather than guessing.

## Phase 2 — Level-1 detail

For each `Tn`, add a section to `outline.md`: what it produces, files
involved, interface/contract it exposes to other steps, how it is verified.

## Phase 3 — Recursive breakdown

For each step, apply the leaf test in **Appendix A**.

- Passes → it is a leaf. Write `PLAN_DIR/steps/<ID>.md` using the template in
  **Appendix B**.
- Fails → split into children (`T1.1`, `T1.2` …), record them under the
  parent in `outline.md`, and repeat on each child.
- Max depth is 3 (`T1.1.1`). A level-3 step that still fails the test means
  the parent is wrong: rewrite the parent's breakdown.

## Phase 4 — Review pass

Re-read every step file as if you were a cheap worker with no other context.
For each:

- Any vague verb ("handle", "update as needed", "clean up", "etc.")? Replace
  with exact instructions.
- Any name, signature, path or value left to the reader? Specify it.
- Does it rely on something from another step? That step must be in
  `depends_on`, and the exact symbol/path must be stated.
- Are the Verify commands real and runnable in this repo?

Fix in place. Split further if the review shows it is still too large
(respecting max depth).

## Phase 5 — Build and validate the graph

Write `PLAN_DIR/graph.json` containing ONLY leaf tasks, `"max_parallel": 10`,
`"max_attempts": 2`, and this shape:

```json
{
  "goal": "one line",
  "max_parallel": 10,
  "max_attempts": 2,
  "tasks": [
    {
      "id": "T2.1.3",
      "title": "Add retry wrapper to http client",
      "plan_file": "steps/T2.1.3.md",
      "depends_on": ["T1", "T2.1.1"],
      "writes": ["src/http/client.py"],
      "status": "pending",
      "attempts": 0,
      "notes": []
    }
  ]
}
```

- `depends_on`: real data/code dependencies only; a parent id (`T1`) expands
  to all leaves under it.
- `writes`: every file/dir the leaf creates or edits (must match the step's
  "Files to change"). The scheduler uses this to stop two parallel workers
  editing the same file.
- Add a final `VERIFY` leaf depending on all others: runs full tests/build,
  `writes: []`.

Run `TG validate PLAN_DIR`. Fix every ERROR. Resolve WARNs about shared
writes by merging leaves or adding an ordering dependency.

Then show the user a short summary: number of leaves, dependency levels,
widest level, and the plan path. Ask: "Run now / Stop so I can review the plan
files". If they choose stop, tell them to run `/decompose-plan run <PLAN_DIR>`
later, and end.

## Phase 6 — Dispatch loop

If entering here via `run`, first run `TG reset-running PLAN_DIR` (clears
tasks left `running` by an interrupted session), then `TG status PLAN_DIR`.

Loop:

1. `TG ready PLAN_DIR --json` → list of ready tasks (already limited to free
   slots and non-clashing writes).
2. For each ready task, in the same message:
   - `TG mark PLAN_DIR <id> running`
   - Call the `subagent` tool with `agent: "plan-step-executor"` and a prompt
     that is exactly:
     `Execute the step plan in <absolute PLAN_DIR>/steps/<id>.md. Follow it exactly.`
   - If the ready entry has `"escalate": true` (a retry), append the previous
     failure note to the prompt.
   - Run them in the background (`background: true`) so they run in parallel.
3. End your turn after dispatching; each completion arrives as a notification.
   If a subagent call returns its result inline instead, handle it immediately
   and continue the loop.
4. On each completion:
   - Parse the worker's final line: `RESULT: DONE`, `RESULT: FAILED: …`, or
     `RESULT: BLOCKED: …`.
   - DONE → spot-check: run the step's Verify commands yourself (they are
     cheap). Pass → `TG mark PLAN_DIR <id> done`. Fail → `TG mark PLAN_DIR <id>
     failed --note "<why>"`.
   - FAILED/BLOCKED → `TG mark PLAN_DIR <id> failed --note "<reason>"`. If
     BLOCKED is caused by a flaw in the step plan, fix the step file before it
     retries.
   - Then go back to step 1 of this loop.
5. Stop looping when `TG status` prints `STATE: COMPLETE` or `STATE: STUCK`.

Never run more than 10 workers at once; `TG ready` enforces this as long as
every dispatch is preceded by `mark running`.

## Phase 7 — Finish

- COMPLETE: run the project's full test/lint/build yourself. Summarise changes
  by level-1 step, and list anything the workers reported as notes.
- STUCK: list permanently failed tasks with their notes and the tasks they
  block. For each, either fix it yourself (you are allowed to now), rewrite
  its step plan and `TG mark <id> pending`, or ask the user. Then resume
  Phase 6.

## Appendix A — When is a step small enough?

A step is a LEAF only if ALL are true. Otherwise split it.

1. **One concern.** Describable in one imperative sentence without "and".
2. **Small footprint.** Creates/edits at most ~3 files and ~150 changed lines.
3. **No open decisions.** Every name, signature, file path, library, data
   shape and error behaviour is stated. A reader could not reasonably make a
   different design choice.
4. **Self-contained context.** Everything needed is in the step file or in
   files listed under "Read first" (and those files exist now, or are created
   by a declared dependency).
5. **Mechanically verifiable.** At least one command whose exit code proves it
   worked (test, import, lint, build, curl, grep).
6. **Bounded effort.** A competent junior could do it in under ~30 minutes.

How to split:

- Split along files or layers first (schema → model → service → API → tests).
- Put shared contracts (types, interfaces, config keys, DB schema) in their
  own early step so later steps can depend on them and run in parallel.
- Tests: either in the same leaf as the code (small) or a sibling leaf that
  depends on it. Never "write all tests" as one leaf.
- Pure investigation ("find where X is configured") is NOT a worker task. Do
  it yourself during planning and write the answer into the step files.

Depth and IDs:

- Level 1: `T1`, `T2`, … (from the outline)
- Level 2: `T1.1`, `T1.2`, …
- Level 3: `T1.1.1`, … — maximum depth. If a level-3 step still fails the leaf
  test, the outline is wrong: revise the parent instead of going deeper.
- Only leaves go into `graph.json`. A dependency on a parent id (`T1`) means
  "all leaves under T1".

Dependency rules:

- Add a dependency only when B reads, imports, extends or tests something A
  creates. Do not chain steps "for safety" — that kills parallelism.
- Two leaves that edit the same file without a real dependency: the scheduler
  will serialise them, but prefer merging them into one leaf or ordering them
  explicitly so edits don't conflict.
- Final leaf: a `VERIFY` task depending on everything that runs the full test
  suite / build.

## Appendix B — Step plan template

Write every leaf task to `steps/<ID>.md` using exactly these sections. The
reader is a small model with NO access to the conversation, the outline, or
other step files unless you list them under "Read first". Anything not written
here does not exist for it.

````markdown
# <ID>: <imperative title>

## Goal
One or two sentences: what is true when this step is finished.

## Context
- Why this step exists (1-3 bullets, only what affects how it is done).
- Decisions already made that it must follow (library, pattern, naming).

## Read first
- `path/to/file.py` lines 40-95 — the function you will extend
- `path/to/other.py` — the interface you must match

## Files to change
- CREATE `src/pkg/retry.py`
- EDIT `src/pkg/client.py`
(Must match `writes` in graph.json exactly. Touch nothing else.)

## Instructions
1. In `src/pkg/retry.py`, create function
   `def with_retry(fn: Callable[[], T], attempts: int = 3, backoff: float = 0.5) -> T:`
   - Loop `attempts` times; on `httpx.TransportError` sleep `backoff * 2**i`.
   - Re-raise the last exception after the final attempt.
2. In `src/pkg/client.py`, inside `Client.get` (around line 72), replace
   `resp = self._session.get(url)` with
   `resp = with_retry(lambda: self._session.get(url))`
   and add `from .retry import with_retry` to the imports.

Every step names the file, the symbol, the exact signature/value. No "as
appropriate", "handle errors properly", "etc.".

## Verify
Run each command; all must pass before reporting DONE.
- `python -m pytest tests/test_retry.py -q` → exit 0
- `python -c "from pkg.retry import with_retry"` → no output, exit 0
- `ruff check src/pkg/retry.py` → exit 0

## Out of scope
- Do not change public signatures other than those above.
- Do not add dependencies.
- Do not refactor surrounding code or fix unrelated lint.

## If blocked
If an instruction cannot be followed as written (file/symbol missing, test
failing for an unrelated reason, ambiguity), STOP. Do not improvise a design.
Report BLOCKED with the exact reason.
````

Worked contrast:

- Too high level (split it further): "Add retry logic to the HTTP client and
  update tests."
- Leaf: the example above — two named files, exact signature, exact
  replacement line, three runnable checks.
