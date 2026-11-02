import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyPatch, parseAgentFile, serializeAgentFile, validateConfig, validateId, } from "./agent-file.js";
import { hash, readManifest, writeManifest } from "./install.js";
export class AgentStoreError extends Error {
    kind;
    constructor(kind, message) {
        super(message);
        this.name = "AgentStoreError";
        this.kind = kind;
    }
}
function fileNameOf(id) {
    return `${id}.md`;
}
function idOf(file) {
    return file.replace(/\.md$/, "");
}
function readText(path) {
    try {
        return readFileSync(path, "utf8");
    }
    catch (error) {
        throw new AgentStoreError("io", `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
}
/** Write through a temporary file so a partial write never replaces a working agent. */
function writeAtomic(path, contents) {
    const temporary = `${path}.tmp-${process.pid}`;
    try {
        writeFileSync(temporary, contents);
        renameSync(temporary, path);
    }
    catch (error) {
        try {
            rmSync(temporary, { force: true });
        }
        catch {
            // Ignore cleanup failures; the original file is untouched.
        }
        throw new AgentStoreError("io", `cannot write ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
}
function mentions(text, id) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^A-Za-z0-9_.-])${escaped}(?![A-Za-z0-9_.-])`).test(text);
}
/**
 * Filesystem-backed agent management for one agents directory.
 *
 * `bundled` maps an agent ID to the content this plugin ships for it. The store uses it to decide
 * ownership (bundled, customised or user-created) and to restore a bundled agent.
 */
export class AgentStore {
    targetDir;
    bundled;
    constructor(targetDir, bundled) {
        this.targetDir = targetDir;
        this.bundled = bundled;
    }
    pathOf(id) {
        // Existing files are addressed by name even when they predate the menu's naming rules.
        if (id.length === 0 || id.length > 128 || id === "." || id === ".." || /[\\/\0]/.test(id)) {
            throw new AgentStoreError("invalid", `'${id}' is not a valid agent file name`);
        }
        return join(this.targetDir, fileNameOf(id));
    }
    manifest() {
        return readManifest(this.targetDir);
    }
    saveManifest(manifest) {
        mkdirSync(this.targetDir, { recursive: true });
        writeManifest(this.targetDir, manifest);
    }
    list() {
        const manifest = this.manifest();
        const custom = new Set(manifest.custom);
        const disabled = new Set(manifest.disabled);
        const entries = [];
        const seen = new Set();
        if (existsSync(this.targetDir)) {
            const names = readdirSync(this.targetDir)
                .filter((name) => name.endsWith(".md"))
                .sort();
            for (const name of names) {
                const id = idOf(name);
                const path = join(this.targetDir, name);
                const shipped = this.bundled.get(id);
                const isCustom = custom.has(fileNameOf(id));
                const source = shipped !== undefined ? (isCustom ? "custom" : "bundled") : "user";
                seen.add(id);
                try {
                    const text = readText(path);
                    const document = parseAgentFile(text);
                    entries.push({
                        id,
                        path,
                        source,
                        state: this.stateOf(id, text, shipped, isCustom, manifest),
                        config: document.config,
                        instructionsLength: document.instructions.length,
                    });
                }
                catch (error) {
                    entries.push({
                        id,
                        path,
                        source,
                        state: "modified",
                        instructionsLength: 0,
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            }
        }
        for (const file of disabled) {
            const id = idOf(file);
            if (seen.has(id))
                continue;
            const shipped = this.bundled.get(id);
            if (shipped === undefined)
                continue;
            const document = parseAgentFile(shipped);
            entries.push({
                id,
                path: join(this.targetDir, file),
                source: "bundled",
                state: "disabled",
                config: document.config,
                instructionsLength: document.instructions.length,
            });
        }
        return entries.sort((left, right) => left.id.localeCompare(right.id));
    }
    stateOf(id, text, shipped, isCustom, manifest) {
        if (isCustom)
            return "custom";
        if (shipped === undefined)
            return "current";
        if (text === shipped)
            return "current";
        const recorded = manifest.files[fileNameOf(id)];
        return recorded !== undefined && hash(text) === recorded ? "outdated" : "modified";
    }
    entry(id) {
        return this.list().find((candidate) => candidate.id === id);
    }
    document(id) {
        const path = this.pathOf(id);
        if (!existsSync(path))
            throw new AgentStoreError("not_found", `agent '${id}' does not exist`);
        try {
            return parseAgentFile(readText(path));
        }
        catch (error) {
            if (error instanceof AgentStoreError)
                throw error;
            throw new AgentStoreError("invalid", `cannot parse '${id}': ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    instructions(id) {
        return this.document(id).instructions;
    }
    /** Apply a patch to an existing agent. `instructions` replaces the body when provided. */
    update(id, patch, instructions) {
        const document = this.document(id);
        const config = applyPatch(document.config, patch);
        const problem = validateConfig(config);
        if (problem)
            throw new AgentStoreError("invalid", problem);
        this.write(id, {
            config,
            instructions: instructions === undefined ? document.instructions : instructions,
            extra: document.extra,
        });
        return this.requireEntry(id);
    }
    create(id, config, instructions) {
        const problem = validateId(id);
        if (problem)
            throw new AgentStoreError("invalid", problem);
        const path = this.pathOf(id);
        if (this.bundled.has(id))
            throw new AgentStoreError("exists", `'${id}' is a bundled agent; edit it instead`);
        if (existsSync(path))
            throw new AgentStoreError("exists", `'${id}' already exists`);
        const problemWithConfig = validateConfig(config);
        if (problemWithConfig)
            throw new AgentStoreError("invalid", problemWithConfig);
        this.write(id, { config, instructions, extra: {} });
        return this.requireEntry(id);
    }
    clone(from, to) {
        const document = this.document(from);
        return this.create(to, document.config, document.instructions);
    }
    /**
     * Rename an agent by moving its file. A bundled source is recorded as disabled so the installer
     * does not recreate it. Permission rules that name the old ID are rewritten; prose mentions are
     * reported as warnings.
     */
    rename(from, to) {
        if (from === to)
            return { entry: this.entry(from), updated: [], warnings: [] };
        const document = this.document(from);
        const problem = validateId(to);
        if (problem)
            throw new AgentStoreError("invalid", problem);
        const toPath = this.pathOf(to);
        if (existsSync(toPath))
            throw new AgentStoreError("exists", `'${to}' already exists`);
        if (this.bundled.has(to))
            throw new AgentStoreError("exists", `'${to}' is a bundled agent name`);
        this.write(to, document);
        const fromPath = this.pathOf(from);
        rmSync(fromPath, { force: true });
        const manifest = this.manifest();
        const custom = new Set(manifest.custom);
        const disabled = new Set(manifest.disabled);
        const files = { ...manifest.files };
        delete files[fileNameOf(from)];
        custom.delete(fileNameOf(from));
        if (this.bundled.has(from))
            disabled.add(fileNameOf(from));
        this.saveManifest({ ...manifest, files, custom: [...custom], disabled: [...disabled] });
        const { updated, warnings } = this.rewriteReferences(from, to);
        return { entry: this.entry(to), updated, warnings };
    }
    /** Remove an agent. A bundled agent becomes restorable instead of returning on the next load. */
    remove(id) {
        const path = this.pathOf(id);
        const existing = this.entry(id);
        if (!existsSync(path))
            throw new AgentStoreError("not_found", `agent '${id}' does not exist`);
        rmSync(path, { force: true });
        const manifest = this.manifest();
        const custom = new Set(manifest.custom);
        const disabled = new Set(manifest.disabled);
        const files = { ...manifest.files };
        delete files[fileNameOf(id)];
        custom.delete(fileNameOf(id));
        if (this.bundled.has(id))
            disabled.add(fileNameOf(id));
        this.saveManifest({ ...manifest, files, custom: [...custom], disabled: [...disabled] });
        return {
            entry: existing ?? {
                id,
                path,
                source: this.bundled.has(id) ? "bundled" : "user",
                state: "disabled",
                instructionsLength: 0,
            },
            restorable: this.bundled.has(id),
        };
    }
    /** Restore one bundled agent to the content this plugin ships. */
    reset(id) {
        const shipped = this.bundled.get(id);
        if (shipped === undefined)
            throw new AgentStoreError("invalid", `'${id}' is not a bundled agent`);
        const path = this.pathOf(id);
        mkdirSync(this.targetDir, { recursive: true });
        writeAtomic(path, shipped);
        const manifest = this.manifest();
        const custom = manifest.custom.filter((file) => file !== fileNameOf(id));
        const disabled = manifest.disabled.filter((file) => file !== fileNameOf(id));
        const files = { ...manifest.files, [fileNameOf(id)]: hash(shipped) };
        this.saveManifest({ ...manifest, files, custom, disabled });
        return this.requireEntry(id);
    }
    /** Restore every bundled agent the user removed. Returns the IDs that were restored. */
    restoreDisabled() {
        const manifest = this.manifest();
        const ids = manifest.disabled.map(idOf).filter((id) => this.bundled.has(id));
        for (const id of ids)
            this.reset(id);
        return ids;
    }
    write(id, document) {
        mkdirSync(this.targetDir, { recursive: true });
        writeAtomic(this.pathOf(id), serializeAgentFile(document));
        if (!this.bundled.has(id))
            return;
        const manifest = this.manifest();
        const custom = new Set(manifest.custom);
        const disabled = new Set(manifest.disabled);
        const files = { ...manifest.files };
        custom.add(fileNameOf(id));
        disabled.delete(fileNameOf(id));
        delete files[fileNameOf(id)];
        this.saveManifest({ ...manifest, files, custom: [...custom], disabled: [...disabled] });
    }
    requireEntry(id) {
        const entry = this.entry(id);
        if (entry === undefined)
            throw new AgentStoreError("io", `agent '${id}' is missing after the write`);
        return entry;
    }
    rewriteReferences(from, to) {
        const updated = [];
        const warnings = [];
        if (!existsSync(this.targetDir))
            return { updated, warnings };
        for (const name of readdirSync(this.targetDir)) {
            if (!name.endsWith(".md"))
                continue;
            const id = idOf(name);
            if (id === from || id === to)
                continue;
            const path = join(this.targetDir, name);
            let document;
            try {
                document = parseAgentFile(readText(path));
            }
            catch {
                continue;
            }
            let changed = false;
            const permissions = document.config.permissions.map((rule) => {
                if (rule.action !== "subagent" || rule.resource !== from)
                    return rule;
                changed = true;
                return { ...rule, resource: to };
            });
            if (changed) {
                writeAtomic(path, serializeAgentFile({ ...document, config: { ...document.config, permissions } }));
                updated.push(id);
            }
            if (mentions(document.instructions, from))
                warnings.push(id);
        }
        return { updated, warnings };
    }
}
