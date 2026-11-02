import { Rpc } from "@opencode/plugin/rpc"
import type { AgentConfigPatch, AgentMode, PermissionRule } from "./agent-file.js"
import type { AgentEntry, AgentFileState, AgentSource } from "./agent-store.js"

const permissionSchema = {
  type: "object",
  properties: {
    action: { type: "string" },
    resource: { type: "string" },
    effect: { type: "string", enum: ["allow", "ask", "deny"] },
  },
  required: ["action", "resource", "effect"],
  additionalProperties: false,
} as const

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
} as const

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
} as const

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
} as const

const listSchema = {
  type: "object",
  properties: {
    targetDir: { type: "string" },
    agents: { type: "array", items: entrySchema },
  },
  required: ["targetDir", "agents"],
  additionalProperties: false,
} as const

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
} as const

const restoreSchema = {
  type: "object",
  properties: {
    targetDir: { type: "string" },
    agents: { type: "array", items: entrySchema },
    restored: { type: "array", items: { type: "string" } },
  },
  required: ["targetDir", "agents", "restored"],
  additionalProperties: false,
} as const

const idInput = {
  type: "object",
  properties: { id: { type: "string" } },
  required: ["id"],
  additionalProperties: false,
} as const

const pairInput = {
  type: "object",
  properties: { from: { type: "string" }, to: { type: "string" } },
  required: ["from", "to"],
  additionalProperties: false,
} as const

const errorSchema = { type: "object", properties: {}, additionalProperties: true } as const

const errors = {
  not_found: errorSchema,
  exists: errorSchema,
  invalid: errorSchema,
  io: errorSchema,
} as const

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
})

export interface AgentConfigData {
  description?: string
  mode: AgentMode
  model?: string
  color?: string
  steps?: number
  hidden?: boolean
  permissions: PermissionRule[]
}

export interface AgentEntryData {
  id: string
  path: string
  source: AgentSource
  state: AgentFileState
  config?: AgentConfigData
  instructionsLength: number
  loaded: boolean
  error?: string
}

export interface AgentsListData {
  targetDir: string
  agents: AgentEntryData[]
}

export interface AgentRenameData extends AgentsListData {
  updated: string[]
  warnings: string[]
}

export interface AgentRestoreData extends AgentsListData {
  restored: string[]
}

export type AgentPatchData = AgentConfigPatch

/** Shape returned by the client for a list-like method, kept here so both parts agree. */
export type AgentResultData = AgentsListData

export function entryData(entry: AgentEntry, loaded: boolean): AgentEntryData {
  return { ...entry, loaded }
}
