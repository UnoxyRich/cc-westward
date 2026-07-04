#!/usr/bin/env node
"use strict";

const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");

if (process.env.CCWESTWARD_SKIP_ALIAS) {
  process.exit(0);
}

const installed = installAlias(process.env, "claude", "ccwestward claude");
process.stdout.write(`cc-westward installed claude shortcut in ${installed.file}\n`);

function installAlias(env, aliasName, target) {
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
  return { file: config.file };
}

function shellConfig(env) {
  const home = env.USERPROFILE ?? env.HOME ?? os.homedir();

  if (env.OS === "Windows_NT" || process.platform === "win32") {
    return {
      file: windowsPowerShellProfile(env, home),
      kind: "powershell"
    };
  }

  if (env.PSModulePath) {
    return {
      file: path.join(env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "powershell", "Microsoft.PowerShell_profile.ps1"),
      kind: "powershell"
    };
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

function windowsPowerShellProfile(env, home) {
  const profileModulePath = (env.PSModulePath ?? "")
    .split(path.delimiter)
    .find((entry) => /(?:^|[\\/])(?:Windows)?PowerShell[\\/]Modules$/i.test(entry));

  if (profileModulePath) {
    return path.join(path.dirname(profileModulePath), "Microsoft.PowerShell_profile.ps1");
  }

  return path.join(home, "Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1");
}

function aliasLine(aliasName, target, kind) {
  if (kind === "powershell") {
    return `function ${aliasName} { ${target} @args }`;
  }
  return kind === "fish" ? `alias ${aliasName} '${target}'` : `alias ${aliasName}='${target}'`;
}
