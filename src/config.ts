import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"

export const DEFAULT_MODELS = {
  orchestrator: "anthropic/claude-opus-5-5#high",
  cheap: "opencode-go/deepseek-v4.1-flash#low",
  analyst: "anthropic/claude-opus-5-5#xhigh",
} as const

export const STRICT_RULES = ['  - action: edit', '    resource: "*"', "    effect: deny"].join("\n")

export type InstallMode = "global" | "project" | "none"

export interface Config {
  readonly install: InstallMode
  readonly directory?: string
  readonly overwrite: boolean
  readonly strict: boolean
  readonly models: { orchestrator: string; cheap: string; analyst: string }
}

export function expandPath(value: string): string {
  if (value === "~") return homedir()
  if (value.startsWith("~/")) return join(homedir(), value.slice(2))
  return value
}

export function resolveConfig(options: Readonly<Record<string, unknown>>): Config {
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

function configRoot(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  return xdg ? join(xdg, "opencode") : join(homedir(), ".config", "opencode")
}

export function globalAgentsDir(): string {
  return join(configRoot(), "agents")
}

export function projectAgentsDir(projectDir: string): string {
  return join(projectDir, ".opencode", "agents")
}

export function globalCommandsDir(): string {
  return join(configRoot(), "commands")
}

export function projectCommandsDir(projectDir: string): string {
  return join(projectDir, ".opencode", "commands")
}

export function targetDirFor(config: Config, projectDir: string): string {
  if (config.directory) {
    const expanded = expandPath(config.directory)
    return isAbsolute(expanded) ? expanded : join(projectDir, expanded)
  }
  return config.install === "project" ? projectAgentsDir(projectDir) : globalAgentsDir()
}

/** Commands always live in the standard discovery directories; `directory` only moves agents. */
export function commandsTargetDirFor(config: Config, projectDir: string): string {
  return config.install === "project" ? projectCommandsDir(projectDir) : globalCommandsDir()
}

/** The absolute `node <file>` invocation the installed command uses to drive the task graph. */
export function taskgraphCommand(): string {
  return `node "${fileURLToPath(new URL("./taskgraph-cli.js", import.meta.url))}"`
}

export function templateVars(config: Config): Record<string, string> {
  return {
    MODEL_ORCHESTRATOR: config.models.orchestrator,
    MODEL_CHEAP: config.models.cheap,
    MODEL_ANALYST: config.models.analyst,
    STRICT_EDIT_RULES: config.strict ? STRICT_RULES : "",
    TASKGRAPH: taskgraphCommand(),
  }
}

export function bundledAgentsDir(): string {
  return fileURLToPath(new URL("../agents", import.meta.url))
}

export function bundledCommandsDir(): string {
  return fileURLToPath(new URL("../commands", import.meta.url))
}

export function packageVersion(): string {
  try {
    const path = fileURLToPath(new URL("../package.json", import.meta.url))
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { version?: string }
    return parsed.version ?? "0.0.0"
  } catch {
    return "0.0.0"
  }
}
