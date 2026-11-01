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
└── .opencode-agents.json      manifest of what this plugin wrote
```

The files are ordinary agent definitions — plain Markdown with YAML
frontmatter. Edit them if you like: the plugin records what it wrote, and a file
you have changed is never overwritten unless you set `overwrite: true`.

OpenCode's plugin API can update and remove agents but cannot create new ones, so
installation means writing these definition files into a directory OpenCode
already discovers. The plugin also registers the `/agents-status` command.

## Options

All options are optional.

| Option | Default | Meaning |
| --- | --- | --- |
| `install` | `"global"` | `"global"`, `"project"`, or `"none"` to install nothing. |
| `directory` | unset | Explicit target directory for the agent files. Supports `~`. Relative paths resolve against the project root. |
| `overwrite` | `false` | Replace agent files you edited by hand. |
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

## Commands

`/agents-status` reports, for each agent, its on-disk state, model and whether
OpenCode has actually loaded it:

| State | Meaning |
| --- | --- |
| `current` | matches this version of the plugin |
| `outdated` | replaced automatically on the next load |
| `modified` | edited locally; left alone unless `overwrite: true` |
| `missing` | recreated on the next load |

## Upgrading and uninstalling

Loading a newer version rewrites only files you have not edited, and removes
agents the package no longer ships (again, only if unmodified).

To uninstall, remove the plugin entry and delete the installed files:

```sh
rm ~/.config/opencode/agents/{orchestrator,analyst,scout,implementer,verifier}.md
rm ~/.config/opencode/agents/.opencode-agents.json
```

## Development

```sh
npm install
npm test          # compiles, then runs the installer tests against a temp dir
npm run typecheck
```

`src/install.ts` holds the installer and templating logic with no OpenCode
dependency; `src/index.ts` is the thin plugin wrapper. The Markdown in `agents/`
is the single source of truth, with `{{MODEL_*}}` placeholders substituted at
install time.

## License

MIT
