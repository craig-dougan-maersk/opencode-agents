import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** Bookkeeping file kept next to the installed agents. Not `.md`, so it is never discovered. */
export const MANIFEST_FILE = ".opencode-agents.json"
export const COMMANDS_MANIFEST_FILE = ".opencode-commands.json"

export type InstallOutcome = "created" | "updated" | "unchanged" | "skipped" | "removed" | "custom" | "disabled"

/** On-disk state of one agent file, independent of whether OpenCode has loaded it. */
export type AgentState = "current" | "outdated" | "modified" | "missing" | "custom" | "disabled"

export interface AgentSource {
  /** File name inside the target directory, for example `scout.md`. */
  readonly file: string
  /** Rendered contents, placeholders already substituted. */
  readonly content: string
}

export interface Manifest {
  readonly version: string
  /** File name to sha256 of the contents this plugin wrote. */
  readonly files: Readonly<Record<string, string>>
  /** Bundled agent files edited by the user through the settings menu. Never overwritten on upgrade. */
  readonly custom: readonly string[]
  /** Bundled agent files the user removed. The installer leaves them out until they are restored. */
  readonly disabled: readonly string[]
}

export interface InstallResult {
  readonly targetDir: string
  readonly outcomes: Readonly<Record<string, InstallOutcome>>
  readonly written: readonly string[]
  readonly removed: readonly string[]
}

export interface InstallInput {
  readonly targetDir: string
  readonly sources: readonly AgentSource[]
  readonly version: string
  /** Overwrite files that were edited after installation. */
  readonly overwrite?: boolean
  /** Manifest file name inside the target directory. Defaults to MANIFEST_FILE. */
  readonly manifestFile?: string
}

/** Substitute `{{KEY}}` placeholders. A line consisting only of a placeholder that resolves to
 * an empty string is dropped, which keeps optional YAML fragments out of the frontmatter. */
export function render(template: string, vars: Readonly<Record<string, string>>): string {
  const out: string[] = []
  for (const line of template.split("\n")) {
    const only = line.trim().match(/^\{\{([A-Z0-9_]+)\}\}$/)
    if (only) {
      const value = vars[only[1]] ?? ""
      if (value === "") continue
      out.push(value)
      continue
    }
    out.push(line.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, key: string) => vars[key] ?? ""))
  }
  return out.join("\n")
}

