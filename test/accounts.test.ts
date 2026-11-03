import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  listAccounts,
  normalizeEmail,
  readSelectedAccount,
  readWorkAccount,
  removeAccountToken,
  resolveSelectedAccount,
  writeSelectedAccount,
  writeWorkAccount,
} from "../extensions/accounts.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gws-accounts-test-"));
  mkdirSync(join(root, "tokens"), { recursive: true });
  return root;
}

test("normalizes and validates email addresses", () => {
  assert.equal(normalizeEmail(" User@Example.COM "), "user@example.com");
  assert.throws(() => normalizeEmail("not-an-email"), /Invalid email/);
});

test("ignores dots in Gmail local parts only", () => {
  assert.equal(normalizeEmail("First.Last@gmail.com"), "firstlast@gmail.com");
  assert.equal(normalizeEmail("firstlast@gmail.com"), "firstlast@gmail.com");
  assert.equal(normalizeEmail("a.b@googlemail.com"), "ab@googlemail.com");
  assert.equal(normalizeEmail("first.last@example.com"), "first.last@example.com");
});

test("lists independent account credential profiles", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  writeFileSync(
    join(root, "tokens", `${encodeURIComponent("work@example.com")}.json`),
    JSON.stringify({
      __email: "work@example.com",
      __authMode: "local",
      __credentialsPath: "/keys/work.json",
      expiry_date: Date.now() + 60_000,
    }),
  );
  writeFileSync(
    join(root, "tokens", `${encodeURIComponent("home@example.com")}.json`),
    JSON.stringify({
      __email: "home@example.com",
      __authMode: "cloud",
      __clientId: "client-id",
      expiry_date: Date.now() - 1,
    }),
  );

  const accounts = listAccounts(root);
  assert.deepEqual(accounts.map((account) => account.email), ["home@example.com", "work@example.com"]);
  assert.equal(accounts[0].clientId, "client-id");
  assert.equal(accounts[0].expired, true);
  assert.equal(accounts[1].credentialsPath, "/keys/work.json");
});

test("persists selection securely and falls back to a usable account", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  writeSelectedAccount("USER@example.com", root);
  assert.equal(readSelectedAccount(root), "user@example.com");
  assert.match(readFileSync(join(root, "pi-extension.json"), "utf8"), /user@example.com/);

  const accounts = [
    { email: "a@example.com", tokenPath: "/a", error: "bad" },
    { email: "b@example.com", tokenPath: "/b" },
  ];
  assert.equal(resolveSelectedAccount(accounts, "a@example.com"), "b@example.com");
  assert.equal(resolveSelectedAccount(accounts, "b@example.com"), "b@example.com");
});

test("removes only the requested account token", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const tokenPath = join(root, "tokens", `${encodeURIComponent("user@example.com")}.json`);
  writeFileSync(tokenPath, JSON.stringify({ __email: "user@example.com" }));
  assert.equal(removeAccountToken("user@example.com", root), true);
  assert.equal(removeAccountToken("user@example.com", root), false);
});

test("work preference survives selection changes and preserves other settings", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "pi-extension.json");
  writeFileSync(path, JSON.stringify({ selectedAccount: "home@example.com", futureSetting: true }));
  writeWorkAccount(" WORK@Example.com ", root);
  assert.equal(readWorkAccount(root), "work@example.com");
  assert.equal(readSelectedAccount(root), "home@example.com");
  writeSelectedAccount("other@example.com", root);
  assert.equal(readWorkAccount(root), "work@example.com");
  assert.equal(JSON.parse(readFileSync(path, "utf8")).futureSetting, true);
  writeSelectedAccount(undefined, root);
  assert.equal(readSelectedAccount(root), undefined);
  assert.equal(readWorkAccount(root), "work@example.com");
  writeSelectedAccount("home@example.com", root);
  writeWorkAccount(undefined, root);
  assert.equal(readWorkAccount(root), undefined);
  assert.equal(readSelectedAccount(root), "home@example.com");
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("work preference handles invalid and legacy configuration safely", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "pi-extension.json");
  assert.equal(readWorkAccount(root), undefined);
  writeSelectedAccount("home@example.com", root);
  assert.equal(readWorkAccount(root), undefined);
  assert.throws(() => writeWorkAccount("not-an-email", root), /Invalid email/);
  assert.equal(readSelectedAccount(root), "home@example.com");
  writeFileSync(path, JSON.stringify({ selectedAccount: "home@example.com", workAccount: "bad" }));
  assert.equal(readWorkAccount(root), undefined);
  assert.equal(readSelectedAccount(root), "home@example.com");
  writeFileSync(path, "broken json");
  assert.equal(readWorkAccount(root), undefined);
  writeWorkAccount("work@example.com", root);
  assert.equal(readWorkAccount(root), "work@example.com");
});
