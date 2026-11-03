import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface WorkspaceAccount {
	email: string;
	tokenPath: string;
	authMode?: "cloud" | "local";
	credentialsPath?: string;
	clientId?: string;
	expired?: boolean;
	error?: string;
}

interface ExtensionConfig {
	selectedAccount?: string;
	workAccount?: string;
	[key: string]: unknown;
}

export function normalizeEmail(value: string): string {
	const email = value.trim().toLowerCase();
	if (!/^[^@\s]+@[^@\s]+$/.test(email)) {
		throw new Error(`Invalid email address: ${value}`);
	}
	return canonicalizeGmail(email);
}

// Gmail ignores dots in the local part: first.last@gmail.com and
// firstlast@gmail.com are the same mailbox.
const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

function canonicalizeGmail(email: string): string {
	const at = email.lastIndexOf("@");
	const local = email.slice(0, at);
	const domain = email.slice(at + 1);
	if (!GMAIL_DOMAINS.has(domain)) return email;
	const canonicalLocal = local.replace(/\./g, "");
	return canonicalLocal ? `${canonicalLocal}@${domain}` : email;
}

export function getConfigDir(): string {
	return process.env.GOOGLE_WORKSPACE_CONFIG_DIR || join(homedir(), ".pi", "google-workspace");
}

export function getTokensDir(configDir = getConfigDir()): string {
	return process.env.GOOGLE_WORKSPACE_TOKENS_DIR || join(configDir, "tokens");
}

export function getExtensionConfigPath(configDir = getConfigDir()): string {
	return join(configDir, "pi-extension.json");
}

function emailFromFilename(filename: string): string | undefined {
	if (!filename.endsWith(".json")) return undefined;
	try {
		return normalizeEmail(decodeURIComponent(filename.slice(0, -5)));
	} catch {
		return undefined;
	}
}

export function listAccounts(configDir = getConfigDir()): WorkspaceAccount[] {
	const tokensDir = getTokensDir(configDir);
	if (!existsSync(tokensDir)) return [];

	const accounts: WorkspaceAccount[] = [];
	for (const entry of readdirSync(tokensDir, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		const tokenPath = join(tokensDir, entry.name);
		let email = emailFromFilename(entry.name);

		try {
			const token = JSON.parse(readFileSync(tokenPath, "utf8")) as Record<string, unknown>;
			if (typeof token.__email === "string") email = normalizeEmail(token.__email);
			if (!email) continue;
			const expiry = typeof token.expiry_date === "number" ? token.expiry_date : undefined;
			accounts.push({
				email,
				tokenPath,
				authMode: token.__authMode === "local" || token.__authMode === "cloud" ? token.__authMode : undefined,
				credentialsPath: typeof token.__credentialsPath === "string" ? token.__credentialsPath : undefined,
				clientId: typeof token.__clientId === "string" ? token.__clientId : undefined,
				expired: expiry === undefined ? undefined : expiry < Date.now(),
			});
		} catch (error) {
			if (email) {
				accounts.push({
					email,
					tokenPath,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	return accounts.sort((left, right) => left.email.localeCompare(right.email));
}

function readExtensionConfig(configDir: string): ExtensionConfig {
	const path = getExtensionConfigPath(configDir);
	if (!existsSync(path)) return {};
	try {
		const config: unknown = JSON.parse(readFileSync(path, "utf8"));
		return config && typeof config === "object" && !Array.isArray(config) ? config as ExtensionConfig : {};
	} catch {
		return {};
	}
}

function readAccountPreference(key: "selectedAccount" | "workAccount", configDir: string): string | undefined {
	try {
		const value = readExtensionConfig(configDir)[key];
		return typeof value === "string" ? normalizeEmail(value) : undefined;
	} catch {
		return undefined;
	}
}

export function readSelectedAccount(configDir = getConfigDir()): string | undefined {
	return readAccountPreference("selectedAccount", configDir);
}

export function readWorkAccount(configDir = getConfigDir()): string | undefined {
	return readAccountPreference("workAccount", configDir);
}

function writeAccountPreference(
	key: "selectedAccount" | "workAccount",
	email: string | undefined,
	configDir: string,
): void {
	const config = readExtensionConfig(configDir);
	if (email !== undefined) config[key] = normalizeEmail(email);
	else delete config[key];
	const path = getExtensionConfigPath(configDir);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporaryPath = `${path}.${process.pid}.tmp`;
	writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	renameSync(temporaryPath, path);
	try {
		chmodSync(path, 0o600);
	} catch {
		// Ignore chmod failures on non-POSIX file systems.
	}
}

export function writeSelectedAccount(email: string | undefined, configDir = getConfigDir()): void {
	writeAccountPreference("selectedAccount", email, configDir);
}

export function writeWorkAccount(email: string | undefined, configDir = getConfigDir()): void {
	writeAccountPreference("workAccount", email, configDir);
}

export function resolveSelectedAccount(
	accounts: WorkspaceAccount[],
	configured: string | undefined,
): string | undefined {
	if (configured && accounts.some((account) => account.email === configured && !account.error)) {
		return configured;
	}
	return accounts.find((account) => !account.error)?.email;
}

export function removeAccountToken(email: string, configDir = getConfigDir()): boolean {
	const normalized = normalizeEmail(email);
	const account = listAccounts(configDir).find((candidate) => candidate.email === normalized);
	if (!account || !existsSync(account.tokenPath)) return false;
	rmSync(account.tokenPath);
	return true;
}
