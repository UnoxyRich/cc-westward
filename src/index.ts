#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { resolveClaude, resolveCommand } from "./resolveCommand";
import { isAllowedZone, randomZone, US_ZONES, type UsZone } from "./zones";

type Writable = { write(chunk: string): unknown };
type Spawn = typeof spawn;
type Prompt = (question: string) => Promise<string>;

type Options = {
  claudeArgs: string[];
  command: "claude" | "init" | "settings";
  dryRun: boolean;
  printZone: boolean;
  quiet: boolean;
  resetZone: boolean;
  zone?: string;
};

type RunDeps = {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  rng?: () => number;
  resolveClaude?: (env: NodeJS.ProcessEnv, selfPath: string) => string | undefined;
  selfPath?: string;
  spawn?: Spawn;
  prompt?: Prompt;
  stderr?: Writable;
  stdout?: Writable;
};

export function installDefaultAlias(env: NodeJS.ProcessEnv = process.env, stdout: Writable = process.stdout): void {
  if (env.CCWESTWARD_SKIP_ALIAS) {
    return;
  }

  const installed = installAlias(env, "claude", "ccwestward claude");
  stdout.write(`cc-westward installed claude shortcut in ${installed.file}\n`);
}

export async function run(argv: string[], deps: RunDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const env = deps.env ?? process.env;
  const parsed = parseArgs(argv);

  if ("error" in parsed) {
    stderr.write(`${parsed.error}\n`);
    return 1;
  }

  const options = parsed.options;
  if (options.command === "init") {
    stdout.write(initText());
    return 0;
  }

  if (options.command === "settings") {
    return settingsMenu({
      configFile: configPath({ configPath: deps.configPath, env }),
      env,
      prompt: deps.prompt,
      rng: deps.rng,
      stderr,
      stdout
    });
  }

  const zoneResult = selectZone(options, {
    configPath: deps.configPath,
    env,
    persist: shouldPersistZone(options),
    rng: deps.rng
  });

  if ("error" in zoneResult) {
    stderr.write(`${zoneResult.error}\n\nAllowed zones:\n${US_ZONES.map((zone) => `  ${zone}`).join("\n")}\n`);
    return 1;
  }

  const zone = zoneResult.zone;

  if (options.printZone) {
    stdout.write(`${zone}\n`);
    return 0;
  }

  const claude = (deps.resolveClaude ?? resolveClaude)(env, deps.selfPath ?? process.argv[1]);
  if (!claude) {
    stderr.write("Could not find the Claude CLI. Install Claude Code first or pass the full path.\n");
    return 1;
  }

  if (options.dryRun) {
    stdout.write(`TZ=${zone} ${[claude, ...options.claudeArgs].map(shellQuote).join(" ")}\n`);
    return 0;
  }

  if (!options.quiet) {
    stdout.write(`CC Westward → launching claude in ${zone}\n`);
  }

  return spawnClaude(deps.spawn ?? spawn, claude, options.claudeArgs, { ...env, TZ: zone }, stderr);
}

function parseArgs(argv: string[]): { options: Options } | { error: string } {
  const options: Options = {
    claudeArgs: [],
    command: "claude",
    dryRun: false,
    printZone: false,
    quiet: false,
    resetZone: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "claude") {
      options.claudeArgs = argv.slice(i + 1);
      return { options };
    }

    if (arg === "init") {
      options.command = "init";
      return { options };
    }

    if (arg === "--settings") {
      options.command = "settings";
      return { options };
    }

    if (arg === "--zone") {
      const zone = argv[i + 1];
      if (!zone) {
        return { error: "--zone requires a timezone" };
      }
      options.zone = zone;
      i += 1;
      continue;
    }

    if (arg.startsWith("--zone=")) {
      options.zone = arg.slice("--zone=".length);
      continue;
    }

    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (arg === "--print-zone") {
      options.printZone = true;
      continue;
    }

    if (arg === "--quiet") {
      options.quiet = true;
      continue;
    }

    if (arg === "--reset-zone") {
      options.resetZone = true;
      continue;
    }

    options.claudeArgs = argv.slice(i);
    return { options };
  }

  return { options };
}

