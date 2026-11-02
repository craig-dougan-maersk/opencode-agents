import { Rpc } from "@opencode/plugin/rpc";
const permissionSchema = {
    type: "object",
    properties: {
        action: { type: "string" },
        resource: { type: "string" },
        effect: { type: "string", enum: ["allow", "ask", "deny"] },
    },
    required: ["action", "resource", "effect"],
    additionalProperties: false,
};
const configSchema = {
    type: "object",
    properties: {
        description: { type: "string" },
        mode: { type: "string", enum: ["primary", "subagent", "all"] },
        model: { type: "string" },
        color: { type: "string" },
        steps: { type: "number" },
        hidden: { type: "boolean" },
        permissions: { type: "array", items: permissionSchema },
    },
    required: ["mode", "permissions"],
    additionalProperties: false,
};
const patchSchema = {
    type: "object",
    properties: {
        description: { type: "string" },
        mode: { type: "string", enum: ["primary", "subagent", "all"] },
        model: { type: "string" },
        color: { type: "string" },
        steps: { type: "number" },
        hidden: { type: "boolean" },
        permissions: { type: "array", items: permissionSchema },
    },
    additionalProperties: false,
};
const entrySchema = {
    type: "object",
    properties: {
        id: { type: "string" },
        path: { type: "string" },
        source: { type: "string", enum: ["bundled", "custom", "user"] },
        state: { type: "string", enum: ["current", "outdated", "modified", "custom", "missing", "disabled"] },
        config: configSchema,
        instructionsLength: { type: "number" },
        loaded: { type: "boolean" },
        error: { type: "string" },
    },
    required: ["id", "path", "source", "state", "instructionsLength"],
    additionalProperties: false,
};
const listSchema = {
    type: "object",
    properties: {
        targetDir: { type: "string" },
        agents: { type: "array", items: entrySchema },
    },
    required: ["targetDir", "agents"],
    additionalProperties: false,
};
const renameSchema = {
    type: "object",
    properties: {
        targetDir: { type: "string" },
        agents: { type: "array", items: entrySchema },
        updated: { type: "array", items: { type: "string" } },
        warnings: { type: "array", items: { type: "string" } },
    },
    required: ["targetDir", "agents", "updated", "warnings"],
    additionalProperties: false,
};
const restoreSchema = {
    type: "object",
    properties: {
        targetDir: { type: "string" },
        agents: { type: "array", items: entrySchema },
        restored: { type: "array", items: { type: "string" } },
    },
    required: ["targetDir", "agents", "restored"],
    additionalProperties: false,
};
const idInput = {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
};
const pairInput = {
    type: "object",
    properties: { from: { type: "string" }, to: { type: "string" } },
    required: ["from", "to"],
    additionalProperties: false,
};
const errorSchema = { type: "object", properties: {}, additionalProperties: true };
const errors = {
    not_found: errorSchema,
    exists: errorSchema,
    invalid: errorSchema,
    io: errorSchema,
};
export const AgentsRpc = Rpc.define({
    id: "agents.settings",
    methods: {
        list: {
            input: { type: "object", properties: {}, additionalProperties: false },
            output: listSchema,
            errors,
        },
        read: {
            input: idInput,
            output: {
                type: "object",
                properties: { id: { type: "string" }, instructions: { type: "string" } },
                required: ["id", "instructions"],
                additionalProperties: false,
            },
            errors,
        },
        update: {
            input: {
                type: "object",
                properties: {
                    id: { type: "string" },
                    config: patchSchema,
                    instructions: { type: "string" },
                },
                required: ["id"],
                additionalProperties: false,
            },
            output: listSchema,
            errors,
        },
        create: {
            input: {
                type: "object",
                properties: {
                    id: { type: "string" },
                    config: configSchema,
                    instructions: { type: "string" },
                },
                required: ["id", "config", "instructions"],
                additionalProperties: false,
            },
            output: listSchema,
            errors,
        },
        clone: { input: pairInput, output: listSchema, errors },
        rename: { input: pairInput, output: renameSchema, errors },
        remove: { input: idInput, output: listSchema, errors },
        reset: { input: idInput, output: listSchema, errors },
        restore: {
            input: { type: "object", properties: {}, additionalProperties: false },
            output: restoreSchema,
            errors,
        },
    },
    events: {},
});
export function entryData(entry, loaded) {
    return { ...entry, loaded };
}
