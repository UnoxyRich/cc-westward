import { accessSync, constants, realpathSync, statSync } from "node:fs";
import path from "node:path";

type ResolveOptions = {
  pathEnv?: string;
  skipPaths?: string[];
};

export function commandPaths(command: string, pathEnv = process.env.PATH ?? ""): string[] {
  if (command.includes("/") || command.includes("\\")) {
    return [command];
  }

  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];

  return pathEnv
    .split(path.delimiter)
    .filter(Boolean)
    .flatMap((dir) => extensions.map((ext) => path.join(dir, command + ext)));
}

export function resolveCommand(command: string, options: ResolveOptions = {}): string | undefined {
  const pathEnv = options.pathEnv ?? process.env.PATH ?? "";
  const skip = new Set((options.skipPaths ?? []).map(realpathIfExists).filter(Boolean));

  for (const candidate of commandPaths(command, pathEnv)) {
    if (!isExecutable(candidate)) {
      continue;
    }

    const real = realpathIfExists(candidate);
    if (real && !skip.has(real)) {
      return candidate;
    }
  }

  return undefined;
}

export function resolveClaude(env: NodeJS.ProcessEnv = process.env, selfPath = process.argv[1]): string | undefined {
  const skipPaths = [selfPath, ...commandPaths("ccwestward", env.PATH)];
  const requested = env.CCWESTWARD_CLAUDE;
  return requested
    ? resolveCommand(requested, { pathEnv: env.PATH, skipPaths })
    : resolveCommand("claude", { pathEnv: env.PATH, skipPaths });
}

function isExecutable(file: string): boolean {
  try {
    const stat = statSync(file);
    accessSync(file, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return stat.isFile();
  } catch {
    return false;
  }
}

function realpathIfExists(file: string): string | undefined {
  try {
    return realpathSync(file);
  } catch {
    return undefined;
  }
}