async function settingsMenu(deps: {
  configFile: string;
  env: NodeJS.ProcessEnv;
  prompt?: Prompt;
  rng?: () => number;
  stderr: Writable;
  stdout: Writable;
}): Promise<number> {
  const close = deps.prompt ? undefined : createInterface({ input: process.stdin, output: process.stdout });
  const prompt = deps.prompt ?? ((question: string) => close!.question(question));

  try {
    for (;;) {
      const current = readZone(deps.configFile) ?? "未设置";
      deps.stdout.write(
        [
          "",
          "CC Westward 设置",
          `当前时区: ${current}`,
          "",
          "1) 修改时区",
          "2) 随机生成新时区",
          "3) 安装 Claude 别名",
          "4) 安装 ccwestward 命令别名",
          "5) 重置所有设置",
          "6) 退出",
          ""
        ].join("\n")
      );

      const choice = (await prompt("选择: ")).trim();
      if (choice === "1") {
        await chooseZone(deps.configFile, prompt, deps.stdout);
      } else if (choice === "2") {
        const zone = randomZone(deps.rng);
        saveZone(deps.configFile, zone);
        deps.stdout.write(`已保存时区: ${zone}\n`);
      } else if (choice === "3") {
        await chooseAlias(prompt, deps.stdout, deps.stderr, deps.env, "claude", "ccwestward claude");
      } else if (choice === "4") {
        await chooseAlias(prompt, deps.stdout, deps.stderr, deps.env, "westward", "ccwestward");
      } else if (choice === "5") {
        await resetSettings(deps.configFile, deps.env, prompt, deps.stdout);
      } else if (choice === "6" || choice === "") {
        return 0;
      } else {
        deps.stderr.write("无效选项。\n");
      }
    }
  } catch (error) {
    if (isAbortError(error)) {
      deps.stdout.write("\n已取消。\n");
      return 130;
    }
    throw error;
  } finally {
    close?.close();
  }
}

async function chooseZone(configFile: string, prompt: Prompt, stdout: Writable): Promise<void> {
  stdout.write(`\n${US_ZONES.map((zone, index) => `${index + 1}) ${zone}`).join("\n")}\n`);
  const answer = (await prompt("选择时区编号或完整名称: ")).trim();
  const zone = US_ZONES[Number(answer) - 1] ?? answer;

  if (!isAllowedZone(zone)) {
    stdout.write("未修改：时区不在允许列表中。\n");
    return;
  }

  saveZone(configFile, zone);
  stdout.write(`已保存时区: ${zone}\n`);
}

async function chooseAlias(
  prompt: Prompt,
  stdout: Writable,
  stderr: Writable,
  env: NodeJS.ProcessEnv,
  defaultName: string,
  target: string
): Promise<void> {
  const aliasName = (await prompt(`别名名称（默认 ${defaultName}）: `)).trim() || defaultName;
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(aliasName)) {
    stderr.write("无效别名名称。请只使用字母、数字、下划线或短横线，并以字母或下划线开头。\n");
    return;
  }

  const installed = installAlias(env, aliasName, target);
  if (aliasName !== "claude" && resolveCommand(aliasName, { pathEnv: env.PATH })) {
    stdout.write(`提示：${aliasName} 已经是系统命令；别名生效后会优先使用 ccwestward。\n`);
  }
  stdout.write(`已写入: ${installed.file}\n`);
  stdout.write("新开终端后会自动生效。\n");
  stdout.write(`当前终端如需马上使用，请运行: ${installed.reload}\n`);
}

function installAlias(env: NodeJS.ProcessEnv, aliasName: string, target: string): { file: string; reload: string } {
  const config = shellConfig(env);
  const start = `# cc-westward alias ${aliasName} start`;
  const end = `# cc-westward alias ${aliasName} end`;
  const block = [start, aliasLine(aliasName, target, config.kind), end].join("\n");
  let text = "";

  try {
    text = readFileSync(config.file, "utf8");
  } catch {
    // Missing shell config is fine; create it below.
  }

  const startIndex = text.indexOf(start);
  const endIndex = startIndex === -1 ? -1 : text.indexOf(end, startIndex);
  const next =
    startIndex === -1 || endIndex === -1
      ? `${text.trimEnd()}\n\n${block}\n`.trimStart()
      : `${text.slice(0, startIndex)}${block}${text.slice(endIndex + end.length)}`;

  mkdirSync(path.dirname(config.file), { recursive: true });
  writeFileSync(config.file, next.endsWith("\n") ? next : `${next}\n`);
  return { file: config.file, reload: reloadCommand(config.file, config.kind) };
}

async function resetSettings(configFile: string, env: NodeJS.ProcessEnv, prompt: Prompt, stdout: Writable): Promise<void> {
  const answer = (await prompt("输入 reset 确认重置所有设置: ")).trim();
  if (answer !== "reset") {
    stdout.write("未重置。\n");
    return;
  }

  rmSync(configFile, { force: true });
  const removedAliases = removeManagedAliases(env);
  stdout.write("已删除保存的时区。\n");
  stdout.write(removedAliases ? "已删除 cc-westward 管理的 shell 别名。\n" : "未找到 cc-westward 管理的 shell 别名。\n");
  stdout.write("如当前终端仍有旧别名，请新开终端或重新 source shell 配置。\n");
}

