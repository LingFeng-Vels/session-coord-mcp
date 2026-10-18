import { execFileSync } from "node:child_process";

export class GitCommandError extends Error {
  readonly command: string;
  readonly exitCode: number | null;

  constructor(message: string, command: string, exitCode: number | null) {
    super(message);
    this.name = "GitCommandError";
    this.command = command;
    this.exitCode = exitCode;
  }
}

function runGit(args: string[], cwd: string): string {
  const command = ["git", ...args].join(" ");

  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).replace(/(?:\r?\n)+$/u, "");
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      status?: number | null;
      stderr?: string | Buffer;
    };
    const stderr = Buffer.isBuffer(failure.stderr)
      ? failure.stderr.toString("utf8").trim()
      : (failure.stderr ?? "").trim();
    const message = stderr || failure.message || "git command failed";
    throw new GitCommandError(message, command, failure.status ?? null);
  }
}

function decodeGitQuoted(body: string): string {
  const bytes: number[] = [];

  for (let index = 0; index < body.length; index += 1) {
    const current = body[index];
    if (current !== "\\") {
      const code = current.charCodeAt(0);
      if (code > 0x7f) {
        bytes.push(...Buffer.from(current, "utf8"));
      } else {
        bytes.push(code);
      }
      continue;
    }

    index += 1;
    const escaped = body[index];
    if (escaped === undefined) {
      break;
    }

    switch (escaped) {
      case "a":
        bytes.push(0x07);
        break;
      case "b":
        bytes.push(0x08);
        break;
      case "t":
        bytes.push(0x09);
        break;
      case "n":
        bytes.push(0x0a);
        break;
      case "v":
        bytes.push(0x0b);
        break;
      case "f":
        bytes.push(0x0c);
        break;
      case "r":
        bytes.push(0x0d);
        break;
      case "\\":
        bytes.push(0x5c);
        break;
      case '"':
        bytes.push(0x22);
        break;
      default:
        if (escaped >= "0" && escaped <= "7") {
          let octal = escaped;
          for (
            let extra = 0;
            extra < 2 &&
            body[index + 1] !== undefined &&
            body[index + 1] >= "0" &&
            body[index + 1] <= "7";
            extra += 1
          ) {
            index += 1;
            octal += body[index];
          }
          bytes.push(Number.parseInt(octal, 8));
          break;
        }
        bytes.push(escaped.charCodeAt(0));
        break;
    }
  }

  return Buffer.from(bytes).toString("utf8");
}

export function unquoteGitPath(raw: string): string {
  const value = raw.trim();
  const unquoted =
    value.length >= 2 && value.startsWith('"') && value.endsWith('"')
      ? decodeGitQuoted(value.slice(1, -1))
      : value;
  return unquoted.replace(/\/+$/u, "");
}

function readPathToken(input: string): { value: string; rest: string } {
  if (input.startsWith('"')) {
    let index = 1;
    while (index < input.length) {
      if (input[index] === "\\") {
        index += 2;
        continue;
      }
      if (input[index] === '"') {
        return {
          value: decodeGitQuoted(input.slice(1, index)),
          rest: input.slice(index + 1),
        };
      }
      index += 1;
    }

    return { value: decodeGitQuoted(input.slice(1)), rest: "" };
  }

  const arrowAt = input.indexOf(" -> ");
  if (arrowAt === -1) {
    return { value: input.trim(), rest: "" };
  }

  return {
    value: input.slice(0, arrowAt).trim(),
    rest: input.slice(arrowAt),
  };
}

function splitRenamePayload(payload: string): string[] {
  const first = readPathToken(payload);
  const paths = [first.value];
  const rest = first.rest.trimStart();

  if (rest.startsWith("->")) {
    const second = readPathToken(rest.slice(2).trimStart());
    if (second.value) {
      paths.push(second.value);
    }
  }

  return paths.filter(Boolean);
}

export function parsePorcelainPaths(line: string): string[] {
  if (line.length < 4) {
    return [];
  }

  const status = line.slice(0, 2);
  const payload = line.slice(3);
  const renameOrCopy = status.includes("R") || status.includes("C");

  if (!renameOrCopy) {
    const parsed = unquoteGitPath(payload);
    return parsed ? [parsed] : [];
  }

  return splitRenamePayload(payload);
}

export class GitService {
  getCurrentBranch(cwd: string): string | null {
    try {
      const branch = runGit(["branch", "--show-current"], cwd);
      return branch || null;
    } catch {
      return null;
    }
  }

  listChangedFiles(cwd: string, diffBase?: string | null): string[] {
    const diffOutput = runGit(
      diffBase ? ["diff", "--name-only", diffBase] : ["diff", "--name-only"],
      cwd,
    );
    const statusOutput = runGit(["status", "--porcelain"], cwd);

    const diffFiles = diffOutput
      ? diffOutput.split(/\r?\n/).filter(Boolean).map((line) => unquoteGitPath(line))
      : [];
    const statusFiles = statusOutput
      ? statusOutput.split(/\r?\n/).filter(Boolean).flatMap((line) => parsePorcelainPaths(line))
      : [];

    return [...new Set([...diffFiles, ...statusFiles].filter(Boolean))];
  }
}
