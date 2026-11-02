import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parseAgentFile, parseModelRef, serializeAgentFile, validateId } from "../dist/agent-file.js"
import { AgentStore } from "../dist/agent-store.js"
import { mark, readyTasks, resetRunning, status, validate } from "../dist/taskgraph.js"
import { bundledCommandsDir, resolveConfig, templateVars } from "../dist/config.js"
import {
  COMMANDS_MANIFEST_FILE,
  MANIFEST_FILE,
  agentStates,
  installAgents,
  loadSources,
  modelOf,
  readManifest,
  render,
} from "../dist/install.js"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-agents-test-"))
let failures = 0
const cases = []

function test(name, fn) {
  cases.push({ name, fn })
}

const source = (file, content) => ({ file, content })

async function planDir(name, graph, files = {}) {
  const dir = path.join(root, name)
  await fs.mkdir(path.join(dir, "steps"), { recursive: true })
  for (const [file, body] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, "steps", file), body)
  }
  await fs.writeFile(path.join(dir, "graph.json"), JSON.stringify(graph, null, 2))
  return dir
}

test("render substitutes placeholders", () => {
  const out = render("model: {{MODEL}}\nsteps: {{STEPS}}", { MODEL: "a/b#low", STEPS: "4" })
  assert.equal(out, "model: a/b#low\nsteps: 4")
})

test("render drops a line whose placeholder resolves to empty", () => {
  const out = render(["a: 1", "{{EXTRA}}", "b: 2"].join("\n"), { EXTRA: "" })
  assert.equal(out, "a: 1\nb: 2")
})

test("render keeps a multi-line placeholder value", () => {
  const out = render(["a: 1", "{{EXTRA}}", "b: 2"].join("\n"), { EXTRA: "  - x\n  - y" })
  assert.equal(out, "a: 1\n  - x\n  - y\nb: 2")
})

test("loadSources renders markdown files in name order", async () => {
  const dir = path.join(root, "sources")
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, "b.md"), "model: {{M}}")
  await fs.writeFile(path.join(dir, "a.md"), "model: {{M}}")
  await fs.writeFile(path.join(dir, "notes.txt"), "ignored")

  const sources = loadSources(dir, { M: "p/m" })
  assert.deepEqual(
    sources.map((entry) => entry.file),
    ["a.md", "b.md"],
  )
  assert.equal(sources[0].content, "model: p/m")
})

test("install creates every file and records a manifest", async () => {
  const dir = path.join(root, "fresh")
  const sources = [source("one.md", "A"), source("two.md", "B")]
  const result = installAgents({ targetDir: dir, sources, version: "1.0.0" })

  assert.deepEqual(result.outcomes, { "one.md": "created", "two.md": "created" })
  assert.deepEqual(result.written.sort(), ["one.md", "two.md"])
  assert.equal(await fs.readFile(path.join(dir, "one.md"), "utf8"), "A")

  const manifest = readManifest(dir)
  assert.equal(manifest.version, "1.0.0")
  assert.deepEqual(Object.keys(manifest.files).sort(), ["one.md", "two.md"])
  assert.ok(manifest.files["one.md"].length === 64)
})

test("a second identical install changes nothing", async () => {
  const dir = path.join(root, "idempotent")
  const sources = [source("one.md", "A")]
  installAgents({ targetDir: dir, sources, version: "1.0.0" })

  const before = await fs.readFile(path.join(dir, MANIFEST_FILE), "utf8")
  const again = installAgents({ targetDir: dir, sources, version: "1.0.0" })

  assert.deepEqual(again.outcomes, { "one.md": "unchanged" })
  assert.deepEqual(again.written, [])
  assert.equal(await fs.readFile(path.join(dir, MANIFEST_FILE), "utf8"), before)
})

test("an unedited file is replaced when the plugin ships new content", async () => {
  const dir = path.join(root, "upgrade")
  installAgents({ targetDir: dir, sources: [source("one.md", "v1")], version: "1.0.0" })

  const result = installAgents({ targetDir: dir, sources: [source("one.md", "v2")], version: "2.0.0" })

  assert.deepEqual(result.outcomes, { "one.md": "updated" })
  assert.equal(await fs.readFile(path.join(dir, "one.md"), "utf8"), "v2")
})