function removeManagedAliases(env: NodeJS.ProcessEnv): boolean {
  const config = shellConfig(env);
  let text = "";

  try {
    text = readFileSync(config.file, "utf8");
  } catch {
    return false;
  }

  const next = text
    .replace(/\n?# cc-westward alias [^\n]+ start\n[\s\S]*?\n# cc-westward alias [^\n]+ end\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();

  if (next === text.trimEnd()) {
    return false;
  }

  writeFileSync(config.file, next ? `${next}\n` : "");
  return true;
}

function shellConfig(env: NodeJS.ProcessEnv): { file: string; kind: "posix" | "fish" | "powershell" } {
  const home = env.USERPROFILE ?? env.HOME ?? os.homedir();
  if (env.OS === "Windows_NT" || process.platform === "win32" || env.PSModulePath) {
    const file =
      env.OS === "Windows_NT" || process.platform === "win32"
        ? path.join(home, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1")
        : path.join(env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "powershell", "Microsoft.PowerShell_profile.ps1");
    return { file, kind: "powershell" };
  }

  const shell = path.basename(env.SHELL ?? "");

  if (shell === "fish") {
    const base = env.XDG_CONFIG_HOME ?? path.join(home, ".config");
    return { file: path.join(base, "fish", "config.fish"), kind: "fish" };
  }

  return {
    file: path.join(home, shell === "bash" ? ".bashrc" : ".zshrc"),
    kind: "posix"
  };
}

function aliasLine(aliasName: string, target: string, kind: "posix" | "fish" | "powershell"): string {
  if (kind === "powershell") {
    return `function ${aliasName} { ${target} @args }`;
  }
  return kind === "fish" ? `alias ${aliasName} '${target}'` : `alias ${aliasName}='${target}'`;
}

function reloadCommand(file: string, kind: "posix" | "fish" | "powershell"): string {
  return kind === "powershell" ? `. ${shellQuote(file)}` : `source ${shellQuote(file)}`;
}

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ABORT_ERR");
}

function selectZone(
  options: Pick<Options, "resetZone" | "zone">,
  deps: Pick<RunDeps, "configPath" | "env" | "rng"> & { persist: boolean }
): { zone: UsZone } | { error: string } {
  if (options.zone) {
    if (!isAllowedZone(options.zone)) {
      return { error: `Unsupported timezone: ${options.zone}` };
    }
    if (deps.persist) {
      saveZone(configPath(deps), options.zone);
    }
    return { zone: options.zone };
  }

  if (options.resetZone) {
    const zone = randomZone(deps.rng);
    if (deps.persist) {
      saveZone(configPath(deps), zone);
    }
    return { zone };
  }

  const saved = readZone(configPath(deps));
  if (saved) {
    return { zone: saved };
  }

  const zone = randomZone(deps.rng);
  if (deps.persist) {
    saveZone(configPath(deps), zone);
  }
  return { zone };
}

function shouldPersistZone(options: Options): boolean {
  return !options.dryRun && (!options.printZone || Boolean(options.zone || options.resetZone));
}

function readZone(file: string): UsZone | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { zone?: string };
    return parsed.zone && isAllowedZone(parsed.zone) ? parsed.zone : undefined;
  } catch {
    return undefined;
  }
}

function saveZone(file: string, zone: UsZone): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ zone }, null, 2)}\n`, { mode: 0o600 });
}

function configPath(deps: Pick<RunDeps, "configPath" | "env">): string {
  if (deps.configPath) {
    return deps.configPath;
  }

  const env = deps.env ?? process.env;
  const base = env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(base, "cc-westward", "config.json");
}

function spawnClaude(spawnImpl: Spawn, claude: string, args: string[], env: NodeJS.ProcessEnv, stderr: Writable): Promise<number> {
  return new Promise((resolve) => {
    const child = spawnImpl(claude, args, { env, stdio: "inherit" });
    child.once("error", (error) => {
      stderr.write(`${error.message}\n`);
      resolve(1);
    });
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

function initText(): string {
  return aliasText("claude", "ccwestward claude");
}

function aliasText(aliasName: string, target: string): string {
  return [
    "# zsh / bash",
    `alias ${aliasName}='${target}'`,
    "",
    "# fish",
    `alias ${aliasName} '${target}'`,
    "",
    "# PowerShell",
    `function ${aliasName} { ${target} @args }`,
    ""
  ].join("\n");
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_/:=.-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

if (require.main === module) {
  void run(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
