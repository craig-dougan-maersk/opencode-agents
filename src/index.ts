import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"
import {
  type AgentSource,
  agentStates,
  installAgents,
  loadSources,
  modelOf,
  type InstallOutcome,
} from "./install.js"

const DEFAULT_MODELS = {
  orchestrator: "anthropic/claude-opus-5-5#high",
  cheap: "opencode-go/deepseek-v4.1-flash#low",
  analyst: "anthropic/claude-opus-5-5#xhigh",
} as const

const STRICT_RULES = ['  - action: edit', '    resource: "*"', "    effect: deny"].join("\n")

type InstallMode = "global" | "project" | "none"

interface Config {
  readonly install: InstallMode
  readonly directory?: string
  readonly overwrite: boolean
  readonly strict: boolean
  readonly models: { orchestrator: string; cheap: string; analyst: string }
}

function expandPath(value: string): string {
  if (value === "~") return homedir()
  if (value.startsWith("~/")) return join(homedir(), value.slice(2))
  return value
}

function resolveConfig(options: Readonly<Record<string, unknown>>): Config {
  const mode = options.install
  const install: InstallMode = mode === "project" || mode === "none" ? mode : "global"
  const models = (options.models ?? {}) as Record<string, unknown>
  const directory = typeof options.directory === "string" && options.directory.length > 0 ? options.directory : undefined

  return {
    install,
    directory,
    overwrite: options.overwrite === true,
    strict: options.strict === true,
    models: {
      orchestrator: typeof models.orchestrator === "string" ? models.orchestrator : DEFAULT_MODELS.orchestrator,
      cheap: typeof models.cheap === "string" ? models.cheap : DEFAULT_MODELS.cheap,
      analyst: typeof models.analyst === "string" ? models.analyst : DEFAULT_MODELS.analyst,
    },
  }
}

function globalAgentsDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  return xdg ? join(xdg, "opencode", "agents") : join(homedir(), ".config", "opencode", "agents")
}

function projectAgentsDir(projectDir: string): string {
  return join(projectDir, ".opencode", "agents")
}

function targetDirFor(config: Config, projectDir: string): string {
  if (config.directory) {
    const expanded = expandPath(config.directory)
    return isAbsolute(expanded) ? expanded : join(projectDir, expanded)
  }
  return config.install === "project" ? projectAgentsDir(projectDir) : globalAgentsDir()
}

function templateVars(config: Config): Record<string, string> {
  return {
    MODEL_ORCHESTRATOR: config.models.orchestrator,
    MODEL_CHEAP: config.models.cheap,
    MODEL_ANALYST: config.models.analyst,
    STRICT_EDIT_RULES: config.strict ? STRICT_RULES : "",
  }
}

function packageVersion(): string {
  try {
    const path = fileURLToPath(new URL("../package.json", import.meta.url))
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { version?: string }
    return parsed.version ?? "0.0.0"
  } catch {
    return "0.0.0"
  }
}

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
): Promise<string> {
  const states = agentStates(targetDir, sources)
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
    lines.push(`| \`${id}\` | ${states[source.file]} | \`${modelOf(source)}\` | ${loaded.has(id) ? "yes" : "no"} |`)
  }

  const problems: string[] = []
  for (const source of sources) {
    if (states[source.file] === "modified") problems.push(`\`${agentIdOf(source)}\` was edited locally; set \`overwrite\` to replace it.`)
    if (states[source.file] === "outdated") problems.push(`\`${agentIdOf(source)}\` is from an older version; it is replaced on the next load.`)
    if (states[source.file] === "missing") problems.push(`\`${agentIdOf(source)}\` is missing; it is recreated on the next load.`)
  }
  if (problems.length > 0) lines.push("", ...problems.map((problem) => `- ${problem}`))

  return lines.join("\n")
}

export default Plugin.define({
  id: "agents.orchestrator",
  async setup(context) {
    const config = resolveConfig(context.options)
    const version = packageVersion()
    const agentsDir = fileURLToPath(new URL("../agents", import.meta.url))
    const projectDir = context.location.project.canonical
    const targetDir = targetDirFor(config, projectDir)

    let sources: AgentSource[]
    try {
      sources = loadSources(agentsDir, templateVars(config))
    } catch (error) {
      console.log(`[opencode-agents] cannot read bundled agents from ${agentsDir}: ${error instanceof Error ? error.message : String(error)}`)
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

    await context.command.transform((editor) => {
      editor.add({
        name: "agents-status",
        description: "Show the installed orchestrator and subagent profiles",
        execute: async ({ sessionID }) => {
          const text = await statusReport(context, config, targetDir, sources)
          await context.session.synthetic({ sessionID, text })
        },
      })
    })
  },
})