/** Read every `.md` file in a directory as an installable agent source. */
export function loadSources(agentsDir: string, vars: Readonly<Record<string, string>>): AgentSource[] {
  return readdirSync(agentsDir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((file) => ({ file, content: render(readFileSync(join(agentsDir, file), "utf8"), vars) }))
}

export function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

export function readManifest(targetDir: string, manifestFile: string = MANIFEST_FILE): Manifest {
  const path = join(targetDir, manifestFile)
  if (!existsSync(path)) return { version: "", files: {}, custom: [], disabled: [] }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Manifest>
    return {
      version: typeof parsed.version === "string" ? parsed.version : "",
      files: parsed.files && typeof parsed.files === "object" ? parsed.files : {},
      custom: stringList(parsed.custom),
      disabled: stringList(parsed.disabled),
    }
  } catch {
    return { version: "", files: {}, custom: [], disabled: [] }
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
}

/** Persist a manifest. Values equal to the current file are not rewritten, so watchers stay quiet. */
export function writeManifest(targetDir: string, manifest: Manifest, manifestFile: string = MANIFEST_FILE): void {
  const next: Record<string, unknown> = { version: manifest.version, files: manifest.files }
  if (manifest.custom.length > 0) next.custom = [...manifest.custom].sort()
  if (manifest.disabled.length > 0) next.disabled = [...manifest.disabled].sort()
  writeIfChanged(join(targetDir, manifestFile), `${JSON.stringify(next, null, 2)}\n`)
}

/** Write only when the bytes differ, so a load that changes nothing does not wake the watcher. */
function writeIfChanged(path: string, contents: string): void {
  if (existsSync(path) && readFileSync(path, "utf8") === contents) return
  writeFileSync(path, contents)
}

/**
 * Install agent files into `targetDir`.
 *
 * A file the user customised through the settings menu, or a file that differs from what this
 * plugin last wrote, is left alone unless `overwrite` is set. Files this plugin installed that no
 * longer exist in `sources` are removed when they are still unmodified. Bundled files the user
 * removed are recorded as disabled and are not recreated.
 */
export function installAgents(input: InstallInput): InstallResult {
  const { targetDir, sources, version, overwrite = false } = input
  const manifestFile = input.manifestFile ?? MANIFEST_FILE
  const previous = readManifest(targetDir, manifestFile)
  const custom = new Set(previous.custom)
  const disabled = new Set(previous.disabled)
  const files: Record<string, string> = {}
  const outcomes: Record<string, InstallOutcome> = {}
  const written: string[] = []
  const removed: string[] = []

  mkdirSync(targetDir, { recursive: true })

  for (const source of sources) {
    if (disabled.has(source.file)) {
      outcomes[source.file] = "disabled"
      continue
    }

    const path = join(targetDir, source.file)
    const incoming = hash(source.content)
    const existing = existsSync(path) ? readFileSync(path, "utf8") : undefined
    const customised = custom.has(source.file) && !overwrite

    if (customised) {
      // User-owned content. Restore the shipped file only when it has been deleted outright.
      if (existing === undefined) {
        writeFileSync(path, source.content)
        outcomes[source.file] = "created"
        written.push(source.file)
      } else {
        outcomes[source.file] = "custom"
      }
      continue
    }

    if (custom.has(source.file) && overwrite) custom.delete(source.file)

    if (existing === undefined) {
      writeFileSync(path, source.content)
      outcomes[source.file] = "created"
      written.push(source.file)
      files[source.file] = incoming
      continue
    }

    if (existing === source.content) {
      outcomes[source.file] = "unchanged"
      files[source.file] = incoming
      continue
    }

    const recorded = previous.files[source.file]
    const unmodified = recorded !== undefined && hash(existing) === recorded
    if (overwrite || unmodified) {
      writeFileSync(path, source.content)
      outcomes[source.file] = "updated"
      written.push(source.file)
      files[source.file] = incoming
      continue
    }

    // Edited by the user after we wrote it. Keep their version and keep no claim on the file.
    outcomes[source.file] = "skipped"
    if (recorded !== undefined) files[source.file] = recorded
  }

  const keep = new Set(sources.map((source) => source.file))
  for (const [file, recorded] of Object.entries(previous.files)) {
    if (keep.has(file)) continue
    const path = join(targetDir, file)
    if (!existsSync(path)) continue
    if (hash(readFileSync(path, "utf8")) !== recorded) continue
    rmSync(path)
    outcomes[file] = "removed"
    removed.push(file)
  }

  writeManifest(targetDir, {
    version,
    files,
    custom: [...custom].filter((file) => keep.has(file)),
    disabled: [...disabled].filter((file) => keep.has(file)),
  }, manifestFile)

  return { targetDir, outcomes, written, removed }
}

/** Compare what is on disk with what this version of the plugin would write. */
export function agentStates(
  targetDir: string,
  sources: readonly AgentSource[],
  manifestFile: string = MANIFEST_FILE,
): Record<string, AgentState> {
  const manifest = readManifest(targetDir, manifestFile)
  const custom = new Set(manifest.custom)
  const disabled = new Set(manifest.disabled)
  const states: Record<string, AgentState> = {}

  for (const source of sources) {
    if (disabled.has(source.file)) {
      states[source.file] = "disabled"
      continue
    }

    const path = join(targetDir, source.file)
    if (!existsSync(path)) {
      states[source.file] = custom.has(source.file) ? "custom" : "missing"
      continue
    }
    if (custom.has(source.file)) {
      states[source.file] = "custom"
      continue
    }
    const existing = readFileSync(path, "utf8")
    if (existing === source.content) {
      states[source.file] = "current"
      continue
    }
    const recorded = manifest.files[source.file]
    states[source.file] = recorded !== undefined && hash(existing) === recorded ? "outdated" : "modified"
  }

  return states
}

/** Read the `model:` value out of a rendered agent file's frontmatter. */
export function modelOf(source: AgentSource): string {
  const match = source.content.match(/^model:\s*(.+)$/m)
  return match ? match[1].trim() : "inherited"
}
