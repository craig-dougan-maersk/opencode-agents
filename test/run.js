import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
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