test("a user-edited file is left alone unless overwrite is set", async () => {
  const dir = path.join(root, "edited")
  installAgents({ targetDir: dir, sources: [source("one.md", "v1")], version: "1.0.0" })
  await fs.writeFile(path.join(dir, "one.md"), "my own version")

  const kept = installAgents({ targetDir: dir, sources: [source("one.md", "v2")], version: "1.0.1" })
  assert.deepEqual(kept.outcomes, { "one.md": "skipped" })
  assert.equal(await fs.readFile(path.join(dir, "one.md"), "utf8"), "my own version")

  const forced = installAgents({ targetDir: dir, sources: [source("one.md", "v2")], version: "1.0.1", overwrite: true })
  assert.deepEqual(forced.outcomes, { "one.md": "updated" })
  assert.equal(await fs.readFile(path.join(dir, "one.md"), "utf8"), "v2")
})

test("a file the user created before install is not claimed or overwritten", async () => {
  const dir = path.join(root, "pre-existing")
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, "one.md"), "hand written")

  const result = installAgents({ targetDir: dir, sources: [source("one.md", "shipped")], version: "1.0.0" })

  assert.deepEqual(result.outcomes, { "one.md": "skipped" })
  assert.equal(await fs.readFile(path.join(dir, "one.md"), "utf8"), "hand written")
  assert.equal(readManifest(dir).files["one.md"], undefined)
})

test("agents that disappear from the package are removed when unmodified", async () => {
  const dir = path.join(root, "prune")
  installAgents({
    targetDir: dir,
    sources: [source("keep.md", "K"), source("drop.md", "D")],
    version: "1.0.0",
  })

  const result = installAgents({ targetDir: dir, sources: [source("keep.md", "K")], version: "2.0.0" })

  assert.deepEqual(result.outcomes, { "keep.md": "unchanged", "drop.md": "removed" })
  assert.deepEqual(result.removed, ["drop.md"])
  await assert.rejects(fs.access(path.join(dir, "drop.md")))
})

test("agents that disappear but were edited are kept", async () => {
  const dir = path.join(root, "prune-edited")
  installAgents({
    targetDir: dir,
    sources: [source("keep.md", "K"), source("drop.md", "D")],
    version: "1.0.0",
  })
  await fs.writeFile(path.join(dir, "drop.md"), "still mine")

  const result = installAgents({ targetDir: dir, sources: [source("keep.md", "K")], version: "2.0.0" })

  assert.equal(result.outcomes["drop.md"], undefined)
  assert.equal(await fs.readFile(path.join(dir, "drop.md"), "utf8"), "still mine")
})

test("agentStates distinguishes current, outdated, modified and missing", async () => {
  const dir = path.join(root, "states")
  installAgents({
    targetDir: dir,
    sources: [source("current.md", "C"), source("outdated.md", "O"), source("modified.md", "M")],
    version: "1.0.0",
  })
  await fs.writeFile(path.join(dir, "modified.md"), "mine")

  const states = agentStates(dir, [
    source("current.md", "C"),
    source("outdated.md", "O2"),
    source("modified.md", "M2"),
    source("missing.md", "X"),
  ])

  assert.deepEqual(states, {
    "current.md": "current",
    "outdated.md": "outdated",
    "modified.md": "modified",
    "missing.md": "missing",
  })
})

test("modelOf reads the frontmatter model line", () => {
  assert.equal(modelOf(source("a.md", "---\nmodel: p/m#high\n---\n")), "p/m#high")
  assert.equal(modelOf(source("b.md", "---\nmode: primary\n---\n")), "inherited")
})

