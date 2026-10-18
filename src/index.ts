#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { initializeRepository, inspectRepositorySetup } from "./bootstrap/init.js";
import { createConfig } from "./config.js";
import { createSessionCoordServer } from "./server.js";
import { VERSION } from "./version.js";

interface ParsedArgs {
  command: "serve" | "init" | "doctor";
  options: {
    workspaceRoot?: string;
    dbPath?: string;
    defaultTtlMinutes?: number;
    offlineAfterMinutes?: number;
    updatesLimit?: number;
    target?: string;
    overwrite?: boolean;
  };
  help: boolean;
  version: boolean;
}

function printHelp(): void {
  console.log(`session-coord-mcp ${VERSION}

Usage:
  session-coord-mcp [serve] [options]
  session-coord-mcp init [--target <path>] [--overwrite]
  session-coord-mcp doctor [--target <path>]

Options:
  --help                       Show this help message
  --version                    Print version
  --workspace-root <path>      Workspace root for coordination state
  --db-path <path>             Path to the SQLite database file
  --default-ttl-minutes <n>    Default path claim TTL in minutes
  --offline-after-minutes <n>  Mark sessions offline after n minutes without heartbeat
  --updates-limit <n>          Default maximum number of updates returned
  --target <path>              Repository path used by init/doctor
  --overwrite                  Overwrite generated files in init mode
`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: "serve",
    options: {},
    help: false,
    version: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    switch (current) {
      case "serve":
      case "init":
      case "doctor":
        parsed.command = current;
        break;
      case "--help":
        parsed.help = true;
        break;
      case "--version":
        parsed.version = true;
        break;
      case "--workspace-root":
        parsed.options.workspaceRoot = next;
        index += 1;
        break;
      case "--db-path":
        parsed.options.dbPath = next;
        index += 1;
        break;
      case "--default-ttl-minutes":
        parsed.options.defaultTtlMinutes = Number.parseInt(next ?? "", 10);
        index += 1;
        break;
      case "--offline-after-minutes":
        parsed.options.offlineAfterMinutes = Number.parseInt(next ?? "", 10);
        index += 1;
        break;
      case "--updates-limit":
        parsed.options.updatesLimit = Number.parseInt(next ?? "", 10);
        index += 1;
        break;
      case "--target":
        parsed.options.target = next;
        index += 1;
        break;
      case "--overwrite":
        parsed.options.overwrite = true;
        break;
      default:
        break;
    }
  }

  return parsed;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.help) {
    printHelp();
    return;
  }

  if (parsed.version) {
    console.log(VERSION);
    return;
  }

  if (parsed.command === "init") {
    console.log(
      JSON.stringify(
        initializeRepository(parsed.options.target ?? process.cwd(), Boolean(parsed.options.overwrite)),
        null,
        2,
      ),
    );
    return;
  }

  if (parsed.command === "doctor") {
    console.log(
      JSON.stringify(inspectRepositorySetup(parsed.options.target ?? process.cwd()), null, 2),
    );
    return;
  }

  const config = createConfig(parsed.options);
  const server = createSessionCoordServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
