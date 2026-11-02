# opencode-agents

An OpenCode V2 plugin that installs a two-tier agent team: one expensive
orchestrator that plans, decides and reviews, and cheap subagents that do the
retrieval, the typing and the test runs.

OpenCode has no built-in complexity router. This plugin gives you the structure
for one — a primary agent with a written triage policy, subagents whose
descriptions tell the model when to pick them, and permissions that decide which
subagents exist as options at all.

| Agent | Mode | Default model | Cost (in / out per Mtok) |
| --- | --- | --- | --- |
| `orchestrator` | primary | `anthropic/claude-opus-5-5#high` | $4 / $20 |
| `analyst` | subagent | `anthropic/claude-opus-5-5#xhigh` | $4 / $20 |
| `scout` | subagent | `opencode-go/deepseek-v4.1-flash#low` | $0.15 / $0.60 |
| `implementer` | subagent | `opencode-go/deepseek-v4.1-flash#low` | $0.15 / $0.60 |
| `verifier` | subagent | `opencode-go/deepseek-v4.1-flash#low` | $0.15 / $0.60 |
| `plan-step-executor` | subagent | `opencode-go/deepseek-v4.1-flash#low` | $0.15 / $0.60 |

That is roughly 27x on input and 33x on output between the tiers, so the point of
the setup is to keep the expensive model's context small and its turns few.

## Install

Add the plugin to `opencode.json` (global at `~/.config/opencode/opencode.json`,
or per project at `.opencode/opencode.json`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "default_agent": "orchestrator",
  "plugins": [
    {
      "package": "github:craig-dougan-maersk/opencode-agents",
      "options": {}
    }
  ]
}
```

Or, while developing it locally:

```jsonc
{
  "plugins": [{ "package": "/home/craig/plugins/opencode-agents" }]
}
```

Reload the config (or `/reload`). On first load the plugin writes five Markdown
agent files into `~/.config/opencode/agents/` and OpenCode picks them up.

`default_agent` is not something a plugin can set in your config file, so add
that line yourself: it is what makes a new session start on the orchestrator.
Without it, new sessions and `opencode run` start on `build`, and you pass
`--agent orchestrator` to opt in for a single run.

## What it installs

```
~/.config/opencode/agents/
├── orchestrator.md            primary, expensive, plans and reviews
├── analyst.md                 expensive, deep investigation when needed
├── scout.md                   read-only retrieval, no shell, no edits
├── implementer.md             mechanical edits only
├── verifier.md                runs builds and tests, fixes nothing
├── plan-step-executor.md      executes one pre-written step file
└── .opencode-agents.json      manifest of what this plugin wrote

~/.config/opencode/commands/
├── decompose-plan.md          /decompose-plan, the task-graph workflow
└── .opencode-commands.json    manifest of what this plugin wrote
```

The files are ordinary agent definitions — plain Markdown with YAML
frontmatter. Edit them if you like: the plugin records what it wrote, and a file
you have changed is never overwritten unless you set `overwrite: true`.

OpenCode's plugin API can update and remove agents but cannot create new ones, so
installation means writing these definition files into a directory OpenCode
already discovers. The plugin also registers the `/agents-status` command and the
`/agents` settings menu.

## Settings menu

Run `/agents`, or pick **Agents: manage** from the command palette (Ctrl+P), to
manage the agents directory without editing Markdown. Every field writes straight
back to the agent's `.md` file, and the server part reloads the agent registry so
the change applies without a restart.

- **List.** Every agent in the target directory: the bundled five, agents you
  created, and any `.md` files you already keep there. Each row shows mode, model
  and whether OpenCode has loaded it.
- **New agent.** Name, mode, model, description, permissions preset and
  instructions. The name is the file name and therefore the agent ID.
- **Edit.** Description, instructions, model, mode, colour, steps, hidden flag
  and permissions. Permissions offer presets (read-only, edits, edits + git,
  full access) and an add/edit/remove rule editor.
- **Model.** A searchable list of every enabled model available at the current
  location, grouped by provider, with input/output price and context window. When
  a model has variants, a second step picks `#low`, `#high`, and so on, or the
  model default. **Inherit from the session** leaves the `model` key out.
