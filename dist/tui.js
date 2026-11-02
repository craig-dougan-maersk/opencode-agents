import { jsx as _jsx, jsxs as _jsxs } from "@opentui/solid/jsx-runtime";
import { Plugin, usePlugin } from "@opencode/plugin/tui";
import { COLOR_PALETTE, PERMISSION_PRESETS, parseModelRef, validateColor, validateId, validateSteps, } from "./agent-file.js";
import { AgentsRpc, } from "./rpc.js";
const MODE_OPTIONS = [
    { title: "Primary", value: "primary", description: "Runs as the main agent for a session" },
    { title: "Subagent", value: "subagent", description: "Runs only when another agent launches it" },
    { title: "All", value: "all", description: "Can run as either" },
];
function errorText(error) {
    if (error !== null && typeof error === "object") {
        const record = error;
        if (typeof record.message === "string" && record.message.length > 0)
            return record.message;
    }
    return error instanceof Error ? error.message : String(error);
}
async function fail(context, error) {
    try {
        await context.ui.dialog.alert({ title: "Agents", message: errorText(error) });
    }
    catch {
        context.ui.toast.show({ title: "Agents", message: errorText(error), variant: "error" });
    }
}
function saved(context, message = "Saved") {
    context.ui.toast.show({ message, variant: "success" });
}
async function refresh(context, location) {
    try {
        context.data.location.agent.invalidate(location);
        await context.data.location.agent.sync(location);
    }
    catch {
        // The menu reads the list again on the next step; a failed cache refresh is not fatal.
    }
}
function sourceLabel(entry) {
    if (entry.state === "disabled")
        return "Disabled";
    if (entry.source === "custom")
        return "Customised";
    if (entry.source === "bundled")
        return "Bundled";
    return "Your agents";
}
function agentOption(entry) {
    const mode = entry.config?.mode ?? "?";
    const model = entry.config?.model ?? "inherits the model";
    const marks = [entry.loaded ? "loaded" : "not loaded"];
    if (entry.state === "custom")
        marks.push("customised");
    if (entry.state === "modified")
        marks.push("edited");
    if (entry.state === "outdated")
        marks.push("outdated");
    if (entry.state === "disabled")
        marks.push("disabled");
    return {
        title: entry.id,
        value: entry.id,
        description: `${mode} · ${model}`,
        footer: marks.join(" · "),
        category: sourceLabel(entry),
    };
}
function rulesSummary(rules) {
    if (rules.length === 0)
        return "no restrictions";
    return rules.map((rule) => `${rule.effect} ${rule.action} ${rule.resource}`).join(", ");
}
function costLabel(model) {
    const tier = model.cost[0];
    if (tier === undefined)
        return "";
    return ` · $${tier.input}/$${tier.output} per Mtok`;
}
function contextLabel(model) {
    if (!Number.isFinite(model.limit.context) || model.limit.context <= 0)
        return "";
    return ` · ${Math.round(model.limit.context / 1000)}k context`;
}
async function save(context, rpc, location, input) {
    try {
        await rpc.update(input);
        await refresh(context, location);
        saved(context);
        return true;
    }
    catch (error) {
        await fail(context, error);
        return false;
    }
}
/** Returns a model reference, `null` for "inherit", or `undefined` when cancelled. */
async function pickModel(context, location, current) {
    try {
        await context.data.location.model.sync(location);
    }
    catch {
        // Fall back to whatever is cached.
    }
    const models = (context.data.location.model.list(location) ?? []).filter((model) => model.enabled);
    const providers = new Map((context.data.location.provider.list(location) ?? []).map((provider) => [provider.id, provider.name]));
    const chosen = await context.ui.dialog.select({
        title: "Model",
        placeholder: "Search models",
        current: current ?? "",
        options: [
            { title: "Inherit from the session", value: "", description: "Use the model of the parent session", category: "Model" },
            ...models.map((model) => ({
                title: model.name,
                value: `${model.providerID}/${model.modelID}`,
                description: `${model.providerID}/${model.modelID}${costLabel(model)}${contextLabel(model)}`,
                category: providers.get(model.providerID) ?? String(model.providerID),
            })),
        ],
        search: (query, options) => {
            const needle = query.trim().toLowerCase();
            if (needle.length === 0)
                return options;
            return options.filter((option) => `${option.title} ${option.description ?? ""}`.toLowerCase().includes(needle));
        },
    });
    if (chosen === undefined)
        return undefined;
    if (chosen === "")
        return null;
    const model = models.find((candidate) => `${candidate.providerID}/${candidate.modelID}` === chosen);
    if (model === undefined || model.variants.length === 0)
        return chosen;
    const currentVariant = current === undefined ? undefined : parseModelRef(current)?.variant;
    const variant = await context.ui.dialog.select({
        title: `Variant · ${model.name}`,
        current: currentVariant ?? "",
        options: [
            { title: "Model default", value: "", description: "No variant override" },
            ...model.variants.map((entry) => ({ title: entry.id, value: entry.id })),
        ],
    });
    if (variant === undefined)
        return undefined;
    return variant === "" ? chosen : `${chosen}#${variant}`;
}
async function editRule(context, existing) {
    const action = await context.ui.dialog.prompt({
        title: "Permission action",
        description: "Tool or permission action, such as edit, shell, subagent, read or *",
        value: existing?.action ?? "",
        placeholder: "shell",
    });
    if (action === undefined)
        return undefined;
    const resource = await context.ui.dialog.prompt({
        title: "Permission resource",
        description: "Path, command, agent name, or * for everything",
        value: existing?.resource ?? "*",
        placeholder: "*",
    });
    if (resource === undefined)
        return undefined;
    const effect = await context.ui.dialog.select({
        title: "Effect",
        current: existing?.effect ?? "deny",
        options: [
            { title: "Allow", value: "allow", description: "Permit the action" },
            { title: "Ask", value: "ask", description: "Ask before the action" },
            { title: "Deny", value: "deny", description: "Block the action" },
        ],
    });
    if (effect === undefined)
        return undefined;
    if (action.trim().length === 0) {
        await fail(context, new Error("a permission rule needs an action"));
        return undefined;
    }
    return { action: action.trim(), resource: resource.trim().length > 0 ? resource.trim() : "*", effect };
}
async function editInstructions(context, title, initial) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
            if (settled)
                return;
            settled = true;
            context.ui.dialog.clear();
            resolve(value);
        };
        context.ui.dialog.set({ size: "xlarge", centered: true });
        context.ui.dialog.show(() => _jsx(InstructionsEditor, { title: title, initial: initial, onDone: finish }), () => {
            if (!settled) {
                settled = true;
                resolve(undefined);
            }
        });
    });
}
function InstructionsEditor(props) {
    const context = usePlugin();
    let area;
    return (_jsxs("box", { flexDirection: "column", width: "100%", height: "100%", padding: 1, gap: 1, children: [_jsx("text", { fg: context.theme.text.base, children: _jsx("b", { children: props.title }) }), _jsx("text", { fg: context.theme.text.muted, children: "Ctrl+S saves \u00B7 Esc cancels" }), _jsx("box", { flexGrow: 1, border: true, borderColor: context.theme.border.base, paddingLeft: 1, paddingRight: 1, children: _jsx("textarea", { ref: (element) => {
                        area = element;
                        element.focus();
                    }, focused: true, initialValue: props.initial, flexGrow: 1, wrapMode: "word", placeholder: "Write the agent's instructions\u2026", placeholderColor: context.theme.text.faint, textColor: context.theme.text.base, focusedTextColor: context.theme.text.base, backgroundColor: context.theme.background.base, focusedBackgroundColor: context.theme.background.raised.base, onKeyDown: (event) => {
                        if (event.ctrl && event.name === "s") {
                            event.preventDefault();
                            event.stopPropagation();
                            props.onDone(area?.plainText ?? "");
                        }
                        else if (event.name === "escape") {
                            event.preventDefault();
                            event.stopPropagation();
                            props.onDone(undefined);
                        }
                    } }) })] }));
}
async function permissionsMenu(context, rpc, location, id, rules) {
    const choice = await context.ui.dialog.select({
        title: "Permissions",
        placeholder: "Filter rules",
        options: [
            { title: "Apply a preset…", value: "preset", description: rulesSummary(rules), category: "Manage" },
            { title: "Add a rule…", value: "add", category: "Manage" },
            ...rules.map((rule, index) => ({
                title: `${rule.effect}  ${rule.action}  ${rule.resource}`,
                value: `rule:${index}`,
                category: "Rules",
            })),
        ],
    });
    if (choice === undefined)
        return;
    if (choice === "preset") {
        const preset = await context.ui.dialog.select({
            title: "Permission preset",
            options: PERMISSION_PRESETS.map((entry) => ({
                title: entry.label,
                value: entry.id,
                description: entry.description,
            })),
        });
        if (preset === undefined)
            return;
        const found = PERMISSION_PRESETS.find((entry) => entry.id === preset);
        if (found === undefined)
            return;
        await save(context, rpc, location, { id, config: { permissions: [...found.rules] } });
        return;
    }
    if (choice === "add") {
        const rule = await editRule(context);
        if (rule === undefined)
            return;
        await save(context, rpc, location, { id, config: { permissions: [...rules, rule] } });
        return;
    }
    const index = Number(choice.slice("rule:".length));
    const rule = rules[index];
    if (rule === undefined)
        return;
    const action = await context.ui.dialog.select({
        title: `${rule.effect} ${rule.action} ${rule.resource}`,
        options: [
            { title: "Edit rule…", value: "edit" },
            { title: "Remove rule", value: "remove" },
            { title: "Back", value: "back" },
        ],
    });
    if (action === "edit") {
        const next = await editRule(context, rule);
        if (next === undefined)
            return;
        const permissions = rules.map((entry, position) => (position === index ? next : entry));
        await save(context, rpc, location, { id, config: { permissions } });
    }
    else if (action === "remove") {
        const permissions = rules.filter((_entry, position) => position !== index);
        await save(context, rpc, location, { id, config: { permissions } });
    }
}
async function agentMenu(context, rpc, location, initialId) {
    let id = initialId;
    for (;;) {
        const data = await rpc.list({});
        const entry = data.agents.find((candidate) => candidate.id === id && candidate.state !== "disabled");
        if (entry === undefined)
            return;
        const config = entry.config ?? { mode: "primary", permissions: [] };
        const choice = await context.ui.dialog.select({
            title: `Agent · ${id}`,
            options: [
                { title: "Description", value: "description", description: config.description ?? "not set" },
                {
                    title: "Instructions",
                    value: "instructions",
                    description: entry.instructionsLength > 0 ? `${entry.instructionsLength} characters` : "empty",
                },
                { title: "Model", value: "model", description: config.model ?? "inherits the session model" },
                { title: "Mode", value: "mode", description: config.mode },
                { title: "Colour", value: "color", description: config.color ?? "default" },
                { title: "Steps", value: "steps", description: config.steps === undefined ? "unlimited" : String(config.steps) },
                { title: "Permissions", value: "permissions", description: rulesSummary(config.permissions) },
                {
                    title: config.hidden ? "Show in agent lists" : "Hide from agent lists",
                    value: "hidden",
                    description: config.hidden ? "currently hidden" : "currently visible",
                },
                { title: "Rename…", value: "rename", category: "Manage" },
                { title: "Clone…", value: "clone", category: "Manage" },
                ...(entry.source === "bundled" || entry.source === "custom"
                    ? [{ title: "Reset to bundled default…", value: "reset", category: "Manage" }]
                    : []),
                { title: "Delete…", value: "delete", category: "Manage" },
                { title: "Back", value: "back", category: "Manage" },
            ],
        });
        if (choice === undefined || choice === "back")
            return;
        if (choice === "description") {
            const value = await context.ui.dialog.prompt({
                title: "Description",
                description: "Shown to the model when it chooses a subagent",
                value: config.description ?? "",
                placeholder: "What this agent is for",
            });
            if (value !== undefined)
                await save(context, rpc, location, { id, config: { description: value } });
            continue;
        }
        if (choice === "instructions") {
            try {
                const current = await rpc.read({ id });
                const text = await editInstructions(context, `Instructions · ${id}`, current.instructions);
                if (text !== undefined)
                    await save(context, rpc, location, { id, instructions: text });
            }
            catch (error) {
                await fail(context, error);
            }
            continue;
        }
        if (choice === "model") {
            const model = await pickModel(context, location, config.model);
            if (model !== undefined)
                await save(context, rpc, location, { id, config: { model: model ?? "" } });
            continue;
        }
        if (choice === "mode") {
            const mode = await context.ui.dialog.select({
                title: "Mode",
                current: config.mode,
                options: [...MODE_OPTIONS],
            });
            if (mode !== undefined)
                await save(context, rpc, location, { id, config: { mode } });
            continue;
        }
        if (choice === "color") {
            const selected = await context.ui.dialog.select({
                title: "Colour",
                current: config.color ?? "",
                options: [
                    { title: "Default", value: "", description: "Use the theme colour" },
                    ...COLOR_PALETTE.map((color) => ({ title: color, value: color })),
                    { title: "Custom hex…", value: "__custom" },
                ],
            });
            if (selected === undefined)
                continue;
            let color = selected;
            if (selected === "__custom") {
                const custom = await context.ui.dialog.prompt({
                    title: "Custom colour",
                    description: "Six-digit hex, for example #4ec9b0",
                    value: config.color ?? COLOR_PALETTE[0],
                });
                if (custom === undefined)
                    continue;
                const problem = validateColor(custom);
                if (problem !== undefined) {
                    await fail(context, new Error(problem));
                    continue;
                }
                color = custom;
            }
            await save(context, rpc, location, { id, config: { color } });
            continue;
        }
        if (choice === "steps") {
            const value = await context.ui.dialog.prompt({
                title: "Steps",
                description: "Maximum model steps; leave empty for unlimited",
                value: config.steps === undefined ? "" : String(config.steps),
            });
            if (value === undefined)
                continue;
            if (value.trim().length === 0) {
                await save(context, rpc, location, { id, config: { steps: 0 } });
                continue;
            }
            const steps = Number(value);
            const problem = validateSteps(steps);
            if (problem !== undefined) {
                await fail(context, new Error(problem));
                continue;
            }
            await save(context, rpc, location, { id, config: { steps } });
            continue;
        }
        if (choice === "hidden") {
            await save(context, rpc, location, { id, config: { hidden: !config.hidden } });
            continue;
        }
        if (choice === "permissions") {
            await permissionsMenu(context, rpc, location, id, config.permissions);
            continue;
        }
        if (choice === "rename") {
            if (entry.source === "bundled" || entry.source === "custom") {
                const ok = await context.ui.dialog.confirm({
                    title: "Rename bundled agent",
                    message: `'${id}' is a bundled agent. Renaming copies it to the new name and disables the original so the plugin does not recreate it.`,
                    label: { confirm: "Rename", cancel: "Cancel" },
                });
                if (ok !== true)
                    continue;
            }
            const to = await context.ui.dialog.prompt({
                title: "Rename agent",
                description: "The name is the file name. Subagent permission rules that name it are updated.",
                value: id,
            });
            if (to === undefined)
                continue;
            const problem = validateId(to);
            if (problem !== undefined) {
                await fail(context, new Error(problem));
                continue;
            }
            try {
                const result = await rpc.rename({ from: id, to });
                await refresh(context, location);
                id = to;
                const notes = [];
                if (result.updated.length > 0)
                    notes.push(`Updated permission references in: ${result.updated.join(", ")}.`);
                if (result.warnings.length > 0)
                    notes.push(`Check prose mentions in: ${result.warnings.join(", ")}.`);
                if (notes.length > 0)
                    await context.ui.dialog.alert({ title: "Renamed", message: notes.join("\n") });
                else
                    saved(context, "Renamed");
            }
            catch (error) {
                await fail(context, error);
            }
            continue;
        }
        if (choice === "clone") {
            const to = await context.ui.dialog.prompt({
                title: "Clone agent",
                description: `Copy '${id}' to a new name`,
                value: `${id}-copy`,
            });
            if (to === undefined)
                continue;
            const problem = validateId(to);
            if (problem !== undefined) {
                await fail(context, new Error(problem));
                continue;
            }
            try {
                await rpc.clone({ from: id, to });
                await refresh(context, location);
                id = to;
                saved(context, `Cloned to ${to}`);
            }
            catch (error) {
                await fail(context, error);
            }
            continue;
        }
        if (choice === "reset") {
            const ok = await context.ui.dialog.confirm({
                title: "Reset agent",
                message: `Replace '${id}' with the version this plugin ships? Your edits are lost.`,
                label: { confirm: "Reset", cancel: "Cancel" },
            });
            if (ok !== true)
                continue;
            try {
                await rpc.reset({ id });
                await refresh(context, location);
                saved(context, "Reset");
            }
            catch (error) {
                await fail(context, error);
            }
            continue;
        }
        if (choice === "delete") {
            const restorable = entry.source === "bundled" || entry.source === "custom";
            const ok = await context.ui.dialog.confirm({
                title: "Delete agent",
                message: restorable
                    ? `Delete '${id}'? It is a bundled agent, so you can restore it later from this menu.`
                    : `Delete '${id}'? This removes the file.`,
                label: { confirm: "Delete", cancel: "Cancel" },
            });
            if (ok !== true)
                continue;
            try {
                await rpc.remove({ id });
                await refresh(context, location);
                saved(context, "Deleted");
                return;
            }
            catch (error) {
                await fail(context, error);
            }
            continue;
        }
    }
}
async function createAgent(context, rpc, location) {
    const id = await context.ui.dialog.prompt({
        title: "New agent",
        description: "Lowercase name; becomes the file name and the agent ID",
        placeholder: "reviewer",
    });
    if (id === undefined)
        return;
    const problem = validateId(id);
    if (problem !== undefined) {
        await fail(context, new Error(problem));
        return;
    }
    const mode = await context.ui.dialog.select({
        title: "Mode",
        current: "subagent",
        options: [...MODE_OPTIONS],
    });
    if (mode === undefined)
        return;
    const model = await pickModel(context, location, undefined);
    if (model === undefined)
        return;
    const description = await context.ui.dialog.prompt({
        title: "Description",
        description: "Shown to the model when it chooses a subagent",
        placeholder: "What this agent is for",
    });
    if (description === undefined)
        return;
    const preset = await context.ui.dialog.select({
        title: "Permissions",
        current: "edits-no-shell",
        options: PERMISSION_PRESETS.map((entry) => ({
            title: entry.label,
            value: entry.id,
            description: entry.description,
        })),
    });
    if (preset === undefined)
        return;
    const rules = PERMISSION_PRESETS.find((entry) => entry.id === preset)?.rules ?? [];
    const instructions = await editInstructions(context, `Instructions · ${id}`, "");
    if (instructions === undefined)
        return;
    const config = {
        mode,
        permissions: [...rules],
    };
    const trimmed = description.trim();
    if (trimmed.length > 0)
        config.description = trimmed;
    if (model !== null)
        config.model = model;
    try {
        await rpc.create({ id, config, instructions });
        await refresh(context, location);
        saved(context, `Created ${id}`);
    }
    catch (error) {
        await fail(context, error);
    }
}
async function restoreAgents(context, rpc, location) {
    const data = await rpc.list({});
    const disabled = data.agents.filter((entry) => entry.state === "disabled");
    if (disabled.length === 0)
        return;
    const choice = await context.ui.dialog.select({
        title: "Restore bundled agents",
        options: [
            { title: "Restore all", value: "__all", description: `${disabled.length} disabled agents` },
            ...disabled.map((entry) => ({
                title: entry.id,
                value: entry.id,
                description: entry.config?.description ?? "",
            })),
        ],
    });
    if (choice === undefined)
        return;
    try {
        if (choice === "__all") {
            const result = await rpc.restore({});
            await refresh(context, location);
            saved(context, `Restored ${result.restored.length} agents`);
        }
        else {
            await rpc.reset({ id: choice });
            await refresh(context, location);
            saved(context, `Restored ${choice}`);
        }
    }
    catch (error) {
        await fail(context, error);
    }
}
async function openSettings(context, rpc, location) {
    for (;;) {
        let data;
        try {
            data = await rpc.list({});
        }
        catch (error) {
            await fail(context, error);
            return;
        }
        const disabled = data.agents.filter((entry) => entry.state === "disabled");
        const choice = await context.ui.dialog.select({
            title: `Agents · ${context.ui.format.path(data.targetDir)}`,
            placeholder: "Search agents",
            options: [
                { title: "New agent…", value: "__new", description: "Create an agent in this directory", category: "Manage" },
                ...data.agents.filter((entry) => entry.state !== "disabled").map(agentOption),
                ...(disabled.length > 0
                    ? [
                        {
                            title: "Restore bundled agents…",
                            value: "__restore",
                            description: `${disabled.length} disabled`,
                            category: "Manage",
                        },
                    ]
                    : []),
            ],
            search: (query, options) => {
                const needle = query.trim().toLowerCase();
                if (needle.length === 0)
                    return options;
                return options.filter((option) => `${option.title} ${option.description ?? ""}`.toLowerCase().includes(needle));
            },
        });
        if (choice === undefined)
            return;
        if (choice === "__new") {
            await createAgent(context, rpc, location);
            continue;
        }
        if (choice === "__restore") {
            await restoreAgents(context, rpc, location);
            continue;
        }
        try {
            await agentMenu(context, rpc, location, choice);
        }
        catch (error) {
            await fail(context, error);
        }
    }
}
export default Plugin.define({
    id: "agents.settings.tui",
    setup(context) {
        const rpc = context.client.rpc(AgentsRpc);
        const location = context.location ?? context.data.location.default();
        context.keymap.layer(() => ({
            mode: "global",
            commands: [
                {
                    id: "agents.settings",
                    title: "Agents: manage",
                    description: "Create, edit, clone, rename and delete agents",
                    group: "Agents",
                    bind: false,
                    palette: true,
                    slash: { name: "agents" },
                    run: () => {
                        void openSettings(context, rpc, location).catch((error) => void fail(context, error));
                    },
                },
            ],
        }));
    },
});
