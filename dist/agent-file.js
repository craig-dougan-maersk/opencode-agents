import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
export class AgentFileError extends Error {
    constructor(message) {
        super(message);
        this.name = "AgentFileError";
    }
}
export const MODES = ["primary", "subagent", "all"];
export const EFFECTS = ["allow", "ask", "deny"];
export const RESERVED_IDS = new Set(["compaction", "title", "summary"]);
export const COLOR_PALETTE = [
    "#c586c0",
    "#4ec9b0",
    "#dcdcaa",
    "#9cdcfe",
    "#f48771",
    "#4fc1ff",
    "#b5cea8",
    "#d7ba7d",
];
export const PERMISSION_PRESETS = [
    {
        id: "read-only",
        label: "Read-only",
        description: "No edits, no shell commands",
        rules: [
            { action: "edit", resource: "*", effect: "deny" },
            { action: "shell", resource: "*", effect: "deny" },
        ],
    },
    {
        id: "edits-no-shell",
        label: "Edits, no shell",
        description: "May change files, may not run commands",
        rules: [{ action: "shell", resource: "*", effect: "deny" }],
    },
    {
        id: "edits-git-shell",
        label: "Edits + git",
        description: "May change files and run git commands",
        rules: [
            { action: "shell", resource: "git *", effect: "allow" },
            { action: "shell", resource: "*", effect: "deny" },
        ],
    },
    {
        id: "full",
        label: "Full access",
        description: "No restrictions",
        rules: [],
    },
];
const KNOWN_KEYS = new Set(["description", "mode", "model", "color", "steps", "hidden", "permissions"]);
/** Split a Markdown agent into frontmatter and body. Frontmatter is optional. */
function split(text) {
    const normalised = text.replace(/^\uFEFF/, "");
    if (!normalised.startsWith("---"))
        return undefined;
    const firstBreak = normalised.indexOf("\n");
    if (firstBreak === -1)
        return undefined;
    if (normalised.slice(0, firstBreak).trim() !== "---")
        return undefined;
    const rest = normalised.slice(firstBreak + 1);
    const closing = /^---[ \t]*$/m.exec(rest);
    if (closing === null || closing.index === undefined)
        return undefined;
    const yaml = rest.slice(0, closing.index);
    const body = rest.slice(closing.index + closing[0].length).replace(/^(?:\r?\n)+/, "");
    return { yaml, body };
}
function asMode(value) {
    return value === "primary" || value === "subagent" || value === "all" ? value : "primary";
}
function asModel(value) {
    if (typeof value === "string" && value.trim().length > 0)
        return value.trim();
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        const record = value;
        const providerID = record.providerID;
        const modelID = record.model ?? record.id;
        if (typeof providerID === "string" && typeof modelID === "string") {
            const variant = typeof record.variant === "string" && record.variant.length > 0 ? `#${record.variant}` : "";
            return `${providerID}/${modelID}${variant}`;
        }
    }
    return undefined;
}
function asPermissions(value) {
    if (!Array.isArray(value))
        return [];
    const rules = [];
    for (const entry of value) {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry))
            continue;
        const record = entry;
        const action = record.action;
        const resource = record.resource;
        const effect = record.effect;
        if (typeof action !== "string" || action.length === 0)
            continue;
        if (typeof resource !== "string")
            continue;
        if (effect !== "allow" && effect !== "ask" && effect !== "deny")
            continue;
        rules.push({ action, resource, effect });
    }
    return rules;
}
/** Parse a Markdown agent file. Throws when the frontmatter is not a YAML mapping. */
export function parseAgentFile(text) {
    const parts = split(text);
    let raw = {};
    let body = text;
    if (parts) {
        body = parts.body;
        if (parts.yaml.trim().length > 0) {
            const parsed = parseYaml(parts.yaml);
            if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
                throw new AgentFileError("frontmatter is not a YAML mapping");
            }
            raw = parsed;
        }
    }
    const extra = {};
    for (const [key, value] of Object.entries(raw)) {
        if (!KNOWN_KEYS.has(key))
            extra[key] = value;
    }
    const steps = raw.steps;
    return {
        config: {
            description: typeof raw.description === "string" && raw.description.trim().length > 0 ? raw.description.trim() : undefined,
            mode: asMode(raw.mode),
            model: asModel(raw.model),
            color: typeof raw.color === "string" && raw.color.length > 0 ? raw.color : undefined,
            steps: typeof steps === "number" && Number.isInteger(steps) && steps > 0 ? steps : undefined,
            hidden: raw.hidden === true ? true : undefined,
            permissions: asPermissions(raw.permissions),
        },
        instructions: body,
        extra,
    };
}
/** Serialise a document back to Markdown. Unknown frontmatter keys are written last. */
export function serializeAgentFile(document) {
    const frontmatter = {};
    const config = document.config;
    if (config.description && config.description.trim().length > 0)
        frontmatter.description = config.description.trim();
    frontmatter.mode = config.mode;
    if (config.model)
        frontmatter.model = config.model;
    if (config.color)
        frontmatter.color = config.color;
    if (typeof config.steps === "number" && config.steps > 0)
        frontmatter.steps = config.steps;
    if (config.hidden)
        frontmatter.hidden = true;
    if (config.permissions.length > 0) {
        frontmatter.permissions = config.permissions.map((rule) => ({
            action: rule.action,
            resource: rule.resource,
            effect: rule.effect,
        }));
    }
    for (const [key, value] of Object.entries(document.extra)) {
        if (!(key in frontmatter))
            frontmatter[key] = value;
    }
    const yaml = stringifyYaml(frontmatter, { lineWidth: 0 }).trimEnd();
    const body = document.instructions.replace(/^\s*\n+/, "").replace(/\s+$/, "");
    return `---\n${yaml}\n---\n${body.length > 0 ? `\n${body}\n` : ""}`;
}
/** Parse `provider/model#variant`. Model IDs may contain slashes; providers do not. */
export function parseModelRef(value) {
    const hash = value.lastIndexOf("#");
    const variant = hash > 0 ? value.slice(hash + 1) : undefined;
    const base = hash > 0 ? value.slice(0, hash) : value;
    const slash = base.indexOf("/");
    if (slash <= 0 || slash === base.length - 1)
        return undefined;
    const providerID = base.slice(0, slash);
    const modelID = base.slice(slash + 1);
    if (variant !== undefined && variant.length === 0)
        return undefined;
    return variant === undefined ? { providerID, modelID } : { providerID, modelID, variant };
}
export function formatModelRef(ref) {
    return `${ref.providerID}/${ref.modelID}${ref.variant ? `#${ref.variant}` : ""}`;
}
export function validateId(id) {
    if (id.length === 0)
        return "name is required";
    if (id.length > 64)
        return "name must be 64 characters or fewer";
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(id))
        return "use lowercase letters, digits, dots, dashes or underscores";
    if (RESERVED_IDS.has(id))
        return `'${id}' is reserved for an internal OpenCode agent`;
    return undefined;
}
export function validateModel(value) {
    if (parseModelRef(value) === undefined)
        return "expected provider/model, optionally with #variant";
    if (/\s/.test(value))
        return "model references cannot contain whitespace";
    return undefined;
}
export function validateColor(value) {
    return /^#[0-9a-fA-F]{6}$/.test(value) ? undefined : "expected a six-digit hex colour such as #4ec9b0";
}
export function validateSteps(value) {
    if (!Number.isInteger(value) || value < 1 || value > 1000)
        return "steps must be a whole number between 1 and 1000";
    return undefined;
}
/** Apply a patch to a config. Empty strings and zero clear optional fields. */
export function applyPatch(config, patch) {
    const next = { ...config, permissions: [...config.permissions] };
    if ("description" in patch) {
        const value = patch.description?.trim();
        next.description = value && value.length > 0 ? value : undefined;
    }
    if (patch.mode !== undefined)
        next.mode = patch.mode;
    if ("model" in patch)
        next.model = patch.model && patch.model.length > 0 ? patch.model : undefined;
    if ("color" in patch)
        next.color = patch.color && patch.color.length > 0 ? patch.color : undefined;
    if ("steps" in patch)
        next.steps = typeof patch.steps === "number" && patch.steps > 0 ? patch.steps : undefined;
    if (patch.hidden !== undefined)
        next.hidden = patch.hidden ? true : undefined;
    if (patch.permissions !== undefined) {
        next.permissions = patch.permissions.map((rule) => ({
            action: rule.action,
            resource: rule.resource,
            effect: rule.effect,
        }));
    }
    return next;
}
/** Validate a full config, returning the first problem found. */
export function validateConfig(config) {
    if (!MODES.includes(config.mode))
        return "mode must be primary, subagent or all";
    if (config.model !== undefined) {
        const problem = validateModel(config.model);
        if (problem)
            return problem;
    }
    if (config.color !== undefined) {
        const problem = validateColor(config.color);
        if (problem)
            return problem;
    }
    if (config.steps !== undefined) {
        const problem = validateSteps(config.steps);
        if (problem)
            return problem;
    }
    for (const rule of config.permissions) {
        if (rule.action.length === 0)
            return "a permission rule has an empty action";
        if (!EFFECTS.includes(rule.effect))
            return `unknown permission effect '${rule.effect}'`;
    }
    return undefined;
}
