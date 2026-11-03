---
name: google-workspace
description: Access Google Workspace APIs (Gmail, Drive, Calendar, Docs, Sheets, Slides, Chat, and People) through the Pi google_workspace tool with explicit multi-account selection.
license: Apache-2.0
---

# Google Workspace for Pi

Use the `google_workspace` tool for Google Workspace tasks. The Pi footer always shows the active account as `email@example.com`.

## Account safety

- By default the tool uses the active account shown in Pi's footer.
- To query a different signed-in account for one call, pass the optional `account` parameter (an email). This does not change the footer selection. The system prompt lists the other signed-in accounts.
- For tasks spanning several mailboxes, call the tool once per account with `account` set and report results per account.
- If an account is not signed in, ask the user to run `/gw-login email@example.com`; you cannot sign in on their behalf.
- Never claim that a request used an account that was not actually used (check the `email` field in the tool output).
- Use `/gw-status` if account identity is relevant, or execute `return await workspace.whoAmI();` to verify it with Google.
- On a 401/403 error, ask the user to re-login or switch accounts; do not expose token contents.

## Tool environment

The `script` parameter is an async JavaScript function body with these globals:

- `auth` — authorized OAuth client
- `google` — the `googleapis` root
- `workspace.accountEmail` — active profile email
- `workspace.call(service, methodPath, params, { version })`
- `workspace.service(service, { version })`
- `workspace.whoAmI()`

Example:

```js
const me = await workspace.whoAmI();
const files = await workspace.call('drive', 'files.list', {
  pageSize: 5,
  fields: 'files(id,name,mimeType)',
});
return { me, files: files.files };
```

## Agent guidance

1. Prefer one `google_workspace` call per user request.
2. Keep payloads small with `fields`, `maxResults`, and minimal properties.
3. Use `Promise.all` for independent requests.
4. Return JSON-serializable data and never print OAuth tokens.
5. Use the active account; account-changing commands are user-facing controls.
6. For Gmail, use `userId: 'me'` unless the user explicitly requires otherwise.
7. Respect the persistent work-account preference supplied in the system prompt. Unless explicitly overridden by the user, pass that work email as `account` for all work-related Workspace tasks, create work Docs/Sheets in that account, and use it as both sender and recipient when the user asks to "email me" work material. Personal tasks can still use the selected account. If the preferred work account is not signed in, ask for `/gw-login`; never silently fall back to personal. This preference is agent guidance: omitted `account` still uses the selected account.

## User account commands

Native Pi slash commands:

- `/gw` — pick an account
- `/gw-use email@example.com` — select an account
- `/gw-next` and `/gw-prev` — cycle accounts
- `/gw-status` — show the active account
- `/gw-work [email@example.com|clear]` — show, set, or clear the persistent work-account and work-email recipient preference
- `/gw-login email@example.com` — sign in with the default cloud OAuth flow
- `/gw-login email@example.com --credentials /path/to/credentials.json` — sign in with a local OAuth client
- `/gw-logout [email@example.com]` — remove one account token after confirmation

Literal backslash aliases (`\gw`, `\gw-next`, `\gw-prev`, etc.) are also supported.
