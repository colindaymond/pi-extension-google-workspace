# pi-extension-google-workspace

A [Pi](https://pi.dev) package for Gmail, Drive, Calendar, Docs, Sheets, Slides, Chat, and People. It adapts the Apache-2.0 [`google-workspace` skill](https://github.com/mitsuhiko/agent-stuff/tree/main/skills/google-workspace) by Armin Ronacher's `agent-stuff` repository into a first-class Pi extension.

## What it adds

- `google_workspace`, a model-callable tool (no MCP server)
- independent OAuth token profiles for multiple Google accounts
- a persistent, very small footer indicator: `you@example.com`
- quick account selection and cycling
- a persistent work-account preference for work tasks and "email me" recipients
- both native Pi `/slash` commands and literal `\backslash` aliases
- optional separate OAuth client credentials for each account
- a bundled skill that teaches Pi to use the tool safely

> Google Workspace user data normally uses **OAuth client credentials and user tokens**, not ordinary API keys. This package stores one token per email. Each account can remember a different local OAuth `credentials.json`, or a different cloud OAuth client/broker configuration.

## Install

```bash
pi install npm:pi-extension-google-workspace
```

For local development:

```bash
pi install /absolute/path/to/pi-extension-google-workspace
```

Restart Pi or run `/reload` after installation.

## Commands

| Native command | Literal alias | Purpose |
|---|---|---|
| `/gw` | `\gw` | Pick an account |
| `/gw-use EMAIL` | `\gw-use EMAIL` | Select an account directly |
| `/gw-next` | `\gw-next` | Cycle forward |
| `/gw-prev` | `\gw-prev` | Cycle backward |
| `/gw-status` | `\gw-status` | Show the active account |
| `/gw-work [EMAIL\|clear]` | `\gw-work [EMAIL\|clear]` | Show, set, or clear the work-account preference |
| `/gw-login EMAIL` | `\gw-login EMAIL` | Add or refresh an account |
| `/gw-logout [EMAIL]` | `\gw-logout [EMAIL]` | Remove an account token |

The selected account is global and persists across Pi sessions in `~/.pi/google-workspace/pi-extension.json`.

## Authentication

### Easiest: upstream cloud OAuth flow

```text
/gw-login you@example.com
```

This preserves the upstream skill's default cloud flow and uses its default OAuth client and broker at `google-workspace-extension.geminicli.com`. Review that trust choice before using sensitive Workspace data.

### Recommended for full control: your own local OAuth client

1. In Google Cloud Console, enable the APIs you need.
2. Create an **OAuth 2.0 Desktop app** credential and download its JSON file.
3. Login with that file:

```text
/gw-login work@example.com --credentials "/secure/path/work-credentials.json"
/gw-login personal@example.com --credentials "/secure/path/personal-credentials.json"
```

The token for each email remembers its own credentials path, so cycling accounts can also cycle OAuth clients.

### Custom cloud broker

If you operate a broker compatible with the upstream `/refreshToken` flow:

```text
/gw-login you@example.com --client-id YOUR_CLIENT_ID --cloud-function-url https://broker.example.com
```

The client ID and broker URL are remembered with that account. Do not combine these flags with `--credentials`.

## Using the tool

The model supplies an async JavaScript body. It receives `auth`, `google`, and `workspace`:

```js
const me = await workspace.whoAmI();
const events = await workspace.call('calendar', 'events.list', {
  calendarId: 'primary',
  maxResults: 10,
  singleEvents: true,
  orderBy: 'startTime',
});
return { me: me.email, events: events.items };
```

### Targeting a specific account

The tool defaults to the account selected with `/gw`. The model can pass an optional `account` parameter (an email of any signed-in account) to run a single call against another mailbox without changing the selection — useful for searching several inboxes in one task. The system prompt lists the other signed-in accounts so the model knows what is available. Accounts that are not signed in still require the user to run `/gw-login`.

### Work-account preference

Configure a work default once:

```text
/gw-work work@example.com
```

Pi remembers this preference across sessions and adds it to the agent's instructions. Work-related Gmail, Drive, Docs, Sheets, Calendar, and other Workspace requests should use this account explicitly. When you ask to "email me" about work, the agent should send from this account to the same work address. Explicit account or recipient instructions override the preference.

This is agent guidance, not a keyword classifier or a silent tool-level account override: a call without `account` still uses the selected account. `/gw-work` does not change `/gw` selection, so personal tasks can still use your selected personal account. If the work account is logged out, the agent should ask you to sign in rather than fall back to personal. Setting a preference requires a usable signed-in account.

Use `/gw-work` to inspect the preference or `/gw-work clear` to remove it. Existing documents are not automatically moved or shared. After updating the extension code, run `/reload` once; later preference changes are read on each agent run without reloading.

Tool output is capped at 50KB or 2,000 lines. Full oversized output is written to a mode-`0600` temporary file and its path is reported.

## Storage and security

- Tokens: `~/.pi/google-workspace/tokens/<encoded-email>.json` (mode `0600` when created)
- Selection and work preference: `~/.pi/google-workspace/pi-extension.json` (`selectedAccount`, `workAccount`)
- Default local OAuth credentials: `~/.pi/google-workspace/credentials.json`
- Override root: `GOOGLE_WORKSPACE_CONFIG_DIR`
- Override token directory: `GOOGLE_WORKSPACE_TOKENS_DIR`

Extensions execute with your full user permissions. Review the package before installing it. The execution sandbox intentionally exposes Google API clients but does not expose `require` or `process` to generated scripts.

## Development

```bash
npm install
npm run check
npm run pack:check
```

## Attribution

The OAuth and API helper scripts are modified from `mitsuhiko/agent-stuff` revision `13bc8f87970bec8830aab0f1c0487d35aa7c0917`, licensed under Apache-2.0. See [NOTICE](NOTICE) and [LICENSE](LICENSE).