test("parseAgentFile reads known fields and keeps unknown frontmatter", () => {
  const text = [
    "---",
    "description: Cheap retrieval",
    "mode: subagent",
    "model: opencode-go/deepseek-v4.1-flash#low",
    'color: "#4ec9b0"',
    "steps: 12",
    "keepMe: true",
    "permissions:",
    '  - action: edit',
    '    resource: "*"',
    "    effect: deny",
    "---",
    "",
    "Answer only the question you were asked.",
    "",
  ].join("\n")

  const document = parseAgentFile(text)
  assert.equal(document.config.mode, "subagent")
  assert.equal(document.config.model, "opencode-go/deepseek-v4.1-flash#low")
  assert.equal(document.config.color, "#4ec9b0")
  assert.equal(document.config.steps, 12)
  assert.deepEqual(document.config.permissions, [{ action: "edit", resource: "*", effect: "deny" }])
  assert.equal(document.extra.keepMe, true)
  assert.match(document.instructions, /Answer only/)
})

test("serializeAgentFile round-trips the document and writes unknown keys last", () => {
  const original = parseAgentFile(
    ["---", "description: One line", "mode: primary", "keepMe: 7", "---", "", "Body text.", ""].join("\n"),
  )
  const rendered = serializeAgentFile(original)
  assert.match(rendered, /^---\n/)
  assert.match(rendered, /\nmode: primary\n/)
  assert.match(rendered, /keepMe: 7/)
  assert.match(rendered, /\nBody text\.\n$/)

  const again = parseAgentFile(rendered)
  assert.deepEqual(again.config, original.config)
  assert.deepEqual(again.extra, original.extra)
  assert.equal(again.instructions.trim(), "Body text.")
})

test("a document without frontmatter is treated as instructions", () => {
  const document = parseAgentFile("Just instructions.\n")
  assert.equal(document.config.mode, "primary")
  assert.deepEqual(document.config.permissions, [])
  assert.equal(document.instructions, "Just instructions.\n")
})

test("parseModelRef handles variants and nested model IDs", () => {
  assert.deepEqual(parseModelRef("anthropic/claude-opus-5-5#high"), {
    providerID: "anthropic",
    modelID: "claude-opus-5-5",
    variant: "high",
  })
  assert.deepEqual(parseModelRef("openrouter/anthropic/claude#low"), {
    providerID: "openrouter",
    modelID: "anthropic/claude",
    variant: "low",
  })
  assert.equal(parseModelRef("no-slash"), undefined)
  assert.equal(parseModelRef("provider/"), undefined)
})

test("validateId rejects paths and reserved names", () => {
  assert.equal(validateId("reviewer"), undefined)
  assert.equal(validateId("team.reviewer-2"), undefined)
  assert.notEqual(validateId("../escape"), undefined)
  assert.notEqual(validateId("Team"), undefined)
  assert.notEqual(validateId("title"), undefined)
  assert.notEqual(validateId(""), undefined)
})

const bundledText = [
  "---",
  "description: Bundled scout",
  "mode: subagent",
  "model: cheap/model#low",
  "permissions:",
  "  - action: shell",
  '    resource: "*"',
  "    effect: deny",
  "---",
  "",
  "Look things up.",
  "",
].join("\n")

function storeFixture(name) {
  const dir = path.join(root, name)
  installAgents({ targetDir: dir, sources: [source("scout.md", bundledText)], version: "1.0.0" })
  const store = new AgentStore(dir, new Map([["scout", bundledText]]))
  return { dir, store }
}

test("the store lists bundled agents as current", () => {
  const { store } = storeFixture("store-list")
  const entries = store.list()
  assert.equal(entries.length, 1)
  assert.equal(entries[0].id, "scout")
  assert.equal(entries[0].source, "bundled")
  assert.equal(entries[0].state, "current")
})

