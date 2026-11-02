import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
export const DEFAULT_MODELS = {
    orchestrator: "anthropic/claude-opus-5-5#high",
    cheap: "opencode-go/deepseek-v4.1-flash#low",
    analyst: "anthropic/claude-opus-5-5#xhigh",
};
export const STRICT_RULES = ['  - action: edit', '    resource: "*"', "    effect: deny"].join("\n");
export function expandPath(value) {
    if (value === "~")
        return homedir();
    if (value.startsWith("~/"))
        return join(homedir(), value.slice(2));
    return value;
}
export function resolveConfig(options) {
    const mode = options.install;
    const install = mode === "project" || mode === "none" ? mode : "global";
    const models = (options.models ?? {});
    const directory = typeof options.directory === "string" && options.directory.length > 0 ? options.directory : undefined;
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
    };
}
function configRoot() {
    const xdg = process.env.XDG_CONFIG_HOME;
    return xdg ? join(xdg, "opencode") : join(homedir(), ".config", "opencode");
}
export function globalAgentsDir() {
    return join(configRoot(), "agents");
}
export function projectAgentsDir(projectDir) {
    return join(projectDir, ".opencode", "agents");
}
export function globalCommandsDir() {
    return join(configRoot(), "commands");
}
export function projectCommandsDir(projectDir) {
    return join(projectDir, ".opencode", "commands");
}
export function targetDirFor(config, projectDir) {
    if (config.directory) {
        const expanded = expandPath(config.directory);
        return isAbsolute(expanded) ? expanded : join(projectDir, expanded);
    }
    return config.install === "project" ? projectAgentsDir(projectDir) : globalAgentsDir();
}
/** Commands always live in the standard discovery directories; `directory` only moves agents. */
export function commandsTargetDirFor(config, projectDir) {
    return config.install === "project" ? projectCommandsDir(projectDir) : globalCommandsDir();
}
/** The absolute `node <file>` invocation the installed command uses to drive the task graph. */
export function taskgraphCommand() {
    return `node "${fileURLToPath(new URL("./taskgraph-cli.js", import.meta.url))}"`;
}
export function templateVars(config) {
    return {
        MODEL_ORCHESTRATOR: config.models.orchestrator,
        MODEL_CHEAP: config.models.cheap,
        MODEL_ANALYST: config.models.analyst,
        STRICT_EDIT_RULES: config.strict ? STRICT_RULES : "",
        TASKGRAPH: taskgraphCommand(),
    };
}
export function bundledAgentsDir() {
    return fileURLToPath(new URL("../agents", import.meta.url));
}
export function bundledCommandsDir() {
    return fileURLToPath(new URL("../commands", import.meta.url));
}
export function packageVersion() {
    try {
        const path = fileURLToPath(new URL("../package.json", import.meta.url));
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        return parsed.version ?? "0.0.0";
    }
    catch {
        return "0.0.0";
    }
}
