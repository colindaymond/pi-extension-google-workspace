import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import googleWorkspaceExtension from "../extensions/index.js";

test("registers the Workspace tool, account commands, status, and backslash aliases", async (t) => {
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
    ["gw", "gw-use", "gw-next", "gw-prev", "gw-status", "gw-login", "gw-logout"],
  );
  assert.deepEqual(tools.map((tool) => tool.name), ["google_workspace"]);
  assert.ok(listeners.has("session_start"));
  assert.ok(listeners.has("before_agent_start"));
  assert.ok(listeners.has("input"));

  let statusText = "";
  const context = {
    hasUI: false,
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus: (_id: string, text: string) => { statusText = text; },
      notify: () => undefined,
    },
  };
  await listeners.get("session_start")?.({}, context);
  assert.equal(statusText, "no account");

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
