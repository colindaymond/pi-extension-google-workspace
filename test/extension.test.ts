import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import googleWorkspaceExtension from "../extensions/index.js";
import { readSelectedAccount, readWorkAccount, writeSelectedAccount, writeWorkAccount } from "../extensions/accounts.js";

test("registers the Workspace tool, account commands, and backslash aliases", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gws-extension-test-"));
  t.after(async () => {
    delete process.env.GOOGLE_WORKSPACE_CONFIG_DIR;
    await rm(root, { recursive: true, force: true });
  });
  process.env.GOOGLE_WORKSPACE_CONFIG_DIR = root;

  const commands = new Map<string, unknown>();
  const listeners = new Map<string, (...args: any[]) => any>();
  const tools: Array<{ name: string }> = [];
  const fakePi = {
    registerCommand(name: string, command: unknown) {
      commands.set(name, command);
    },
    registerTool(tool: { name: string }) {
      tools.push(tool);
    },
    on(name: string, listener: (...args: any[]) => any) {
      listeners.set(name, listener);
    },
  } as unknown as ExtensionAPI;

  googleWorkspaceExtension(fakePi);

  assert.deepEqual(
    [...commands.keys()],
    ["gw", "gw-use", "gw-next", "gw-prev", "gw-status", "gw-work", "gw-login", "gw-logout"],
  );
  assert.deepEqual(tools.map((tool) => tool.name), ["google_workspace"]);
  assert.ok(listeners.has("session_start"));
  assert.ok(listeners.has("before_agent_start"));
  assert.ok(listeners.has("input"));

  const notifications: string[] = [];
  const context = {
    hasUI: false,
    ui: { notify: (text: string) => notifications.push(text) },
  };
  await listeners.get("session_start")?.({}, context);
  await listeners.get("input")?.({ text: "\\gw-status", source: "interactive" }, context);
  assert.equal(notifications.at(-1), "Google Workspace: no account selected");

  const result = await listeners.get("input")?.(
    { text: "\\gw-next", source: "interactive" },
    context,
  );
  assert.deepEqual(result, { action: "handled" });
});

test("google_workspace tool honours the account parameter and lists other accounts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gws-extension-test-"));
  t.after(async () => {
    delete process.env.GOOGLE_WORKSPACE_CONFIG_DIR;
    await rm(root, { recursive: true, force: true });
  });
  process.env.GOOGLE_WORKSPACE_CONFIG_DIR = root;
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(join(root, "tokens"), { recursive: true });
  await writeFile(join(root, "tokens", "a%40example.com.json"), JSON.stringify({ __email: "a@example.com" }));
  await writeFile(join(root, "tokens", "b%40example.com.json"), JSON.stringify({ __email: "b@example.com" }));
  await writeFile(join(root, "pi-extension.json"), JSON.stringify({ selectedAccount: "a@example.com" }));

  const execCalls: string[][] = [];
  const listeners = new Map<string, (...args: any[]) => any>();
  let tool: any;
  const fakePi = {
    registerCommand() {},
    registerTool(registered: unknown) { tool = registered; },
    on(name: string, listener: (...args: any[]) => any) { listeners.set(name, listener); },
    async exec(_cmd: string, args: string[]) {
      execCalls.push(args);
      return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
    },
  } as unknown as ExtensionAPI;

  googleWorkspaceExtension(fakePi);

  const prompt = await listeners.get("before_agent_start")?.({ systemPrompt: "base" });
  assert.match(prompt.systemPrompt, /active Google Workspace account is a@example.com/);
  assert.match(prompt.systemPrompt, /b@example.com/);

  const defaultResult = await tool.execute("id", { script: "return 1;" });
  assert.equal(defaultResult.details.email, "a@example.com");
  assert.equal(execCalls[0][execCalls[0].indexOf("--email") + 1], "a@example.com");

  const otherResult = await tool.execute("id", { script: "return 1;", account: "B@Example.com" });
  assert.equal(otherResult.details.email, "b@example.com");
  assert.equal(execCalls[1][execCalls[1].indexOf("--email") + 1], "b@example.com");

  await assert.rejects(
    tool.execute("id", { script: "return 1;", account: "c@example.com" }),
    /No signed-in Google Workspace account found for c@example.com.*a@example.com, b@example.com/,
  );
});

