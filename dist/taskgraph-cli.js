#!/usr/bin/env node
/**
 * CLI for the task-graph state manager used by `/decompose-plan`.
 *
 *   taskgraph-cli validate <plan_dir>
 *   taskgraph-cli ready    <plan_dir> [--json]
 *   taskgraph-cli mark     <plan_dir> <id> <state> [--note TEXT]
 *   taskgraph-cli status   <plan_dir>
 *   taskgraph-cli reset-running <plan_dir>
 *
 * The orchestrator shells out to this file; the plugin imports the library
 * directly for `/decompose-status`.
 */
import { readyTasks, mark, resetRunning, status, validate, TaskgraphError } from "./taskgraph.js";
function usage() {
    console.error("usage: taskgraph-cli <validate|ready|mark|status|reset-running> <plan_dir> [args]");
    process.exit(2);
}
function main(argv) {
    const [command, ...rest] = argv;
    if (command === undefined)
        usage();
    try {
        switch (command) {
            case "validate": {
                const planDir = rest[0];
                if (planDir === undefined)
                    usage();
                return print(validate(planDir));
            }
            case "ready": {
                const planDir = rest[0];
                if (planDir === undefined)
                    usage();
                const result = readyTasks(planDir);
                if (result.code !== 0)
                    return print({ code: result.code, lines: result.lines });
                if (rest.includes("--json")) {
                    console.log(JSON.stringify(result.tasks, null, 2));
                    return 0;
                }
                return print({ code: 0, lines: result.lines });
            }
            case "mark": {
                const [planDir, id, state] = rest;
                if (planDir === undefined || id === undefined || state === undefined)
                    usage();
                const noteIndex = rest.indexOf("--note");
                const note = noteIndex === -1 ? undefined : rest[noteIndex + 1];
                return print(mark(planDir, id, state, note));
            }
            case "status": {
                const planDir = rest[0];
                if (planDir === undefined)
                    usage();
                return print(status(planDir));
            }
            case "reset-running": {
                const planDir = rest[0];
                if (planDir === undefined)
                    usage();
                return print(resetRunning(planDir));
            }
            default:
                usage();
        }
    }
    catch (error) {
        if (error instanceof TaskgraphError) {
            console.error(`ERROR: ${error.message}`);
            return 1;
        }
        throw error;
    }
}
function print(result) {
    for (const line of result.lines)
        console.log(line);
    return result.code;
}
process.exitCode = main(process.argv.slice(2));
