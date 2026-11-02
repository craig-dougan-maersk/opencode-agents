import { Plugin } from "@opencode/plugin"
import { existsSync, readdirSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { AgentStore, AgentStoreError } from "./agent-store.js"
import type { AgentConfig, AgentConfigPatch, AgentMode, PermissionRule } from "./agent-file.js"
import {
  bundledAgentsDir,
  bundledCommandsDir,
  commandsTargetDirFor,
  packageVersion,
  resolveConfig,
  targetDirFor,
  templateVars,
  type Config,
} from "./config.js"
import {
  type AgentSource,
  agentStates,
  COMMANDS_MANIFEST_FILE,
  installAgents,
  loadSources,
  modelOf,
  type InstallOutcome,
} from "./install.js"
import { AgentsRpc, entryData, type AgentsListData } from "./rpc.js"
import { status as graphStatus } from "./taskgraph.js"

function agentIdOf(source: AgentSource): string {
  return source.file.replace(/\.md$/, "")
}

function describeOutcomes(outcomes: Readonly<Record<string, InstallOutcome>>): string {
  const groups = new Map<InstallOutcome, string[]>()
  for (const [file, outcome] of Object.entries(outcomes)) {
    const list = groups.get(outcome) ?? []
    list.push(file.replace(/\.md$/, ""))
    groups.set(outcome, list)
  }
  return [...groups.entries()].map(([outcome, ids]) => `${outcome}: ${ids.join(", ")}`).join("; ")
}

async function statusReport(
  context: Plugin.Context,
  config: Config,
  targetDir: string,
  sources: readonly AgentSource[],
  commandsTargetDir: string,
  commandSources: readonly AgentSource[],
): Promise<string> {
  const states = agentStates(targetDir, sources)
  const commandStates = agentStates(commandsTargetDir, commandSources, COMMANDS_MANIFEST_FILE)
  const loaded = new Set<string>()
  try {
    const list = await context.agent.list()
    for (const agent of list.data) loaded.add(agent.id)
  } catch {
    // Listing is best-effort: the report still works when the agent registry is unavailable.
  }

  const lines = [
    "## Orchestrator agents",
    "",
    `Target: \`${targetDir}\``,
    `Strict mode: ${config.strict ? "on (orchestrator cannot edit)" : "off"}`,
    "",
    "| Agent | File | Model | Loaded |",
    "| --- | --- | --- | --- |",
  ]

  for (const source of sources) {
    const id = agentIdOf(source)
    lines.push(`| \`${id}\` | ${states[source.file]} | \`${modelOf(source)}\` | ${loaded.has(id) ? "yes" : "no"}`)
  }

  if (commandSources.length > 0) {
    lines.push("", "## Commands", "", `Target: \`${commandsTargetDir}\``, "", "| Command | State |", "| --- | --- |")
    for (const source of commandSources) {
      lines.push(`| \`/${agentIdOf(source)}\` | ${commandStates[source.file]} |`)
    }
  }

  const problems: string[] = []
  for (const source of sources) {
    if (states[source.file] === "modified") problems.push(`\`${agentIdOf(source)}\` was edited locally; set \`overwrite\` to replace it.`)
    if (states[source.file] === "outdated") problems.push(`\`${agentIdOf(source)}\` is from an older version; it is replaced on the next load.`)
    if (states[source.file] === "missing") problems.push(`\`${agentIdOf(source)}\` is missing; it is recreated on the next load.`)
    if (states[source.file] === "custom") problems.push(`\`${agentIdOf(source)}\` is customised and kept as-is; run \`/agents\` to reset it.`)
    if (states[source.file] === "disabled") problems.push(`\`${agentIdOf(source)}\` is disabled; run \`/agents\` to restore it.`)
  }
  if (problems.length > 0) lines.push("", ...problems.map((problem) => `- ${problem}`))
  lines.push("", "Use `/agents` (or the command palette) to manage agents.")
  return lines.join("\n")
}

/** Deterministic `/decompose-status`: an explicit plan dir, or a summary of every plan under `.plans/`. */
function decomposeStatusText(baseDir: string, argument: string): string {
  const tokens = argument
    .split(/\s+/)
    .map((token) => token.replace(/^[`'"]+|[`'"]+$/g, ""))
    .filter((token) => token.length > 0)
  const explicit = tokens
    .map((token) => (isAbsolute(token) ? token : join(baseDir, token)))
    .find((dir) => existsSync(join(dir, "graph.json")))

  if (explicit !== undefined) {
    try {
      return graphStatus(explicit).lines.join("\n")
    } catch (error) {
      return `Cannot read \`${explicit}/graph.json\`: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  const plansDir = join(baseDir, ".plans")
  if (!existsSync(plansDir)) return `No plan directory at \`${plansDir}\`.`

  const lines: string[] = []
  for (const entry of readdirSync(plansDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(plansDir, entry.name)
    if (!existsSync(join(dir, "graph.json"))) continue
    try {
      const result = graphStatus(dir)
      lines.push(`- \`${entry.name}\` — ${result.lines.at(-1) ?? "STATE: UNKNOWN"}`)
    } catch (error) {
      lines.push(`- \`${entry.name}\` — unreadable: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (lines.length === 0) return `No task graphs under \`${plansDir}\`.`
  return ["## decompose-plan", "", ...lines].join("\n")
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const found = value[key]
  if (typeof found !== "string" || found.length === 0) throw new Error(`'${key}' is required`)
  return found
}

function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  const found = value[key]
  return typeof found === "string" ? found : undefined
}

function modeOf(value: unknown): AgentMode {
  return value === "primary" || value === "subagent" || value === "all" ? value : "primary"
}

function permissionRules(value: unknown): PermissionRule[] {
  if (!Array.isArray(value)) return []
  const rules: PermissionRule[] = []
  for (const entry of value) {
    const record = asRecord(entry, "permission rule")
    const action = optionalString(record, "action")
    const resource = optionalString(record, "resource")
    const effect = record.effect
    if (action === undefined || resource === undefined) continue
    if (effect !== "allow" && effect !== "ask" && effect !== "deny") continue
    rules.push({ action, resource, effect })
  }
  return rules
}

function configFromInput(value: unknown): AgentConfig {
  const input = asRecord(value, "config")
  return {
    description: optionalString(input, "description"),
    mode: modeOf(input.mode),
    model: optionalString(input, "model"),
    color: optionalString(input, "color"),
    steps: typeof input.steps === "number" ? input.steps : undefined,
    hidden: input.hidden === true,
    permissions: permissionRules(input.permissions),
  }
}

function patchFromInput(value: unknown): AgentConfigPatch {
  const input = asRecord(value, "config")
  const patch: AgentConfigPatch = {}
  if ("description" in input) patch.description = optionalString(input, "description") ?? ""
  if ("mode" in input) patch.mode = modeOf(input.mode)
  if ("model" in input) patch.model = optionalString(input, "model") ?? ""
  if ("color" in input) patch.color = optionalString(input, "color") ?? ""
  if ("steps" in input) patch.steps = typeof input.steps === "number" ? input.steps : 0
  if ("hidden" in input) patch.hidden = input.hidden === true
  if ("permissions" in input) patch.permissions = permissionRules(input.permissions)
  return patch
}

export default Plugin.define({
  id: "agents.orchestrator",
  async setup(context) {
    const config = resolveConfig(context.options)
    const version = packageVersion()
    const projectDir = context.location.project.canonical
    const targetDir = targetDirFor(config, projectDir)
    const sourcesDir = bundledAgentsDir()

    let sources: AgentSource[]
    try {
      sources = loadSources(sourcesDir, templateVars(config))
    } catch (error) {
      console.log(`[opencode-agents] cannot read bundled agents from ${sourcesDir}: ${error instanceof Error ? error.message : String(error)}`)
      return
    }

    if (config.install === "none") {
      console.log(`[opencode-agents] install disabled; agents are expected in ${targetDir}`)
    } else {
      try {
        const result = installAgents({
          targetDir,
          sources,
          version,
          overwrite: config.overwrite,
        })
        if (result.written.length > 0 || result.removed.length > 0) {
          console.log(`[opencode-agents] ${describeOutcomes(result.outcomes)} -> ${result.targetDir}`)
          await context.agent.reload()
        }
      } catch (error) {
        console.log(`[opencode-agents] install failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    const commandsTargetDir = commandsTargetDirFor(config, projectDir)
    let commandSources: AgentSource[] = []
    if (config.install !== "none") {
      try {
        commandSources = loadSources(bundledCommandsDir(), templateVars(config))
        const result = installAgents({
          targetDir: commandsTargetDir,
          sources: commandSources,
          version,
          overwrite: config.overwrite,
          manifestFile: COMMANDS_MANIFEST_FILE,
        })
        if (result.written.length > 0 || result.removed.length > 0) {
          console.log(`[opencode-agents] commands: ${describeOutcomes(result.outcomes)} -> ${result.targetDir}`)
          await context.command.reload()
        }
      } catch (error) {
        console.log(`[opencode-agents] command install failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    const bundled = new Map(sources.map((source) => [agentIdOf(source), source.content]))
    const store = new AgentStore(targetDir, bundled)

    const snapshot = async (): Promise<AgentsListData> => {
      const loaded = new Set<string>()
      try {
        const list = await context.agent.list()
        for (const agent of list.data) loaded.add(agent.id)
      } catch {
        // The menu still works when the agent registry is unavailable.
      }
      // Strip explicit undefined values so every returned shape satisfies the RPC schema.
      const data: AgentsListData = {
        targetDir,
        agents: store.list().map((entry) => entryData(entry, loaded.has(entry.id))),
      }
      return JSON.parse(JSON.stringify(data)) as AgentsListData
    }
    const afterMutation = async (): Promise<AgentsListData> => {
      try {
        await context.agent.reload()
      } catch (error) {
        console.log(`[opencode-agents] reload after a settings change failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      return snapshot()
    }

    const handlers = {
      list: async () => snapshot(),
      read: async (input: unknown, rpcContext: RpcCall) => {
        try {
          const body = asRecord(input, "input")
          const id = requiredString(body, "id")
          return { id, instructions: store.instructions(id) }
        } catch (error) {
          return report(rpcContext, error)
        }
      },
      update: async (input: unknown, rpcContext: RpcCall) => {
        try {
          const body = asRecord(input, "input")
          const id = requiredString(body, "id")
          const instructions = typeof body.instructions === "string" ? body.instructions : undefined
          const patch = body.config === undefined ? {} : patchFromInput(body.config)
          store.update(id, patch, instructions)
          return await afterMutation()
        } catch (error) {
          return report(rpcContext, error)
        }
      },
      create: async (input: unknown, rpcContext: RpcCall) => {
        try {
          const body = asRecord(input, "input")
          const id = requiredString(body, "id")
          const agentConfig = configFromInput(body.config)
          const instructions = typeof body.instructions === "string" ? body.instructions : ""
          store.create(id, agentConfig, instructions)
          return await afterMutation()
        } catch (error) {
          return report(rpcContext, error)
        }
      },
      clone: async (input: unknown, rpcContext: RpcCall) => {
        try {
          const body = asRecord(input, "input")
          store.clone(requiredString(body, "from"), requiredString(body, "to"))
          return await afterMutation()
        } catch (error) {
          return report(rpcContext, error)
        }
      },
      rename: async (input: unknown, rpcContext: RpcCall) => {
        try {
          const body = asRecord(input, "input")
          const result = store.rename(requiredString(body, "from"), requiredString(body, "to"))
          return { ...(await afterMutation()), updated: [...result.updated], warnings: [...result.warnings] }
        } catch (error) {
          return report(rpcContext, error)
        }
      },
      remove: async (input: unknown, rpcContext: RpcCall) => {
        try {
          const body = asRecord(input, "input")
          store.remove(requiredString(body, "id"))
          return await afterMutation()
        } catch (error) {
          return report(rpcContext, error)
        }
      },
      reset: async (input: unknown, rpcContext: RpcCall) => {
        try {
          const body = asRecord(input, "input")
          store.reset(requiredString(body, "id"))
          return await afterMutation()
        } catch (error) {
          return report(rpcContext, error)
        }
      },
      restore: async (_input: unknown, rpcContext: RpcCall) => {
        try {
          const restored = store.restoreDisabled()
          return { ...(await afterMutation()), restored }
        } catch (error) {
          return report(rpcContext, error)
        }
      },
    }

    try {
      await context.rpc.register(AgentsRpc, handlers)
    } catch (error) {
      console.log(`[opencode-agents] settings menu unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }

    await context.command.transform((editor) => {
      editor.add({
        name: "agents-status",
        description: "Show the installed orchestrator and subagent profiles",
        execute: async ({ sessionID }) => {
          const text = await statusReport(context, config, targetDir, sources, commandsTargetDir, commandSources)
          await context.session.synthetic({ sessionID, text })
        },
      })
      editor.add({
        name: "decompose-status",
        description: "Show the state of decompose-plan task graphs",
        execute: async ({ sessionID, prompt }) => {
          await context.session.synthetic({ sessionID, text: decomposeStatusText(projectDir, prompt.text) })
        },
      })
    })
  },
})

type RpcCall = { error: (...args: never[]) => unknown }

function report(rpcContext: RpcCall, error: unknown): unknown {
  if (error instanceof AgentStoreError) {
    const fail = rpcContext.error as (type: string, message: string, data: unknown) => unknown
    return fail(error.kind, error.message, {})
  }
  throw error
}
