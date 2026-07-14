#!/usr/bin/env node

import { stat } from "node:fs/promises";
import { resolve } from "node:path";

function usage() {
  console.log(`Usage: voice-cli [project] [options]

Launch the Voice CLI browser app for an OpenCode workspace.

Options:
  --port <number>       Web app port (default: 8791)
  --model <name>        OpenCode model, for example anthropic/claude-sonnet-4
  --agent <name>        OpenCode agent name
  --opencode <path>     OpenCode executable (default: opencode)
  --no-open             Do not open the browser automatically
  -h, --help            Show this help`);
}

function valueAfter(args, index, option) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function parseArgs(args) {
  const options = { project: process.cwd(), openBrowser: true };
  let hasProject = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") return { help: true };
    if (arg === "--no-open") {
      options.openBrowser = false;
      continue;
    }
    if (["--port", "--model", "--agent", "--opencode"].includes(arg)) {
      options[arg.slice(2)] = valueAfter(args, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    if (hasProject) throw new Error("Only one project directory may be provided.");
    options.project = resolve(arg);
    hasProject = true;
  }

  return options;
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    process.exit(0);
  }

  const projectInfo = await stat(options.project);
  if (!projectInfo.isDirectory()) throw new Error(`Not a directory: ${options.project}`);
  if (options.port && (!Number.isInteger(Number(options.port)) || Number(options.port) < 1 || Number(options.port) > 65535)) {
    throw new Error(`Invalid port: ${options.port}`);
  }

  if (options.port) process.env.PORT = options.port;
  if (options.model) process.env.OPENCODE_MODEL = options.model;
  if (options.agent) process.env.OPENCODE_AGENT = options.agent;
  if (options.opencode) process.env.OPENCODE_COMMAND = options.opencode;
  process.env.VOICE_PROJECT_DIR = options.project;
  process.env.VOICE_OPEN_BROWSER = options.openBrowser ? "1" : "0";

  await import("../server.mjs");
} catch (error) {
  console.error(`voice-cli: ${error.message}`);
  process.exit(1);
}
