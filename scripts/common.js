#!/usr/bin/env node

// Modified from mitsuhiko/agent-stuff (Apache-2.0): adds per-account OAuth client configuration.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const CONFIG_DIR =
  process.env.GOOGLE_WORKSPACE_CONFIG_DIR ||
  path.join(os.homedir(), '.pi', 'google-workspace');

const CREDENTIALS_PATH =
  process.env.GOOGLE_WORKSPACE_CREDENTIALS ||
  path.join(CONFIG_DIR, 'credentials.json');

const TOKENS_DIR =
  process.env.GOOGLE_WORKSPACE_TOKENS_DIR || path.join(CONFIG_DIR, 'tokens');

const SKILL_ROOT = path.join(__dirname, '..');

const DEFAULT_CLIENT_ID =
  '338689075775-o75k922vn5fdl18qergr96rp8g63e4d7.apps.googleusercontent.com';
const DEFAULT_CLOUD_FUNCTION_URL =
  'https://google-workspace-extension.geminicli.com';

const REQUIRED_IDENTITY_SCOPES = [
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

const DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/chat.spaces',
  'https://www.googleapis.com/auth/chat.messages',
  'https://www.googleapis.com/auth/chat.memberships',
  ...REQUIRED_IDENTITY_SCOPES,
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/directory.readonly',
  'https://www.googleapis.com/auth/presentations.readonly',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
];

const DEFAULT_VERSIONS = {
  calendar: 'v3',
  chat: 'v1',
  docs: 'v1',
  drive: 'v3',
  gmail: 'v1',
  people: 'v1',
  sheets: 'v4',
  slides: 'v1',
};

let runtimeDeps;