test("editing a bundled agent marks it custom and protects it from install", () => {
  const { dir, store } = storeFixture("store-custom")
  store.update("scout", { description: "Mine", model: "other/model#high" })

  const entry = store.list()[0]
  assert.equal(entry.state, "custom")
  assert.equal(entry.source, "custom")
  assert.match(fsRead(dir, "scout.md"), /description: Mine/)

  const manifest = readManifest(dir)
  assert.deepEqual(manifest.custom, ["scout.md"])
  assert.equal(manifest.files["scout.md"], undefined)

  const result = installAgents({ targetDir: dir, sources: [source("scout.md", bundledText)], version: "2.0.0" })
  assert.equal(result.outcomes["scout.md"], "custom")
  assert.match(fsRead(dir, "scout.md"), /description: Mine/)
  assert.equal(agentStates(dir, [source("scout.md", bundledText)])["scout.md"], "custom")
})

test("reset restores the bundled content and clears customisation", () => {
  const { dir, store } = storeFixture("store-reset")
  store.update("scout", { description: "Mine" })
  store.reset("scout")

  assert.equal(fsRead(dir, "scout.md"), bundledText)
  assert.equal(store.list()[0].state, "current")
  assert.deepEqual(readManifest(dir).custom, [])
})

test("create, clone, rename and remove user agents", () => {
  const { dir, store } = storeFixture("store-user")
  store.create("reviewer", { mode: "subagent", permissions: [] }, "Review things.\n")
  store.clone("reviewer", "reviewer-two")

  assert.ok(fsExists(dir, "reviewer.md"))
  assert.ok(fsExists(dir, "reviewer-two.md"))
  assert.throws(() => store.create("reviewer", { mode: "subagent", permissions: [] }, ""), /already exists/)
  assert.throws(() => store.create("scout", { mode: "subagent", permissions: [] }, ""), /bundled agent/)

  const renamed = store.rename("reviewer-two", "third-reviewer")
  assert.equal(renamed.entry.id, "third-reviewer")
  assert.ok(fsExists(dir, "third-reviewer.md"))
  assert.ok(!fsExists(dir, "reviewer-two.md"))

  store.remove("third-reviewer")
  assert.ok(!fsExists(dir, "third-reviewer.md"))
  assert.equal(store.list().some((entry) => entry.id === "third-reviewer"), false)
})

test("removing a bundled agent disables it until it is restored", () => {
  const { dir, store } = storeFixture("store-disable")
  const result = store.remove("scout")
  assert.equal(result.restorable, true)
  assert.equal(store.list()[0].state, "disabled")

  const installed = installAgents({ targetDir: dir, sources: [source("scout.md", bundledText)], version: "1.1.0" })
  assert.equal(installed.outcomes["scout.md"], "disabled")
  assert.ok(!fsExists(dir, "scout.md"))
  assert.equal(agentStates(dir, [source("scout.md", bundledText)])["scout.md"], "disabled")

  assert.deepEqual(store.restoreDisabled(), ["scout"])
  assert.equal(fsRead(dir, "scout.md"), bundledText)
  assert.equal(store.list()[0].state, "current")
})

test("renaming a bundled agent rewrites subagent permissions and warns about prose", () => {
  const { dir, store } = storeFixture("store-rename")
  store.create(
    "orchestrator",
    {
      mode: "primary",
      permissions: [
        { action: "subagent", resource: "scout", effect: "allow" },
        { action: "subagent", resource: "*", effect: "deny" },
      ],
    },
    "Delegate retrieval to scout when possible.\n",
  )

  const result = store.rename("scout", "researcher")
  assert.deepEqual(result.updated, ["orchestrator"])
  assert.deepEqual(result.warnings, ["orchestrator"])
  assert.deepEqual(readManifest(dir).disabled, ["scout.md"])

  const orchestrator = parseAgentFile(fsRead(dir, "orchestrator.md"))
  assert.deepEqual(orchestrator.config.permissions, [
    { action: "subagent", resource: "researcher", effect: "allow" },
    { action: "subagent", resource: "*", effect: "deny" },
  ])
  assert.ok(!fsExists(dir, "scout.md"))
  assert.ok(fsExists(dir, "researcher.md"))
})

test("the store refuses an empty action when updating", () => {
  const { store } = storeFixture("store-invalid")
  assert.throws(() => store.update("scout", { permissions: [{ action: "", resource: "*", effect: "deny" }] }), /empty action/)
})

