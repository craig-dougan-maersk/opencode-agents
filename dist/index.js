import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Plugin } from "@opencode/plugin";
import { agentStates, installAgents, loadSources, modelOf, } from "./install.js";
const DEFAULT_MODELS = {
    orchestrator: "anthropic/claude-opus-5-5#high",
    cheap: "opencode-go/deepseek-v4.1-flash#low",
    analyst: "anthropic/claude-opus-5-5#xhigh",
};
const STRICT_RULES = ['  - action: edit', '    resource: "*"', "    effect: deny"].join("\n");
function expandPath(value) {
    if (value === "~")
        return homedir();
    if (value.startsWith("~/"))
        return join(homedir(), value.slice(2));
    return value;
}
function resolveConfig(options) {
    const mode = options.install;
    const install = mode === "project" || mode === "none" ? mode : "global";
    const models = (options.models ?? {});
    const directory = typeof options.directory === "string" && options.directory.length > 0 ? options.directory : undefined;
    const defaultAgent = options.defaultAgent === false
        ? false
        : typeof options.defaultAgent === "string"
            ? options.defaultAgent
            : "orchestrator";
    return {
        install,
        directory,
        overwrite: options.overwrite === true,
        defaultAgent,
        strict: options.strict === true,
        models: {
            orchestrator: typeof models.orchestrator === "string" ? models.orchestrator : DEFAULT_MODELS.orchestrator,
            cheap: typeof models.cheap === "string" ? models.cheap : DEFAULT_MODELS.cheap,
            analyst: typeof models.analyst === "string" ? models.analyst : DEFAULT_MODELS.analyst,
        },
    };
}
function globalAgentsDir() {
    const xdg = process.env.XDG_CONFIG_HOME;
    return xdg ? join(xdg, "opencode", "agents") : join(homedir(), ".config", "opencode", "agents");
}
function projectAgentsDir(projectDir) {
    return join(projectDir, ".opencode", "agents");
}
function targetDirFor(config, projectDir) {
    if (config.directory) {
        const expanded = expandPath(config.directory);
        return isAbsolute(expanded) ? expanded : join(projectDir, expanded);
    }
    return config.install === "project" ? projectAgentsDir(projectDir) : globalAgentsDir();
}
function templateVars(config) {
    return {
        MODEL_ORCHESTRATOR: config.models.orchestrator,
        MODEL_CHEAP: config.models.cheap,
        MODEL_ANALYST: config.models.analyst,
        STRICT_EDIT_RULES: config.strict ? STRICT_RULES : "",
    };
}
function packageVersion() {
    try {
        const path = fileURLToPath(new URL("../package.json", import.meta.url));
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        return parsed.version ?? "0.0.0";
    }
    catch {
        return "0.0.0";
    }
}
function agentIdOf(source) {
    return source.file.replace(/\.md$/, "");
}
function describeOutcomes(outcomes) {
    const groups = new Map();
    for (const [file, outcome] of Object.entries(outcomes)) {
        const list = groups.get(outcome) ?? [];
        list.push(file.replace(/\.md$/, ""));
        groups.set(outcome, list);
    }
    return [...groups.entries()].map(([outcome, ids]) => `${outcome}: ${ids.join(", ")}`).join("; ");
}
async function statusReport(context, config, targetDir, sources) {
    const states = agentStates(targetDir, sources);
    const loaded = new Set();
    try {
        const list = await context.agent.list();
        for (const agent of list.data)
            loaded.add(agent.id);
    }
    catch {
        // Listing is best-effort: the report still works when the agent registry is unavailable.
    }
    const lines = [
        "## Orchestrator agents",
        "",
        `Target: \`${targetDir}\``,
        `Default agent: ${config.defaultAgent === false ? "unchanged" : `\`${config.defaultAgent}\``}`,
        `Strict mode: ${config.strict ? "on (orchestrator cannot edit)" : "off"}`,
        "",
        "| Agent | File | Model | Loaded |",
        "| --- | --- | --- | --- |",
    ];
    for (const source of sources) {
        const id = agentIdOf(source);
        lines.push(`| \`${id}\` | ${states[source.file]} | \`${modelOf(source)}\` | ${loaded.has(id) ? "yes" : "no"} |`);
    }
    const problems = [];
    for (const source of sources) {
        if (states[source.file] === "modified")
            problems.push(`\`${agentIdOf(source)}\` was edited locally; set \`overwrite\` to replace it.`);
        if (states[source.file] === "outdated")
            problems.push(`\`${agentIdOf(source)}\` is from an older version; it is replaced on the next load.`);
        if (states[source.file] === "missing")
            problems.push(`\`${agentIdOf(source)}\` is missing; it is recreated on the next load.`);
    }
    if (problems.length > 0)
        lines.push("", ...problems.map((problem) => `- ${problem}`));
    return lines.join("\n");
}
export default Plugin.define({
    id: "agents.orchestrator",
    async setup(context) {
        const config = resolveConfig(context.options);
        const version = packageVersion();
        const agentsDir = fileURLToPath(new URL("../agents", import.meta.url));
        const projectDir = context.location.project.canonical;
        const targetDir = targetDirFor(config, projectDir);
        let sources;
        try {
            sources = loadSources(agentsDir, templateVars(config));
        }
        catch (error) {
            console.log(`[opencode-agents] cannot read bundled agents from ${agentsDir}: ${error instanceof Error ? error.message : String(error)}`);
            return;
        }
        if (config.install === "none") {
            console.log(`[opencode-agents] install disabled; agents are expected in ${targetDir}`);
        }
        else {
            try {
                const result = installAgents({
                    targetDir,
                    sources,
                    version,
                    overwrite: config.overwrite,
                });
                if (result.written.length > 0 || result.removed.length > 0) {
                    console.log(`[opencode-agents] ${describeOutcomes(result.outcomes)} -> ${result.targetDir}`);
                    await context.agent.reload();
                }
            }
            catch (error) {
                console.log(`[opencode-agents] install failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        if (config.defaultAgent !== false) {
            const wanted = config.defaultAgent;
            await context.agent.transform((editor) => {
                if (editor.get(wanted))
                    editor.default(wanted);
            });
        }
        await context.command.transform((editor) => {
            editor.add({
                name: "agents-status",
                description: "Show the installed orchestrator and subagent profiles",
                execute: async ({ sessionID }) => {
                    const text = await statusReport(context, config, targetDir, sources);
                    await context.session.synthetic({ sessionID, text });
                },
            });
        });
    },
});
