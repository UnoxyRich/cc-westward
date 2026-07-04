import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { installDefaultAlias, run } from "../src/index";
import { randomZone, US_ZONES } from "../src/zones";

function harness(rng = () => 0) {
  const calls: Array<{ command: string; args: string[]; options: any }> = [];
  const home = mkdtempSync(path.join(os.tmpdir(), "ccwestward-home-"));
  const stdout = writer();
  const stderr = writer();
  const configPath = path.join(mkdtempSync(path.join(os.tmpdir(), "ccwestward-")), "config.json");
  const spawn = vi.fn((command: string, args: string[], options: any) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    process.nextTick(() => child.emit("exit", 0));
    return child;
  });

  return {
    calls,
    deps: {
      configPath,
      env: { HOME: home, PATH: "/usr/bin", SHELL: "/bin/zsh" },
      rng,
      resolveClaude: () => "/usr/bin/claude",
      spawn: spawn as any,
      stderr,
      stdout
    },
    spawn,
    stderr,
    home,
    stdout
  };
}

function prompt(...answers: string[]) {
  return vi.fn(async () => answers.shift() ?? "");
}

function writer() {
  return {
    text: "",
    write(chunk: string) {
      this.text += chunk;
    }
  };
}

describe("ccwestward", () => {
  test("random timezone is always from the allowlist", () => {
    for (let i = 0; i <= 100; i += 1) {
      expect(US_ZONES).toContain(randomZone(() => i / 100));
    }
  });

  test("--zone accepts valid zones from the allowlist", async () => {
    const h = harness();
    const code = await run(["--zone", "America/New_York", "--dry-run"], h.deps);
    expect(code).toBe(0);
    expect(h.stdout.text).toContain("TZ=America/New_York");
  });

  test("--zone rejects zones outside the allowlist", async () => {
    const h = harness();
    const code = await run(["--zone", "Asia/Shanghai"], h.deps);
    expect(code).toBe(1);
    expect(h.stderr.text).toContain("Unsupported timezone: Asia/Shanghai");
    expect(h.stderr.text).toContain("America/New_York");
    expect(h.spawn).not.toHaveBeenCalled();
  });

  test("arguments after claude are passed through correctly", async () => {
    const h = harness();
    await run(["claude", "--dangerously-skip-permissions"], h.deps);
    expect(h.calls[0].args).toEqual(["--dangerously-skip-permissions"]);
  });

  test("ccwestward with no command defaults to launching Claude", async () => {
    const h = harness();
    await run([], h.deps);
    expect(h.calls[0].command).toBe("/usr/bin/claude");
  });

  test("ccwestward --zone America/New_York defaults to launching Claude", async () => {
    const h = harness();
    await run(["--zone", "America/New_York"], h.deps);
    expect(h.calls[0].command).toBe("/usr/bin/claude");
    expect(h.calls[0].options.env.TZ).toBe("America/New_York");
  });

  test("persists the first random zone for later runs", async () => {
    const h = harness(() => 0.75);
    await run([], h.deps);
    await run([], { ...h.deps, rng: () => 0 });
    expect(h.calls.map((call) => call.options.env.TZ)).toEqual(["America/Los_Angeles", "America/Los_Angeles"]);
  });

  test("--reset-zone asks for a new persisted random zone", async () => {
    const h = harness(() => 0);
    await run([], h.deps);
    await run(["--reset-zone", "--print-zone"], { ...h.deps, rng: () => 0.99 });
    await run([], { ...h.deps, rng: () => 0 });
    expect(h.stdout.text).toContain("Pacific/Honolulu");
    expect(h.calls.map((call) => call.options.env.TZ)).toEqual(["America/New_York", "Pacific/Honolulu"]);
  });

  test("--dry-run does not spawn a process", async () => {
    const h = harness();
    const code = await run(["--dry-run", "claude"], h.deps);
    expect(code).toBe(0);
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.stdout.text).toContain("/usr/bin/claude");
  });

  test("--print-zone prints a valid zone and does not spawn a process", async () => {
    const h = harness(() => 0.25);
    const code = await run(["--print-zone"], h.deps);
    const zone = h.stdout.text.trim();
    expect(code).toBe(0);
    expect(US_ZONES).toContain(zone);
    expect(h.spawn).not.toHaveBeenCalled();
  });

  test("TZ is set only for the spawned child process", async () => {
    const h = harness();
    const env = { PATH: "/usr/bin" };
    await run(["--zone", "America/Chicago"], { ...h.deps, env });
    expect(env).not.toHaveProperty("TZ");
    expect(h.calls[0].options.env.TZ).toBe("America/Chicago");
  });

  test("--quiet suppresses decorative output", async () => {
    const h = harness();
    await run(["--quiet"], h.deps);
    expect(h.stdout.text).toBe("");
  });

  test("init prints zsh, bash, and fish alias instructions", async () => {
    const h = harness();
    await run(["init"], h.deps);
    expect(h.stdout.text).toContain("# zsh / bash");
    expect(h.stdout.text).toContain("alias claude='ccwestward claude'");
    expect(h.stdout.text).toContain("# fish");
    expect(h.stdout.text).toContain("alias claude 'ccwestward claude'");
    expect(h.stdout.text).toContain("# PowerShell");
    expect(h.stdout.text).toContain("function claude { ccwestward claude @args }");
  });

  test("--settings changes timezone and prints custom alias snippets", async () => {
    const h = harness();
    const code = await run(["--settings"], { ...h.deps, prompt: prompt("1", "4", "3", "cclaude", "4", "cw", "6") });
    const zshrc = readFileSync(path.join(h.home, ".zshrc"), "utf8");
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(h.deps.configPath, "utf8")).zone).toBe("America/Chicago");
    expect(zshrc).toContain("alias cclaude='ccwestward claude'");
    expect(zshrc).toContain("alias cw='ccwestward'");
    expect(h.stdout.text).toContain("已写入:");
    expect(h.stdout.text).toContain("source ");
    expect(h.spawn).not.toHaveBeenCalled();
  });

  test("installDefaultAlias writes the default Claude alias", () => {
    const h = harness();
    installDefaultAlias(h.deps.env, h.stdout);
    expect(readFileSync(path.join(h.home, ".zshrc"), "utf8")).toContain("alias claude='ccwestward claude'");
    expect(h.stdout.text).toContain("cc-westward installed claude shortcut");
  });

  test("installDefaultAlias writes a PowerShell function on Windows", () => {
    const h = harness();
    installDefaultAlias({ ...h.deps.env, OS: "Windows_NT", USERPROFILE: h.home }, h.stdout);
    expect(readFileSync(path.join(h.home, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1"), "utf8")).toContain(
      "function claude { ccwestward claude @args }"
    );
    expect(h.stdout.text).toContain("cc-westward installed claude shortcut");
  });

  test("--settings can reset saved timezone and managed aliases", async () => {
    const h = harness();
    const code = await run(["--settings"], { ...h.deps, prompt: prompt("1", "4", "4", "cw", "5", "reset", "6") });
    expect(code).toBe(0);
    expect(existsSync(h.deps.configPath)).toBe(false);
    expect(readFileSync(path.join(h.home, ".zshrc"), "utf8")).not.toContain("cc-westward alias");
    expect(h.stdout.text).toContain("已删除保存的时区");
  });

  test("--settings exits cleanly on Ctrl+C", async () => {
    const h = harness();
    const code = await run(["--settings"], {
      ...h.deps,
      prompt: vi.fn(async () => {
        throw Object.assign(new Error("aborted"), { code: "ABORT_ERR" });
      })
    });
    expect(code).toBe(130);
    expect(h.stdout.text).toContain("已取消");
    expect(h.stderr.text).toBe("");
  });
});