- **Instructions.** A full-screen editor for the Markdown body. Ctrl+S saves,
  Esc cancels.
- **Clone, rename, delete.** Renaming a bundled agent copies it to the new name
  and disables the original so the installer does not recreate it. Subagent
  permission rules that name the agent are rewritten; prose mentions are
  reported so you can update prompts yourself.
- **Reset and restore.** A customised bundled agent can be reset to the shipped
  version, and any bundled agent removed from the menu can be restored later.

The menu manages the directory selected by `install` and `directory` below. It
runs in the terminal, but the files are written by the server part through an
RPC method, so it also works when the terminal is attached to a remote server.

There is no default keybind. Bind `agents.settings` in `cli.json` if you want
one:

```jsonc
{
  "keybinds": { "agents.settings": "ctrl+shift+a" }
}
```


## Options

All options are optional.

| Option | Default | Meaning |
| --- | --- | --- |
| `install` | `"global"` | `"global"`, `"project"`, or `"none"` to install nothing. |
| `directory` | unset | Explicit target directory for the agent files. Supports `~`. Relative paths resolve against the project root. |
| `overwrite` | `false` | Replace agent files you edited by hand, including agents customised through `/agents`. |
| `strict` | `false` | Add an `edit: deny` rule to the orchestrator so every write must go through `implementer`. |
| `models.orchestrator` | `anthropic/claude-opus-5-5#high` | Model for `orchestrator`. |
| `models.cheap` | `opencode-go/deepseek-v4.1-flash#low` | Model for `scout`, `implementer`, `verifier`. |
| `models.analyst` | `anthropic/claude-opus-5-5#xhigh` | Model for `analyst`. |

Any `provider/model` reference may carry a `#variant`. Reasoning effort is the
second cost dial: `#low` for scouts and verifiers, `#high` for the orchestrator,
`#xhigh` reserved for the analyst.

Example with substitution:

```jsonc
{
  "plugins": [
    {
      "package": "github:craig-dougan-maersk/opencode-agents",
      "options": {
        "install": "project",
        "strict": true,
        "models": {
          "orchestrator": "anthropic/claude-opus-5-5#max",
          "cheap": "opencode-go/deepseek-v4.1-flash#low"
        }
      }
    }
  ]
}
```

Models are not checked for availability at install time. If a model is not
enabled for a project, that agent fails when it is first used. Run
`opencode models` to see the exact catalog IDs.

## How the decision gets made

Three layers, from soft to enforced:

1. **Descriptions.** A subagent's `description` is the only thing the choosing
   model sees when it picks one. Each one here is written as a routing
   instruction: `Use for … Do NOT use for … cheap`.
2. **The orchestrator's system prompt.** It carries the triage rubric — delegate
   by default, take the task itself when the requirement is ambiguous, when the
   change is cross-cutting, when a failure's cause is unknown, when the work
   touches concurrency, security, migrations or data loss, after a cheap agent
   has already failed once, and for the final review of a diff.
3. **Permissions.** The orchestrator may only launch the four named subagents,
   so the catalog cannot drift. With `strict: true` it also cannot edit, which
   makes delegation structural rather than advisory.

The loop this produces: the orchestrator writes a short spec, `implementer`
applies one bounded step, `verifier` reports, the orchestrator reviews the diff.
A subagent that finds itself out of its depth replies `ESCALATE: <reason>` and
the orchestrator takes over instead of retrying.

Subagents run in fresh child sessions, so every prompt has to carry absolute
paths, the exact change, the acceptance check and the return format. The
bundled prompts say so. Nesting depth is one by default, so cheap agents cannot
spawn further agents — escalation always returns to the orchestrator.

## Long tasks: `/decompose-plan`

The loop above is deliberately light: plan, dispatch one bounded step, verify,
review. For work that is too big for that — a feature spanning schema, service,
API and tests — use `/decompose-plan`. It replaces the Claude Code skill of the
same name and keeps the same split: the orchestrator plans on the expensive
model, `plan-step-executor` types on the cheap one.

```text
/decompose-plan Add OAuth login with Google to the Flask app
/decompose-plan run .plans/20261102-oauth-login
/decompose-status
```

What it does:

1. **Outline.** Investigate the codebase and write
   `.plans/<date>-<slug>/outline.md`: goal, non-goals, facts, decisions and
   level-1 steps.
2. **Break down.** Split each step until it passes the leaf test (one concern,
   ~3 files, no open decisions, mechanically verifiable). Leaves become
   `steps/<ID>.md`.
3. **Graph.** Write `graph.json` with dependencies and the files each leaf
   writes, then validate it.
4. **Dispatch.** Ask the task graph for ready tasks, start up to ten
   `plan-step-executor` subagents in parallel, spot-check each `RESULT: DONE`,
   and mark the task done or failed.
5. **Finish.** A final `VERIFY` leaf runs the full suite; a permanently failed
   task stops the run as `STUCK` and comes back to the orchestrator.

All progress lives in `graph.json`, so a run survives compaction, a new turn or
a restart. The state machine is a TypeScript port of the original
`taskgraph.py` — no Python dependency:

```sh
node <plugin>/dist/taskgraph-cli.js validate      .plans/20261102-oauth-login
node <plugin>/dist/taskgraph-cli.js ready         .plans/20261102-oauth-login --json
node <plugin>/dist/taskgraph-cli.js status        .plans/20261102-oauth-login
node <plugin>/dist/taskgraph-cli.js mark          .plans/20261102-oauth-login T2.1 done
node <plugin>/dist/taskgraph-cli.js reset-running .plans/20261102-oauth-login
```

`/decompose-status` runs the same check without spending model tokens: with a
path it prints that plan, without one it lists every plan under `.plans/`.

The command is installed as an ordinary Markdown command, so it is yours to
edit. The installer records what it wrote and will not overwrite your changes
unless `overwrite: true`.

## Commands

`/agents-status` reports, for each agent, its on-disk state, model and whether
OpenCode has actually loaded it:

| State | Meaning |
| --- | --- |
| `current` | matches this version of the plugin |
| `outdated` | replaced automatically on the next load |
| `modified` | edited locally; left alone unless `overwrite: true` |
| `custom` | edited through `/agents`; left alone unless `overwrite: true` |
| `disabled` | removed through `/agents`; restore it from the menu |
| `missing` | recreated on the next load |

The settings menu keeps two extra lists in `.opencode-agents.json`: `custom`
holds bundled files you changed through the menu, and `disabled` holds bundled
files you removed. Neither is touched by a plugin upgrade, and `/agents` can
reset or restore them.

`/decompose-plan [task | run <plan-dir>]` is the task-graph workflow described
above. `/decompose-status [plan-dir]` is deterministic — it reads `graph.json`
and prints the state without calling a model.

## Upgrading and uninstalling

Loading a newer version rewrites only files you have not edited, and removes
agents the package no longer ships (again, only if unmodified).

To uninstall, remove the plugin entry and delete the installed files:

```sh
rm ~/.config/opencode/agents/{orchestrator,analyst,scout,implementer,verifier,plan-step-executor}.md
rm ~/.config/opencode/agents/.opencode-agents.json
rm ~/.config/opencode/commands/decompose-plan.md
rm ~/.config/opencode/commands/.opencode-commands.json
```

## Development

```sh
npm install
npm test          # compiles, then runs installer and settings tests against a temp dir
npm run typecheck
```

`src/install.ts` holds the installer and templating logic with no OpenCode
dependency; `src/index.ts` is the server part: it installs the agent and command
files, registers `/agents-status` and `/decompose-status`, and serves the
settings RPC. `src/agent-file.ts` parses and serialises Markdown agents,
`src/agent-store.ts` owns create/update/clone/rename/delete/reset on disk,
`src/rpc.ts` is the contract shared by both parts, and `src/tui.tsx` is the
terminal settings menu. `src/taskgraph.ts` is the task-graph state machine and
`src/taskgraph-cli.ts` is its shell entry point. The Markdown in `agents/` and
`commands/` is the single source of truth, with `{{MODEL_*}}` and
`{{TASKGRAPH}}` placeholders substituted at install time.

The TUI part is compiled from TSX with `jsxImportSource: "@opentui/solid"`.
OpenCode supplies Solid and OpenTUI at runtime; they are optional peer
dependencies, so server-only installs do not pull them in.


## License

MIT