function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function ensureTokensDir() {
  fs.mkdirSync(TOKENS_DIR, { recursive: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function installDependencies() {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  console.error('ℹ️  Installing Google Workspace skill dependencies...');

  const result = spawnSync(npm, ['install', '--no-audit', '--no-fund'], {
    cwd: SKILL_ROOT,
    stdio: 'inherit',
  });

  if (result.error) {
    throw new Error(`Failed to run npm install: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(`npm install failed with exit code ${result.status}`);
  }
}

function loadRuntimeDeps() {
  if (runtimeDeps) {
    return runtimeDeps;
  }

  try {
    const { google } = require('googleapis');
    runtimeDeps = { google };
    return runtimeDeps;
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') {
      installDependencies();
      const { google } = require('googleapis');
      runtimeDeps = { google };
      return runtimeDeps;
    }
    throw error;
  }
}

function getGoogleApis() {
  return loadRuntimeDeps().google;
}

function getWorkspaceClientConfig(options = {}) {
  return {
    credentialsPath:
      options.credentialsPath ||
      process.env.GOOGLE_WORKSPACE_CREDENTIALS ||
      CREDENTIALS_PATH,
    clientId:
      options.clientId ||
      process.env.GOOGLE_WORKSPACE_CLIENT_ID ||
      process.env.WORKSPACE_CLIENT_ID ||
      DEFAULT_CLIENT_ID,
    cloudFunctionUrl:
      options.cloudFunctionUrl ||
      process.env.GOOGLE_WORKSPACE_CLOUD_FUNCTION_URL ||
      process.env.WORKSPACE_CLOUD_FUNCTION_URL ||
      DEFAULT_CLOUD_FUNCTION_URL,
  };
}

function credentialsExist(credentialsPath = CREDENTIALS_PATH) {
  return fs.existsSync(credentialsPath);
}

function normalizeEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) {
    throw new Error('Email is required. Pass --email <account@example.com>.');
  }

  if (!/^[^@\s]+@[^@\s]+$/.test(normalized)) {
    throw new Error(`Invalid email address: ${email}`);
  }

  return normalized;
}

function tokenFilenameForEmail(email) {
  return `${encodeURIComponent(normalizeEmail(email))}.json`;
}

function tokenPathForEmail(email) {
  return path.join(TOKENS_DIR, tokenFilenameForEmail(email));
}

function tokenExists(email) {
  return fs.existsSync(tokenPathForEmail(email));
}

function loadCredentialsFile(credentialsPath = CREDENTIALS_PATH) {
  if (!credentialsExist(credentialsPath)) {
    throw new Error(
      `Missing OAuth credentials file at ${credentialsPath}. ` +
        'Create a Google OAuth Desktop client and save the JSON there.',
    );
  }
  return readJson(credentialsPath);
}

function loadToken(email) {
  const tokenPath = tokenPathForEmail(email);
  if (!fs.existsSync(tokenPath)) {
    return null;
  }
  return readJson(tokenPath);
}

function decodeEmailFromTokenFilename(filename) {
  if (!filename.endsWith('.json')) {
    return null;
  }

  try {
    return normalizeEmail(decodeURIComponent(filename.slice(0, -5)));
  } catch {
    return null;
  }
}

function listAccounts() {
  if (!fs.existsSync(TOKENS_DIR)) {
    return [];
  }

  const results = [];
  const entries = fs.readdirSync(TOKENS_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }

    const tokenPath = path.join(TOKENS_DIR, entry.name);
    const emailFromFilename = decodeEmailFromTokenFilename(entry.name);

    let token;
    try {
      token = readJson(tokenPath);
    } catch (error) {
      results.push({
        email: emailFromFilename,
        path: tokenPath,
        error: `Failed to read token JSON: ${error.message}`,
      });
      continue;
    }

    let email = emailFromFilename;
    if (token && token.__email) {
      try {
        email = normalizeEmail(token.__email);
      } catch {
        // Ignore malformed __email metadata and keep filename-derived email.
      }
    }

    const expiryDate = token.expiry_date || null;

    results.push({
      email,
      path: tokenPath,
      authMode: token.__authMode === 'local' || token.__authMode === 'cloud'
        ? token.__authMode
        : null,
      hasAccessToken: Boolean(token.access_token),
      hasRefreshToken: Boolean(token.refresh_token),
      scopes: formatScopes(token.scope),
      expiryDate,
      expired: expiryDate ? expiryDate < Date.now() : null,
    });
  }

  return results.sort((a, b) => {
    const left = a.email || '';
    const right = b.email || '';
    return left.localeCompare(right);
  });
}

function createOAuthClientFromCredentials(credentialsJson, redirectUriOverride) {
  const creds = credentialsJson.installed || credentialsJson.web;
  if (!creds) {
    throw new Error(
      'Invalid credentials.json: expected an "installed" or "web" key.',
    );
  }

  if (!creds.client_id || !creds.client_secret) {
    throw new Error(
      'Invalid credentials.json: missing client_id or client_secret.',
    );
  }

  const redirectUri =
    redirectUriOverride ||
    (Array.isArray(creds.redirect_uris) ? creds.redirect_uris[0] : undefined);

  const google = getGoogleApis();
  return new google.auth.OAuth2(
    creds.client_id,
    creds.client_secret,
    redirectUri || 'http://localhost',
  );
}

function createCloudOAuthClient(clientConfig = getWorkspaceClientConfig()) {
  const google = getGoogleApis();
  return new google.auth.OAuth2({ clientId: clientConfig.clientId });
}

function resolveAuthMode(token, options = {}) {
  if (options.authMode === 'local' || options.authMode === 'cloud') {
    return options.authMode;
  }

  const forced = process.env.GOOGLE_WORKSPACE_AUTH_MODE;
  if (forced === 'local' || forced === 'cloud') {
    return forced;
  }

  if (token && (token.__authMode === 'local' || token.__authMode === 'cloud')) {
    return token.__authMode;
  }

  const credentialsPath =
    options.credentialsPath || token?.__credentialsPath || CREDENTIALS_PATH;
  if (credentialsExist(credentialsPath)) {
    return 'local';
  }

  return 'cloud';
}

function saveToken(email, token, mode, clientConfig = getWorkspaceClientConfig()) {
  ensureConfigDir();
  ensureTokensDir();

  const normalizedEmail = normalizeEmail(email);
  const tokenPath = tokenPathForEmail(normalizedEmail);

  const payload = {
    ...token,
    __authMode: mode,
    __email: normalizedEmail,
    ...(mode === 'local'
      ? { __credentialsPath: clientConfig.credentialsPath }
      : {
          __clientId: clientConfig.clientId,
          __cloudFunctionUrl: clientConfig.cloudFunctionUrl,
        }),
  };

  fs.writeFileSync(tokenPath, JSON.stringify(payload, null, 2));
  try {
    fs.chmodSync(tokenPath, 0o600);
  } catch {
    // Non-POSIX file systems can fail chmod. Ignore.
  }
}

function clearToken(email) {
  const tokenPath = tokenPathForEmail(email);
  if (fs.existsSync(tokenPath)) {
    fs.rmSync(tokenPath);
  }
}

function isExpiringSoon(credentials) {
  if (!credentials || !credentials.expiry_date) {
    return false;
  }
  return credentials.expiry_date < Date.now() + 60_000;
}

function openUrlInBrowser(targetUrl) {
  let command;
  let args;

  if (process.platform === 'darwin') {
    command = 'open';
    args = [targetUrl];
  } else if (process.platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', targetUrl];
  } else {
    command = 'xdg-open';
    args = [targetUrl];
  }

  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

async function refreshViaCloudFunction(
  refreshToken,
  clientConfig = getWorkspaceClientConfig(),
) {
  const { cloudFunctionUrl } = clientConfig;

  const response = await fetch(`${cloudFunctionUrl}/refreshToken`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Cloud token refresh failed: ${response.status} ${body}`);
  }

  return response.json();
}

function mergeWithIdentityScopes(scopes) {
  return Array.from(new Set([...formatScopes(scopes), ...REQUIRED_IDENTITY_SCOPES]));
}

async function fetchAuthenticatedEmail(authClient) {
  const google = getGoogleApis();
  const oauth2 = google.oauth2({ version: 'v2', auth: authClient });
  const response = await oauth2.userinfo.get();
  const email = response?.data?.email;
  if (!email) {
    throw new Error(
      'Authentication succeeded, but Google did not return an email address. ' +
        'Ensure userinfo.email scope is granted.',
    );
  }
  return normalizeEmail(email);
}

async function ensureExpectedEmail(authClient, expectedEmail) {
  const normalizedExpectedEmail = normalizeEmail(expectedEmail);
  const authenticatedEmail = await fetchAuthenticatedEmail(authClient);

  if (authenticatedEmail !== normalizedExpectedEmail) {
    throw new Error(
      `Authenticated as ${authenticatedEmail}, but expected ${normalizedExpectedEmail}. ` +
        'Sign in with the requested account and retry.',
    );
  }

  return authenticatedEmail;
}

async function interactiveLoginLocal(scopes, email, clientConfig) {
  console.error('ℹ️  Opening browser for Google OAuth login (local credentials)...');

  const host = process.env.GOOGLE_WORKSPACE_CALLBACK_HOST || 'localhost';
  const port = await getAvailablePort();
  const callbackUrl = `http://${host}:${port}/oauth2callback`;
  const client = createOAuthClientFromCredentials(
    loadCredentialsFile(clientConfig.credentialsPath),
    callbackUrl,
  );
  const csrfToken = crypto.randomBytes(32).toString('hex');
  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    scope: mergeWithIdentityScopes(scopes),
    state: csrfToken,
    prompt: 'consent',
  });

  const code = await new Promise((resolve, reject) => {
    const loginTimeoutMs = 5 * 60 * 1000;
    const timer = setTimeout(() => {
      server.close(() => reject(new Error('Authentication timed out after 5 minutes.')));
    }, loginTimeoutMs);

    const server = http.createServer((req, res) => {
      try {
        if (!req.url || !req.url.startsWith('/oauth2callback')) {
          res.statusCode = 404;
          res.end('Not found');
          return;
        }

        const parsed = new URL(req.url, callbackUrl);
        if (parsed.searchParams.get('state') !== csrfToken) {
          res.statusCode = 400;
          res.end('State mismatch.');
          clearTimeout(timer);
          server.close(() => reject(new Error('OAuth state mismatch.')));
          return;
        }

        const errorCode = parsed.searchParams.get('error');
        if (errorCode) {
          res.statusCode = 400;
          res.end('Authentication failed.');
          clearTimeout(timer);
          server.close(() => reject(new Error(`Google OAuth error: ${errorCode}`)));
          return;
        }

        const authorizationCode = parsed.searchParams.get('code');
        if (!authorizationCode) {
          res.statusCode = 400;
          res.end('Authentication failed: missing authorization code.');
          clearTimeout(timer);
          server.close(() => reject(new Error('OAuth callback did not include a code.')));
          return;
        }

        res.end('Authentication successful. You can close this tab.');
        clearTimeout(timer);
        server.close(() => resolve(authorizationCode));
      } catch (error) {
        clearTimeout(timer);
        server.close(() => reject(error));
      }
    });

    server.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`OAuth callback server error: ${error.message}`));
    });

    server.listen(port, host, () => {
      try {
        openUrlInBrowser(authUrl);
      } catch {
        console.error('⚠️  Could not auto-open browser. Open this URL manually:');
        console.error(authUrl);
      }
    });
  });

  const tokenResponse = await client.getToken({
    code,
    redirect_uri: callbackUrl,
  });
  client.setCredentials(tokenResponse.tokens);

  if (!client.credentials || !client.credentials.access_token) {
    throw new Error('Authentication failed: no access token returned.');
  }

  const normalizedEmail = await ensureExpectedEmail(client, email);
  saveToken(normalizedEmail, client.credentials, 'local', clientConfig);
  return client;
}