test("work-account command persists routing and recipient guidance without changing selection", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gws-work-test-"));
  const previous = process.env.GOOGLE_WORKSPACE_CONFIG_DIR;
  t.after(async () => {
    if (previous === undefined) delete process.env.GOOGLE_WORKSPACE_CONFIG_DIR;
    else process.env.GOOGLE_WORKSPACE_CONFIG_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  process.env.GOOGLE_WORKSPACE_CONFIG_DIR = root;
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(join(root, "tokens"), { recursive: true });
  for (const email of ["home@example.com", "work@example.com"])
    await writeFile(join(root, "tokens", `${encodeURIComponent(email)}.json`), JSON.stringify({ __email: email }));
  writeSelectedAccount("home@example.com", root);
  const commands = new Map<string, any>();
  const listeners = new Map<string, (...args: any[]) => any>();
  const notices: string[] = [];
  const fakePi = {
    registerCommand(name: string, command: unknown) { commands.set(name, command); },
    registerTool() {},
    on(name: string, listener: (...args: any[]) => any) { listeners.set(name, listener); },
  } as unknown as ExtensionAPI;
  const ctx = { hasUI: false, ui: { notify: (text: string) => notices.push(text) } };
  googleWorkspaceExtension(fakePi);
  const before = await listeners.get("before_agent_start")?.({ systemPrompt: "base" });
  assert.doesNotMatch(before.systemPrompt, /work preference/);
  await commands.get("gw-work").handler("WORK@Example.com", ctx);
  assert.equal(readWorkAccount(root), "work@example.com");
  assert.equal(readSelectedAccount(root), "home@example.com");
  const prompt = await listeners.get("before_agent_start")?.({ systemPrompt: "base" });
  assert.match(prompt.systemPrompt, /active Google Workspace account is home@example.com/);
  assert.match(prompt.systemPrompt, /account="work@example.com"/);
  assert.match(prompt.systemPrompt, /send from this account to work@example.com/);
  assert.match(prompt.systemPrompt, /Create work files in that account/);
  assert.match(prompt.systemPrompt, /explicitly specifies another account or recipient/);
  await commands.get("gw-work").handler("", ctx);
  assert.match(notices.at(-1)!, /work account: work@example.com/);
  await assert.rejects(commands.get("gw-work").handler("unknown@example.com", ctx), /No signed-in/);
  assert.equal(readWorkAccount(root), "work@example.com");
  await commands.get("gw-use").handler("work@example.com", ctx);
  await commands.get("gw-use").handler("home@example.com", ctx);
  assert.equal(readWorkAccount(root), "work@example.com");
  const result = await listeners.get("input")?.({ text: "\\gw-work clear" }, ctx);
  assert.deepEqual(result, { action: "handled" });
  assert.equal(readWorkAccount(root), undefined);
  assert.equal(readSelectedAccount(root), "home@example.com");
  const cleared = await listeners.get("before_agent_start")?.({ systemPrompt: "base" });
  assert.doesNotMatch(cleared.systemPrompt, /work preference/);
});

test("work-account guidance survives reload and missing login without personal fallback", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gws-work-reload-test-"));
  const previous = process.env.GOOGLE_WORKSPACE_CONFIG_DIR;
  t.after(async () => {
    if (previous === undefined) delete process.env.GOOGLE_WORKSPACE_CONFIG_DIR;
    else process.env.GOOGLE_WORKSPACE_CONFIG_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  process.env.GOOGLE_WORKSPACE_CONFIG_DIR = root;
  writeWorkAccount("work@example.com", root);
  for (let load = 0; load < 2; load++) {
    const listeners = new Map<string, (...args: any[]) => any>();
    googleWorkspaceExtension({
      registerCommand() {}, registerTool() {},
      on(name: string, listener: (...args: any[]) => any) { listeners.set(name, listener); },
    } as unknown as ExtensionAPI);
    const prompt = await listeners.get("before_agent_start")?.({ systemPrompt: "base" });
    assert.match(prompt.systemPrompt, /work preference: work@example.com/);
    assert.match(prompt.systemPrompt, /\/gw-login work@example.com/);
    assert.match(prompt.systemPrompt, /never silently fall back to a personal account/);
    assert.equal(readWorkAccount(root), "work@example.com");
  }
});