test("the plugin parts load", async () => {
  const server = await import("../dist/index.js")
  const tui = await import("../dist/tui.js")
  const rpc = await import("../dist/rpc.js")
  assert.equal(typeof server.default.setup, "function")
  assert.equal(typeof tui.default.setup, "function")
  assert.equal(rpc.AgentsRpc.id, "agents.settings")
})

test("the server part registers RPC handlers that manage agents", async () => {
  const { default: plugin } = await import("../dist/index.js")
  const dir = path.join(root, "rpc")
  let handlers
  let reloads = 0

  const context = {
    options: { install: "none", directory: dir },
    location: { project: { canonical: dir } },
    agent: {
      list: async () => ({ data: [] }),
      reload: async () => {
        reloads += 1
      },
    },
    rpc: {
      register: async (_definition, value) => {
        handlers = value
        return { events: { emit: async () => {} }, dispose: async () => {} }
      },
    },
    command: { transform: async (callback) => callback({ add: () => {} }) },
    session: { synthetic: async () => {} },
  }

  await plugin.setup(context)
  assert.ok(handlers)

  const created = await handlers.create({
    id: "reviewer",
    config: { mode: "subagent", permissions: [] },
    instructions: "Review things.",
  })
  assert.deepEqual(created.agents.map((entry) => entry.id), ["reviewer"])
  assert.equal(reloads, 1)

  const updated = await handlers.update({ id: "reviewer", config: { model: "p/m#low", color: "#ff6b6b" } })
  assert.equal(updated.agents[0].config.model, "p/m#low")
  assert.equal(updated.agents[0].config.color, "#ff6b6b")

  const read = await handlers.read({ id: "reviewer" })
  assert.equal(read.instructions.trim(), "Review things.")

  const renamed = await handlers.rename({ from: "reviewer", to: "reviewer-two" })
  assert.deepEqual(renamed.agents.map((entry) => entry.id), ["reviewer-two"])
  assert.deepEqual(renamed.updated, [])
  assert.deepEqual(renamed.warnings, [])

  const failure = await handlers.remove({ id: "missing" }, { error: (type, message, data) => ({ type, message, data }) })
  assert.equal(failure.type, "not_found")
})

function fsRead(dir, file) {
  return readFileSync(path.join(dir, file), "utf8")
}

function fsExists(dir, file) {
  return existsSync(path.join(dir, file))
}

test("the server part installs the plan-step-executor agent and the decompose-plan command", async () => {
  const { default: plugin } = await import("../dist/index.js")
  const agentsDir = path.join(root, "install-agents")
  const xdg = path.join(root, "install-xdg")
  const previousXdg = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = xdg

  const commands = []
  let commandReloads = 0
  const context = {
    options: { install: "global", directory: agentsDir },
    location: { project: { canonical: agentsDir } },
    agent: { list: async () => ({ data: [] }), reload: async () => {} },
    rpc: { register: async () => ({ events: { emit: async () => {} }, dispose: async () => {} }) },
    command: {
      transform: async (callback) => callback({ add: (definition) => commands.push(definition.name) }),
      reload: async () => {
        commandReloads += 1
      },
    },
    session: { synthetic: async () => {} },
  }

  try {
    await plugin.setup(context)
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousXdg
  }

  const commandsDir = path.join(xdg, "opencode", "commands")
  assert.ok(fsExists(agentsDir, "plan-step-executor.md"))
  assert.ok(fsExists(commandsDir, "decompose-plan.md"))
  assert.ok(fsExists(commandsDir, ".opencode-commands.json"))
  assert.ok(fsRead(commandsDir, "decompose-plan.md").includes("plan-step-executor"))
  assert.ok(commands.includes("agents-status"))
  assert.ok(commands.includes("decompose-status"))
  assert.equal(commandReloads, 1)
})

