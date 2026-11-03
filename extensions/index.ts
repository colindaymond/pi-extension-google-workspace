import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	getConfigDir,
	listAccounts,
	normalizeEmail,
	readSelectedAccount,
	readWorkAccount,
	removeAccountToken,
	resolveSelectedAccount,
	writeSelectedAccount,
	writeWorkAccount,
	type WorkspaceAccount,
} from "./accounts.js";

const AUTH_SCRIPT = fileURLToPath(new URL("../scripts/auth.js", import.meta.url));
const WORKSPACE_SCRIPT = fileURLToPath(new URL("../scripts/workspace.js", import.meta.url));

function splitArguments(input: string): string[] {
	const parts: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaping = false;

	for (const character of input.trim()) {
		if (escaping) {
			current += character;
			escaping = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaping = true;
			continue;
		}
		if (quote) {
			if (character === quote) quote = undefined;
			else current += character;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		if (/\s/.test(character)) {
			if (current) {
				parts.push(current);
				current = "";
			}
			continue;
		}
		current += character;
	}

	if (escaping || quote) throw new Error("Unterminated quote or escape in command arguments.");
	if (current) parts.push(current);
	return parts;
}

function accountSummary(account: WorkspaceAccount): string {
	const mode = account.authMode ? ` · ${account.authMode}` : "";
	const expired = account.expired ? " · refresh needed" : "";
	return `${account.email}${mode}${expired}`;
}

function saveFullOutput(output: string): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-google-workspace-"));
	const path = join(directory, "output.json");
	writeFileSync(path, output, { mode: 0o600 });
	return path;
}

function boundedOutput(output: string): { text: string; fullOutputPath?: string } {
	const truncation = truncateHead(output, {
		maxBytes: DEFAULT_MAX_BYTES,
		maxLines: DEFAULT_MAX_LINES,
	});
	if (!truncation.truncated) return { text: truncation.content };

	const fullOutputPath = saveFullOutput(output);
	return {
		text:
			`${truncation.content}\n\n` +
			`[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines ` +
			`(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). ` +
			`Full output saved to: ${fullOutputPath}]`,
		fullOutputPath,
	};
}

