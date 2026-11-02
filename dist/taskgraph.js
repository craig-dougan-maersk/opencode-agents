/**
 * Task-graph state manager for the decompose-plan command.
 *
 * All state lives in `<plan_dir>/graph.json` so the orchestrator can survive
 * turn boundaries, compaction and restarts. This module is the library; the
 * CLI entry point is `taskgraph-cli.ts`.
 *
 * graph.json schema (leaf / executable tasks only):
 * {
 *   "goal": "...",
 *   "max_parallel": 10,
 *   "max_attempts": 2,
 *   "tasks": [
 *     {
 *       "id": "T2.1.3",
 *       "title": "Add retry wrapper to http client",
 *       "plan_file": "steps/T2.1.3.md",
 *       "depends_on": ["T1", "T2.1.1"],   // a non-leaf id (e.g. "T1") expands to all its leaves
 *       "writes": ["src/http/client.py"],  // files/dirs this task creates or edits
 *       "status": "pending",
 *       "attempts": 0,
 *       "notes": []
 *     }
 *   ]
 * }
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export class TaskgraphError extends Error {
    constructor(message) {
        super(message);
        this.name = "TaskgraphError";
    }
}
const STATES = new Set(["pending", "running", "done", "failed"]);
function graphPath(planDir) {
    return join(planDir, "graph.json");
}
export function loadGraph(planDir) {
    const path = graphPath(planDir);
    if (!existsSync(path))
        throw new TaskgraphError(`${path} not found`);
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
    }
    catch (error) {
        throw new TaskgraphError(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const graph = {
        goal: parsed.goal,
        max_parallel: typeof parsed.max_parallel === "number" ? parsed.max_parallel : 10,
        max_attempts: typeof parsed.max_attempts === "number" ? parsed.max_attempts : 2,
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
    };
    for (const task of graph.tasks) {
        task.depends_on ??= [];
        task.writes ??= [];
        task.status ??= "pending";
        task.attempts ??= 0;
        task.notes ??= [];
    }
    return graph;
}
/** Atomic write so a crash mid-save cannot corrupt state. */
export function saveGraph(planDir, graph) {
    const path = graphPath(planDir);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(graph, null, 2)}\n`);
    renameSync(tmp, path);
}
/** Resolve each dependency to leaf ids. `T1` matches `T1` or any `T1.*`. */
export function expandDeps(graph) {
    const ids = graph.tasks.map((task) => task.id);
    const errors = [];
    const resolved = new Map();
    for (const task of graph.tasks) {
        const out = new Set();
        for (const dep of task.depends_on) {
            const hits = ids.filter((id) => id === dep || id.startsWith(`${dep}.`));
            if (hits.length === 0)
                errors.push(`${task.id}: unknown dependency '${dep}'`);
            for (const hit of hits)
                out.add(hit);
        }
        out.delete(task.id);
        for (const hit of out) {
            if (hit.startsWith(`${task.id}.`) || task.id.startsWith(`${hit}.`)) {
                errors.push(`${task.id}: depends on its own ancestor/descendant`);
                break;
            }
        }
        resolved.set(task.id, out);
    }
    return { resolved, errors };
}
export function topoWaves(ids, deps) {
    const indegree = new Map();
    const children = new Map();
    for (const id of ids) {
        indegree.set(id, deps.get(id)?.size ?? 0);
        children.set(id, []);
    }
    for (const id of ids) {
        for (const dep of deps.get(id) ?? [])
            children.get(dep)?.push(id);
    }
    let frontier = ids.filter((id) => indegree.get(id) === 0).sort();
    const waves = [];
    while (frontier.length > 0) {
        waves.push(frontier);
        const next = [];
        for (const id of frontier) {
            for (const child of children.get(id) ?? []) {
                const remaining = (indegree.get(child) ?? 0) - 1;
                indegree.set(child, remaining);
                if (remaining === 0)
                    next.push(child);
            }
        }
        frontier = next.sort();
    }
    const cyclic = ids.filter((id) => (indegree.get(id) ?? 0) > 0);
    return { waves, cyclic };
}
/** True if any path in `a` equals, contains or is contained by a path in `b`. */
export function overlaps(a, b) {
    const na = a.map((path) => path.replace(/\/+$/, ""));
    const nb = b.map((path) => path.replace(/\/+$/, ""));
    for (const x of na) {
        for (const y of nb) {
            if (x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`))
                return true;
        }
    }
    return false;
}
export function validate(planDir) {
    const graph = loadGraph(planDir);
    const errors = [];
    const ids = graph.tasks.map((task) => task.id);
    const seen = new Set();
    const dupes = new Set();
    for (const id of ids) {
        if (seen.has(id))
            dupes.add(id);
        seen.add(id);
    }
    if (dupes.size > 0)
        errors.push(`duplicate ids: ${[...dupes].sort().join(", ")}`);
    for (const task of graph.tasks) {
        if (!STATES.has(task.status))
            errors.push(`${task.id}: bad status ${task.status}`);
        const planFile = task.plan_file ? join(planDir, task.plan_file) : "";
        if (!task.plan_file || !existsSync(planFile))
            errors.push(`${task.id}: plan_file missing (${planFile})`);
    }
    const { resolved, errors: depErrors } = expandDeps(graph);
    errors.push(...depErrors);
    const { waves, cyclic } = topoWaves(ids, resolved);
    if (cyclic.length > 0)
        errors.push(`dependency cycle among: ${cyclic.join(", ")}`);
    const ancestors = new Map(ids.map((id) => [id, new Set()]));
    for (const wave of waves) {
        for (const id of wave) {
            for (const dep of resolved.get(id) ?? []) {
                const inherited = ancestors.get(dep) ?? new Set();
                const target = ancestors.get(id);
                if (target === undefined)
                    continue;
                target.add(dep);
                for (const entry of inherited)
                    target.add(entry);
            }
        }
    }
    const tasks = new Map(graph.tasks.map((task) => [task.id, task]));
    const warnings = graph.tasks
        .filter((task) => task.writes.length === 0)
        .map((task) => `${task.id}: 'writes' is empty (fine only for read-only/verify tasks)`);
    for (const a of ids) {
        for (const b of ids) {
            if (!(a < b))
                continue;
            if (ancestors.get(a)?.has(b) || ancestors.get(b)?.has(a))
                continue;
            if (overlaps(tasks.get(a)?.writes ?? [], tasks.get(b)?.writes ?? [])) {
                warnings.push(`${a} and ${b} write the same path with no dependency between them (scheduler will serialise them, order arbitrary)`);
            }
        }
    }
    const lines = [...warnings.map((warning) => `WARN: ${warning}`)];
    if (errors.length > 0) {
        lines.push(...errors.map((error) => `ERROR: ${error}`));
        return { code: 1, lines };
    }
    lines.push(`OK: ${ids.length} executable tasks, ${waves.length} dependency levels, max_parallel=${graph.max_parallel}`);
    waves.forEach((wave, index) => lines.push(`  level ${index + 1}: ${wave.join(", ")}`));
    return { code: 0, lines };
}
/** Pending tasks that can never run because an upstream task failed for good. */
export function blockedIds(graph, deps) {
    const tasks = new Map(graph.tasks.map((task) => [task.id, task]));
    const dead = new Set(graph.tasks
        .filter((task) => task.status === "failed" && task.attempts >= graph.max_attempts)
        .map((task) => task.id));
    let changed = true;
    while (changed) {
        changed = false;
        for (const task of graph.tasks) {
            if (dead.has(task.id) || task.status !== "pending")
                continue;
            const upstream = deps.get(task.id) ?? new Set();
            if ([...upstream].some((dep) => dead.has(dep))) {
                dead.add(task.id);
                changed = true;
            }
        }
    }
    return new Set([...dead].filter((id) => tasks.get(id)?.status === "pending"));
}
export function readyTasks(planDir) {
    const graph = loadGraph(planDir);
    const { resolved, errors } = expandDeps(graph);
    if (errors.length > 0) {
        return { code: 1, tasks: [], lines: errors.map((error) => `ERROR: ${error}`) };
    }
    const tasks = new Map(graph.tasks.map((task) => [task.id, task]));
    const running = graph.tasks.filter((task) => task.status === "running");
    let slots = graph.max_parallel - running.length;
    const claimedWrites = running.flatMap((task) => task.writes);
    const out = [];
    const candidates = graph.tasks
        .filter((task) => task.status === "pending" || (task.status === "failed" && task.attempts < graph.max_attempts))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const task of candidates) {
        if (slots <= 0)
            break;
        const deps = resolved.get(task.id) ?? new Set();
        if (![...deps].every((dep) => tasks.get(dep)?.status === "done"))
            continue;
        if (overlaps(task.writes, claimedWrites))
            continue;
        out.push({
            id: task.id,
            title: task.title,
            plan_file: task.plan_file,
            attempt: task.attempts + 1,
            escalate: task.attempts >= 1,
        });
        claimedWrites.push(...task.writes);
        slots -= 1;
    }
    const lines = out.map((task) => `${task.id}\t${task.plan_file}\t${task.title}${task.escalate ? "  [RETRY - escalate model]" : ""}`);
    if (lines.length === 0)
        lines.push("(nothing ready)");
    return { code: 0, tasks: out, lines };
}
export function mark(planDir, id, state, note) {
    if (!STATES.has(state))
        throw new TaskgraphError(`state must be one of ${[...STATES].sort().join(", ")}`);
    const graph = loadGraph(planDir);
    const task = graph.tasks.find((entry) => entry.id === id);
    if (task === undefined)
        throw new TaskgraphError(`no task ${id}`);
    if (state === "running")
        task.attempts += 1;
    task.status = state;
    if (note)
        task.notes.push(note);
    saveGraph(planDir, graph);
    return { code: 0, lines: [`${id} -> ${state} (attempts=${task.attempts})`] };
}
export function status(planDir) {
    const graph = loadGraph(planDir);
    const { resolved } = expandDeps(graph);
    const counts = { pending: 0, running: 0, done: 0, failed: 0 };
    for (const task of graph.tasks)
        counts[task.status] += 1;
    const blocked = blockedIds(graph, resolved);
    const total = graph.tasks.length;
    const lines = [
        `total=${total} done=${counts.done} running=${counts.running} pending=${counts.pending} failed=${counts.failed} blocked=${blocked.size}`,
    ];
    for (const state of ["running", "failed"]) {
        const items = graph.tasks.filter((task) => task.status === state);
        if (items.length === 0)
            continue;
        lines.push(`${state}:`);
        for (const task of items) {
            const last = task.notes.at(-1) ?? "";
            lines.push(`  ${task.id} (attempts=${task.attempts}) ${task.title} ${last}`);
        }
    }
    if (blocked.size > 0)
        lines.push(`blocked by permanent failure: ${[...blocked].sort().join(", ")}`);
    const finished = counts.done === total;
    const stuck = !finished &&
        counts.running === 0 &&
        counts.pending === blocked.size &&
        graph.tasks.filter((task) => task.status === "failed").every((task) => task.attempts >= graph.max_attempts);
    lines.push(`STATE: ${finished ? "COMPLETE" : stuck ? "STUCK" : "IN_PROGRESS"}`);
    return { code: 0, lines };
}
export function resetRunning(planDir) {
    const graph = loadGraph(planDir);
    let count = 0;
    for (const task of graph.tasks) {
        if (task.status !== "running")
            continue;
        task.status = "pending";
        task.attempts = Math.max(0, task.attempts - 1);
        count += 1;
    }
    saveGraph(planDir, graph);
    return { code: 0, lines: [`reset ${count} running task(s) to pending`] };
}