const baseGraph = () => ({
  goal: "toy",
  max_parallel: 10,
  max_attempts: 2,
  tasks: [
    { id: "T1", title: "one", plan_file: "steps/T1.md", depends_on: [], writes: ["a.ts"] },
    { id: "T2", title: "two", plan_file: "steps/T2.md", depends_on: ["T1"], writes: ["b.ts"] },
    { id: "VERIFY", title: "verify", plan_file: "steps/VERIFY.md", depends_on: ["T2"], writes: [] },
  ],
})

const planFiles = { "T1.md": "one", "T2.md": "two", "VERIFY.md": "verify" }

test("taskgraph validate accepts a sound graph", async () => {
  const dir = await planDir("tg-valid", baseGraph(), planFiles)
  const result = validate(dir)
  assert.equal(result.code, 0)
  const joined = result.lines.join("\n")
  assert.ok(joined.includes("OK: 3 executable tasks, 3 dependency levels"))
  assert.ok(joined.includes("level 1: T1"))
  assert.ok(joined.includes("level 2: T2"))
  assert.ok(joined.includes("level 3: VERIFY"))
})

test("taskgraph validate rejects a dependency cycle", async () => {
  const graph = {
    goal: "toy",
    max_parallel: 10,
    max_attempts: 2,
    tasks: [
      { id: "T1", title: "one", plan_file: "steps/T1.md", depends_on: ["T2"], writes: ["a.ts"] },
      { id: "T2", title: "two", plan_file: "steps/T2.md", depends_on: ["T1"], writes: ["b.ts"] },
    ],
  }
  const dir = await planDir("tg-cycle", graph, { "T1.md": "one", "T2.md": "two" })
  const result = validate(dir)
  assert.equal(result.code, 1)
  assert.ok(result.lines.join("\n").includes("dependency cycle"))
})

test("taskgraph validate rejects an unknown dependency and a missing plan file", async () => {
  const graph = {
    goal: "toy",
    max_parallel: 10,
    max_attempts: 2,
    tasks: [
      { id: "T1", title: "one", plan_file: "steps/T1.md", depends_on: ["T9"], writes: ["a.ts"] },
      { id: "T2", title: "two", plan_file: "steps/T2.md", depends_on: [], writes: ["b.ts"] },
    ],
  }
  const dir = await planDir("tg-bad", graph, { "T1.md": "one" })
  const result = validate(dir)
  assert.equal(result.code, 1)
  const joined = result.lines.join("\n")
  assert.ok(joined.includes("unknown dependency 'T9'"))
  assert.ok(joined.includes("plan_file missing"))
})

test("taskgraph ready respects dependencies, slots and write clashes", async () => {
  const dir = await planDir("tg-ready", baseGraph(), planFiles)
  assert.deepEqual(readyTasks(dir).tasks.map((t) => t.id), ["T1"])

  mark(dir, "T1", "running")
  assert.deepEqual(readyTasks(dir).tasks, [])

  mark(dir, "T1", "done")
  assert.deepEqual(readyTasks(dir).tasks.map((t) => t.id), ["T2"])

  mark(dir, "T2", "running")
  assert.deepEqual(readyTasks(dir).tasks, [])
})

test("taskgraph ready skips a second task that writes the same path", async () => {
  const graph = {
    goal: "toy",
    max_parallel: 10,
    max_attempts: 2,
    tasks: [
      { id: "A", title: "a", plan_file: "steps/A.md", depends_on: [], writes: ["same.ts"] },
      { id: "B", title: "b", plan_file: "steps/B.md", depends_on: [], writes: ["same.ts"] },
    ],
  }
  const dir = await planDir("tg-clash", graph, { "A.md": "a", "B.md": "b" })
  assert.deepEqual(readyTasks(dir).tasks.map((t) => t.id), ["A"])

  mark(dir, "A", "running")
  assert.deepEqual(readyTasks(dir).tasks, [])

  mark(dir, "A", "done")
  assert.deepEqual(readyTasks(dir).tasks.map((t) => t.id), ["B"])
})