async function interactiveLoginCloud(scopes, email, clientConfig) {
  const client = createCloudOAuthClient(clientConfig);
  const { cloudFunctionUrl } = clientConfig;

  const host = process.env.GOOGLE_WORKSPACE_CALLBACK_HOST || 'localhost';
  const port = await getAvailablePort();
  const callbackUrl = `http://${host}:${port}/oauth2callback`;

  const csrfToken = crypto.randomBytes(32).toString('hex');
  const statePayload = {
    uri: callbackUrl,
    manual: false,
    csrf: csrfToken,
  };
  const state = Buffer.from(JSON.stringify(statePayload), 'utf8').toString(
    'base64',
  );

  const authUrl = client.generateAuthUrl({
    redirect_uri: cloudFunctionUrl,
    access_type: 'offline',
    scope: mergeWithIdentityScopes(scopes),
    state,
    prompt: 'consent',
  });

  console.error('ℹ️  Opening browser for Google OAuth login...');
  try {
    openUrlInBrowser(authUrl);
  } catch {
    console.error('⚠️  Could not auto-open browser. Open this URL manually:');
    console.error(authUrl);
  }

  const loginTimeoutMs = 5 * 60 * 1000;

  const credentials = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close(() => {
        reject(
          new Error(
            'Authentication timed out after 5 minutes. Please try again.',
          ),
        );
      });
    }, loginTimeoutMs);

    const server = http.createServer((req, res) => {
      try {
        if (!req.url || !req.url.startsWith('/oauth2callback')) {
          res.statusCode = 404;
          res.end('Not found');
          return;
        }

        const parsed = new URL(req.url, `http://${host}:${port}`);
        const returnedState = parsed.searchParams.get('state');
        if (returnedState !== csrfToken) {
          res.statusCode = 400;
          res.end('State mismatch.');
          clearTimeout(timer);
          server.close(() => {
            reject(new Error('OAuth state mismatch.'));
          });
          return;
        }

        const errorCode = parsed.searchParams.get('error');
        if (errorCode) {
          const description =
            parsed.searchParams.get('error_description') ||
            'No additional details';
          res.statusCode = 400;
          res.end('Authentication failed.');
          clearTimeout(timer);
          server.close(() => {
            reject(new Error(`Google OAuth error: ${errorCode}. ${description}`));
          });
          return;
        }

        const accessToken = parsed.searchParams.get('access_token');
        const refreshToken = parsed.searchParams.get('refresh_token');
        const scope = parsed.searchParams.get('scope');
        const tokenType = parsed.searchParams.get('token_type');
        const expiryDateRaw = parsed.searchParams.get('expiry_date');

        if (!accessToken || !expiryDateRaw) {
          res.statusCode = 400;
          res.end('Authentication failed: missing tokens.');
          clearTimeout(timer);
          server.close(() => {
            reject(
              new Error('Authentication failed: callback did not include tokens.'),
            );
          });
          return;
        }

        const expiryDate = Number.parseInt(expiryDateRaw, 10);
        if (Number.isNaN(expiryDate)) {
          res.statusCode = 400;
          res.end('Authentication failed: invalid expiry date.');
          clearTimeout(timer);
          server.close(() => {
            reject(
              new Error('Authentication failed: callback expiry_date is invalid.'),
            );
          });
          return;
        }

        const creds = {
          access_token: accessToken,
          refresh_token: refreshToken || null,
          scope: scope || undefined,
          token_type: tokenType || undefined,
          expiry_date: expiryDate,
        };

        res.end('Authentication successful. You can close this tab.');

        clearTimeout(timer);
        server.close(() => {
          resolve(creds);
        });
      } catch (error) {
        clearTimeout(timer);
        server.close(() => {
          reject(error);
        });
      }
    });

    server.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`OAuth callback server error: ${error.message}`));
    });

    server.listen(port, host, () => {
      // listener started
    });
  });

  client.setCredentials(credentials);
  const normalizedEmail = await ensureExpectedEmail(client, email);
  saveToken(normalizedEmail, credentials, 'cloud', clientConfig);
  return client;
}

