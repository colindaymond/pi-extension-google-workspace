import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

const authScript = join(import.meta.dirname, "..", "scripts", "auth.js");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gws-auth-test-"));
  mkdirSync(join(root, "tokens"), { recursive: true });
  return root;
}

function writeToken(root: string, email: string, token: Record<string, unknown>) {
  writeFileSync(
    join(root, "tokens", `${encodeURIComponent(email)}.json`),
    JSON.stringify({ __email: email, access_token: "secret-not-printed", ...token }),
  );
}

function status(root: string, email: string): string {
  return execFileSync(process.execPath, [authScript, "status", "--email", email], {
    encoding: "utf8",
    env: { ...process.env, GOOGLE_WORKSPACE_CONFIG_DIR: root },
  });
}

test("status resolves local OAuth credentials per account without printing tokens", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const credentialsPath = join(root, "clients", "work.json");
  writeToken(root, "work@example.com", {
    __authMode: "local",
    __credentialsPath: credentialsPath,
  });

  const output = status(root, "work@example.com");
  assert.match(output, new RegExp(credentialsPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(output, /Auth mode:\n  local/);
  assert.doesNotMatch(output, /secret-not-printed/);
});

test("status resolves a separate cloud client and broker per account", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  writeToken(root, "cloud@example.com", {
    __authMode: "cloud",
    __clientId: "12345-example.apps.googleusercontent.com",
    __cloudFunctionUrl: "https://oauth.example.com",
  });

  const output = status(root, "cloud@example.com");
  assert.match(output, /clientId: \*\*\*-example\.apps\.googleusercontent\.com/);
  assert.match(output, /cloudFunctionUrl: https:\/\/oauth\.example\.com/);
});