test("taskgraph mark tracks attempts and notes", async () => {
  const dir = await planDir("tg-mark", baseGraph(), planFiles)
  mark(dir, "T1", "running")
  mark(dir, "T1", "running")
  mark(dir, "T1", "failed", "boom")

  const graph = JSON.parse(await fs.readFile(path.join(dir, "graph.json"), "utf8"))
  const task = graph.tasks.find((entry) => entry.id === "T1")
  assert.equal(task.attempts, 2)
  assert.equal(task.status, "failed")
  assert.deepEqual(task.notes, ["boom"])
  assert.throws(() => mark(dir, "nope", "done"))
})

test("taskgraph status reports COMPLETE and STUCK", async () => {
  const doneDir = await planDir(
    "tg-complete",
    {
      goal: "toy",
      max_parallel: 10,
      max_attempts: 2,
      tasks: [{ id: "T1", title: "one", plan_file: "steps/T1.md", depends_on: [], writes: ["a.ts"] }],
    },
    { "T1.md": "one" },
  )
  mark(doneDir, "T1", "done")
  assert.equal(status(doneDir).lines.at(-1), "STATE: COMPLETE")

  const stuckDir = await planDir(
    "tg-stuck",
    {
      goal: "toy",
      max_parallel: 10,
      max_attempts: 2,
      tasks: [
        { id: "T1", title: "one", plan_file: "steps/T1.md", depends_on: [], writes: ["a.ts"] },
        { id: "T2", title: "two", plan_file: "steps/T2.md", depends_on: ["T1"], writes: ["b.ts"] },
      ],
    },
    { "T1.md": "one", "T2.md": "two" },
  )
  mark(stuckDir, "T1", "running")
  mark(stuckDir, "T1", "failed")
  mark(stuckDir, "T1", "running")
  mark(stuckDir, "T1", "failed")
  const result = status(stuckDir)
  assert.equal(result.lines.at(-1), "STATE: STUCK")
  assert.ok(result.lines.join("\n").includes("blocked by permanent failure"))
})

test("taskgraph reset-running returns interrupted tasks to pending", async () => {
  const dir = await planDir("tg-reset", baseGraph(), planFiles)
  mark(dir, "T1", "running")
  const result = resetRunning(dir)

  const graph = JSON.parse(await fs.readFile(path.join(dir, "graph.json"), "utf8"))
  const task = graph.tasks.find((entry) => entry.id === "T1")
  assert.equal(task.status, "pending")
  assert.equal(task.attempts, 0)
  assert.equal(result.lines[0], "reset 1 running task(s) to pending")
})

test("commands install into their own manifest", async () => {
  const dir = path.join(root, "commands-manifest")
  const result = installAgents({
    targetDir: dir,
    sources: [source("decompose-plan.md", "body")],
    version: "1.0.0",
    manifestFile: COMMANDS_MANIFEST_FILE,
  })

  assert.deepEqual(result.outcomes, { "decompose-plan.md": "created" })
  assert.ok(fsExists(dir, "decompose-plan.md"))
  assert.equal(readManifest(dir, COMMANDS_MANIFEST_FILE).files["decompose-plan.md"].length, 64)
  assert.equal(existsSync(path.join(dir, MANIFEST_FILE)), false)
  assert.equal(
    agentStates(dir, [source("decompose-plan.md", "body")], COMMANDS_MANIFEST_FILE)["decompose-plan.md"],
    "current",
  )
})

test("the shipped command renders with every placeholder substituted", () => {
  const vars = templateVars(resolveConfig({}))
  const sources = loadSources(bundledCommandsDir(), vars)
  assert.ok(sources.map((entry) => entry.file).includes("decompose-plan.md"))
  const content = sources.find((entry) => entry.file === "decompose-plan.md").content
  assert.ok(!content.includes("{{"))
  assert.ok(content.includes("plan-step-executor"))
  assert.ok(content.includes("taskgraph-cli.js"))
})

for (const { name, fn } of cases) {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${name}`)
    console.log(String(error instanceof Error ? error.stack : error))
  }
}

await fs.rm(root, { recursive: true, force: true })

console.log(failures === 0 ? `\n${cases.length} passed` : `\n${failures} of ${cases.length} failed`)
process.exit(failures === 0 ? 0 : 1)