async function interactiveLogin(scopes, mode, email, clientConfig) {
  if (mode === 'local') {
    return interactiveLoginLocal(scopes, email, clientConfig);
  }
  return interactiveLoginCloud(scopes, email, clientConfig);
}

function stripInternalTokenFields(token) {
  if (!token || typeof token !== 'object') {
    return token;
  }
  const clone = { ...token };
  delete clone.__authMode;
  delete clone.__email;
  delete clone.__credentialsPath;
  delete clone.__clientId;
  delete clone.__cloudFunctionUrl;
  return clone;
}

async function authorize(options = {}) {
  const email = normalizeEmail(options.email);
  const scopes = mergeWithIdentityScopes(options.scopes || DEFAULT_SCOPES);
  const interactive = options.interactive !== false;

  ensureConfigDir();
  ensureTokensDir();
  loadRuntimeDeps();

  const token = loadToken(email);
  const clientConfig = getWorkspaceClientConfig({
    credentialsPath: options.credentialsPath || token?.__credentialsPath,
    clientId: options.clientId || token?.__clientId,
    cloudFunctionUrl: options.cloudFunctionUrl || token?.__cloudFunctionUrl,
  });
  const mode = resolveAuthMode(token, {
    authMode: options.authMode || (options.credentialsPath ? 'local' : undefined),
    credentialsPath: clientConfig.credentialsPath,
  });

  const client =
    mode === 'local'
      ? createOAuthClientFromCredentials(
          loadCredentialsFile(clientConfig.credentialsPath),
        )
      : createCloudOAuthClient(clientConfig);

  if (options.forceLogin) {
    if (!interactive) {
      throw new Error('forceLogin requires interactive authentication.');
    }
    return interactiveLogin(scopes, mode, email, clientConfig);
  }

  if (!token) {
    if (!interactive) {
      throw new Error(
        `No token found for ${email} at ${tokenPathForEmail(email)}. ` +
          `Run: node scripts/auth.js login --email ${email}`,
      );
    }
    return interactiveLogin(scopes, mode, email, clientConfig);
  }

  if (token.__email) {
    const tokenEmail = normalizeEmail(token.__email);
    if (tokenEmail !== email) {
      throw new Error(
        `Token metadata mismatch. Requested ${email} but token is tagged as ${tokenEmail}. ` +
          `Delete it and sign in again: node scripts/auth.js clear --email ${email}`,
      );
    }
  }

  client.setCredentials(stripInternalTokenFields(token));

  if (!isExpiringSoon(client.credentials)) {
    return client;
  }

  if (client.credentials.refresh_token) {
    if (mode === 'local') {
      const refreshed = await client.refreshAccessToken();
      const merged = {
        ...refreshed.credentials,
        refresh_token:
          refreshed.credentials.refresh_token || client.credentials.refresh_token,
      };
      client.setCredentials(merged);
      saveToken(email, merged, 'local', clientConfig);
      return client;
    }

    const refreshed = await refreshViaCloudFunction(
      client.credentials.refresh_token,
      clientConfig,
    );
    const merged = {
      ...refreshed,
      refresh_token: client.credentials.refresh_token,
    };
    client.setCredentials(merged);
    saveToken(email, merged, 'cloud', clientConfig);
    return client;
  }

  if (!interactive) {
    throw new Error(
      `Token for ${email} is expired and no refresh token is available. ` +
        `Run: node scripts/auth.js login --email ${email}`,
    );
  }

  return interactiveLogin(scopes, mode, email, clientConfig);
}

function formatScopes(value) {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  return String(value)
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

module.exports = {
  CONFIG_DIR,
  CREDENTIALS_PATH,
  TOKENS_DIR,
  DEFAULT_SCOPES,
  DEFAULT_VERSIONS,
  REQUIRED_IDENTITY_SCOPES,
  authorize,
  clearToken,
  credentialsExist,
  formatScopes,
  getGoogleApis,
  getWorkspaceClientConfig,
  listAccounts,
  loadToken,
  normalizeEmail,
  resolveAuthMode,
  tokenExists,
  tokenPathForEmail,
};