export default function googleWorkspaceExtension(pi: ExtensionAPI) {
	const configDir = getConfigDir();
	let accounts: WorkspaceAccount[] = [];
	let selectedAccount: string | undefined;

	function refreshState(): void {
		accounts = listAccounts(configDir);
		const resolved = resolveSelectedAccount(accounts, readSelectedAccount(configDir));
		selectedAccount = resolved;
		if (resolved !== readSelectedAccount(configDir)) writeSelectedAccount(resolved, configDir);
	}

	function usableAccounts(): WorkspaceAccount[] {
		return accounts.filter((account) => !account.error);
	}

	function resolveToolAccount(requested: string | undefined): string {
		if (requested?.trim()) {
			const normalized = normalizeEmail(requested);
			const account = usableAccounts().find((candidate) => candidate.email === normalized);
			if (!account) {
				const available = usableAccounts().map((candidate) => candidate.email);
				throw new Error(
					`No signed-in Google Workspace account found for ${normalized}. ` +
						(available.length
							? `Signed-in accounts: ${available.join(", ")}. `
							: "") +
						`Ask the user to run /gw-login ${normalized}.`,
				);
			}
			return normalized;
		}
		if (!selectedAccount) {
			throw new Error("No Google Workspace account is selected. Use /gw-login or /gw first.");
		}
		return selectedAccount;
	}

	function selectAccount(email: string, ctx: ExtensionContext): void {
		const normalized = normalizeEmail(email);
		const account = accounts.find((candidate) => candidate.email === normalized && !candidate.error);
		if (!account) throw new Error(`No signed-in Google Workspace account found for ${normalized}.`);
		selectedAccount = normalized;
		writeSelectedAccount(normalized, configDir);
		ctx.ui.notify(`Google Workspace: ${normalized}`, "info");
	}

	async function chooseAccount(args: string, ctx: ExtensionContext): Promise<void> {
		refreshState();
		if (args.trim()) {
			selectAccount(args.trim(), ctx);
			return;
		}
		if (accounts.length === 0) {
			ctx.ui.notify("No Google Workspace accounts. Use /gw-login email@example.com", "warning");
			return;
		}
		if (!ctx.hasUI) {
			ctx.ui.notify(`Google Workspace: ${selectedAccount ?? "no account"}`, "info");
			return;
		}
		const labels = accounts.map((account) =>
			`${account.email === selectedAccount ? "● " : "  "}${accountSummary(account)}`,
		);
		const choice = await ctx.ui.select("Google Workspace account", labels);
		if (!choice) return;
		selectAccount(choice.replace(/^[● ]+/, "").split(" · ")[0], ctx);
	}

	function cycleAccount(direction: 1 | -1, ctx: ExtensionContext): void {
		refreshState();
		const usable = accounts.filter((account) => !account.error);
		if (usable.length === 0) {
			ctx.ui.notify("No Google Workspace accounts. Use /gw-login first.", "warning");
			return;
		}
		const currentIndex = usable.findIndex((account) => account.email === selectedAccount);
		const nextIndex = currentIndex < 0
			? direction === 1 ? 0 : usable.length - 1
			: (currentIndex + direction + usable.length) % usable.length;
		selectAccount(usable[nextIndex].email, ctx);
	}

	function showStatus(ctx: ExtensionContext): void {
		refreshState();
		const account = accounts.find((candidate) => candidate.email === selectedAccount);
		ctx.ui.notify(
			account ? `Google Workspace: ${accountSummary(account)}` : "Google Workspace: no account selected",
			account ? "info" : "warning",
		);
	}

	function configureWorkAccount(args: string, ctx: ExtensionContext): void {
		refreshState();
		const value = args.trim();
		if (!value) {
			ctx.ui.notify(`Google Workspace work account: ${readWorkAccount(configDir) ?? "not configured"}`, "info");
			return;
		}
		if (value.toLowerCase() === "clear") {
			writeWorkAccount(undefined, configDir);
			ctx.ui.notify("Cleared the Google Workspace work-account preference.", "info");
			return;
		}
		const email = resolveToolAccount(value);
		writeWorkAccount(email, configDir);
		ctx.ui.notify(`Work-related Google Workspace tasks and work emails to you will use ${email}.`, "info");
	}

	async function login(rawArgs: string, ctx: ExtensionContext): Promise<void> {
		const args = splitArguments(rawArgs);
		const email = args.shift();
		if (!email) throw new Error("Usage: /gw-login email@example.com [--credentials /path/to/credentials.json]");
		normalizeEmail(email);
		ctx.ui.notify(`Opening Google login for ${email}…`, "info");
		const result = await pi.exec(process.execPath, [AUTH_SCRIPT, "login", "--email", email, ...args], {
			timeout: 5 * 60_000,
		});
		if (result.code !== 0) {
			const output = boundedOutput([result.stderr, result.stdout].filter(Boolean).join("\n")).text;
			throw new Error(output || `Google login exited with code ${result.code}.`);
		}
		refreshState();
		selectAccount(email, ctx);
	}

	async function logout(rawEmail: string, ctx: ExtensionContext): Promise<void> {
		refreshState();
		const email = normalizeEmail(rawEmail.trim() || selectedAccount || "");
		if (!accounts.some((account) => account.email === email)) {
			throw new Error(`No signed-in Google Workspace account found for ${email}.`);
		}
		if (ctx.hasUI) {
			const confirmed = await ctx.ui.confirm("Remove Google Workspace login?", email);
			if (!confirmed) return;
		} else {
			throw new Error("Account removal requires interactive confirmation.");
		}
		removeAccountToken(email, configDir);
		refreshState();
		ctx.ui.notify(`Removed Google Workspace login for ${email}`, "info");
	}

	const accountCompletions = (prefix: string) => {
		refreshState();
		const matches = accounts.filter((account) => account.email.startsWith(prefix));
		return matches.length ? matches.map((account) => ({ value: account.email, label: account.email })) : null;
	};

	pi.registerCommand("gw", {
		description: "Pick the active Google Workspace account",
		getArgumentCompletions: accountCompletions,
		handler: chooseAccount,
	});
	pi.registerCommand("gw-use", {
		description: "Select a Google Workspace account by email",
		getArgumentCompletions: accountCompletions,
		handler: chooseAccount,
	});
	pi.registerCommand("gw-next", {
		description: "Cycle to the next Google Workspace account",
		handler: async (_args, ctx) => cycleAccount(1, ctx),
	});
	pi.registerCommand("gw-prev", {
		description: "Cycle to the previous Google Workspace account",
		handler: async (_args, ctx) => cycleAccount(-1, ctx),
	});
	pi.registerCommand("gw-status", {
		description: "Show the active Google Workspace account",
		handler: async (_args, ctx) => showStatus(ctx),
	});
	pi.registerCommand("gw-work", {
		description: "Show or set the work account and work email recipient: [EMAIL|clear]",
		getArgumentCompletions: (prefix) => {
			const matches = accountCompletions(prefix) ?? [];
			if ("clear".startsWith(prefix)) matches.push({ value: "clear", label: "clear work preference" });
			return matches.length ? matches : null;
		},
		handler: async (args, ctx) => configureWorkAccount(args, ctx),
	});
	pi.registerCommand("gw-login", {
		description: "Sign in a Google Workspace account",
		handler: login,
	});
	pi.registerCommand("gw-logout", {
		description: "Remove a Google Workspace account token",
		getArgumentCompletions: accountCompletions,
		handler: logout,
	});

	pi.on("input", async (event, ctx) => {
		const match = event.text.trim().match(/^\\(gw|gw-use|gw-next|gw-prev|gw-status|gw-work|gw-login|gw-logout)(?:\s+(.*))?$/);
		if (!match) return { action: "continue" };
		const [, command, args = ""] = match;
		if (command === "gw" || command === "gw-use") await chooseAccount(args, ctx);
		else if (command === "gw-next") cycleAccount(1, ctx);
		else if (command === "gw-prev") cycleAccount(-1, ctx);
		else if (command === "gw-status") showStatus(ctx);
		else if (command === "gw-work") configureWorkAccount(args, ctx);
		else if (command === "gw-login") await login(args, ctx);
		else if (command === "gw-logout") await logout(args, ctx);
		return { action: "handled" };
	});

	pi.registerTool({
		name: "google_workspace",
		label: "Google Workspace",
		description:
			"Execute JavaScript against Google Workspace APIs. By default uses the account selected with /gw; " +
			"pass `account` to target any other signed-in account for this call (e.g. to search several mailboxes). " +
			"The script has auth, google, and workspace helpers and must return a JSON-serializable result. " +
			"Output is limited to 50KB or 2000 lines.",
		promptSnippet: "Call Google Workspace APIs (Gmail, Drive, Calendar, Docs, Sheets, Slides, Chat, People)",
		promptGuidelines: [
			"Use google_workspace for Google Workspace requests and keep API payloads small with fields/maxResults.",
			"The google_workspace tool uses the currently selected GWS account unless the `account` parameter names another signed-in account; when a task spans multiple mailboxes, call the tool once per account with `account` set, and never claim to have queried an account that was not actually used.",
			"Respect the work-account preference supplied in the system prompt: use that account explicitly for work tasks and as the recipient when the user asks to email work material to themselves, unless they explicitly specify another account or recipient.",
		],
		parameters: Type.Object({
			script: Type.String({
				description:
					"Async function body. Available globals: auth, google, workspace. Example: return await workspace.whoAmI();",
			}),
			timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 300_000, description: "Timeout in milliseconds" })),
			scopes: Type.Optional(Type.Array(Type.String(), { description: "Optional OAuth scopes" })),
			account: Type.Optional(
				Type.String({
					description:
						"Email of a signed-in Google Workspace account to use for this call instead of the selected one. " +
						"Does not change the selected account.",
				}),
			),
		}),
		async execute(_toolCallId, params, signal) {
			refreshState();
			const email = resolveToolAccount(params.account);
			const timeout = params.timeout ?? 30_000;
			const args = [
				WORKSPACE_SCRIPT,
				"exec",
				"--email",
				email,
				"--timeout",
				String(timeout),
				"--script",
				params.script,
			];
			if (params.scopes?.length) args.push("--scopes", params.scopes.join(","));

			const result = await pi.exec(process.execPath, args, { signal, timeout: timeout + 5_000 });
			const rawOutput = result.stdout.trim();
			if (result.code !== 0) {
				const failure = [rawOutput, result.stderr.trim()].filter(Boolean).join("\n");
				throw new Error(boundedOutput(failure).text || `Google Workspace request exited with code ${result.code}.`);
			}
			const output = boundedOutput(rawOutput || JSON.stringify({ ok: true, email, result: null }));
			return {
				content: [{ type: "text", text: output.text }],
				details: { email, fullOutputPath: output.fullOutputPath },
			};
		},
	});

	pi.on("session_start", async () => {
		refreshState();
	});

	pi.on("before_agent_start", async (event) => {
		refreshState();
		const others = usableAccounts()
			.map((account) => account.email)
			.filter((email) => email !== selectedAccount);
		const othersContext = others.length
			? ` Other signed-in accounts available via the google_workspace \`account\` parameter: ${others.join(", ")}.`
			: " No other Google Workspace accounts are signed in; use /gw-login to add one.";
		const accountContext = selectedAccount
			? `The active Google Workspace account is ${selectedAccount}. The google_workspace tool uses it by default.${othersContext}`
			: "No Google Workspace account is selected. Ask the user to run /gw or /gw-login before using google_workspace.";
		const workAccount = readWorkAccount(configDir);
		const workContext = workAccount
			? `\n\nGoogle Workspace work preference: ${workAccount}. Unless the user explicitly specifies another account or recipient, use google_workspace with account=${JSON.stringify(workAccount)} for all work-related email, documents, spreadsheets, calendar, and other Workspace tasks. Create work files in that account. When the user asks to email work material to themselves (\"email me\"), send from this account to ${workAccount}, not to the selected personal account. This preference persists even when /gw selects a different account; personal tasks still use the selected account. If the work account is not signed in, ask the user to run /gw-login ${workAccount}; never silently fall back to a personal account for work.`
			: "";
		return { systemPrompt: `${event.systemPrompt}\n\n${accountContext}${workContext}` };
	});
}
