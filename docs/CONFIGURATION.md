# Configuration and hardening guide

For administrators deploying **Containers** (Multi-Account Containers for Chrome) to managed computers, where containers hold sessions for other organizations' admin portals. It covers what the extension stores, every setting you can enforce through Chrome policy, recommended values, and offboarding.

Read the README's **Security model** first. In short, containers prevent *accidental* cross-account sign-in. They are not a security boundary against a malicious website.

## What it stores, and where

| Data | Where | Protected by |
|---|---|---|
| Container names, colours, emoji, order | `chrome.storage.local` (the profile folder) | Nothing beyond the profile's own protection |
| Assigned sites ("always open in") | `chrome.storage.local` | Same |
| Each container's cookies | `chrome.storage.local`, sealed | AES-256-GCM, one key per container |
| Each container's key | `chrome.storage.session` (memory) by default; `chrome.storage.local` with `keyStorage: "disk"` | With `"memory"`, the key never reaches disk and is gone when Chrome closes |
| Site storage (`localStorage`, `sessionStorage`, IndexedDB) | The site's own storage, keys prefixed per container | Not encrypted; a sign-out changes the prefix so old entries can't be reached |
| Synced copy (only if `syncEnabled`) | The Google account the Chrome profile is signed in to | Google account security; removed when sync is turned off |

The extension makes no network requests of its own and has no server.

## 1. Give the extension a fixed ID

Chrome policy targets an extension by its 32-letter ID. An extension added with **Load unpacked** gets an ID derived from its folder path, so it differs from computer to computer. For a managed rollout, use one of:

- a **private Chrome Web Store listing** (trusted testers or your Google Workspace domain): the store assigns the ID;
- a **self-hosted package** (`.crx` plus an update manifest) signed with your own key: the ID comes from the key.

Then install it with the `ExtensionInstallForcelist` policy (`<id>;<update URL>`). The ID is shown on `chrome://extensions` with Developer mode on. Below, `<id>` stands for it.

## 2. Settings

Every setting can be set by policy. A setting set by policy is locked: the options page shows it disabled with **Set by your organization**, and the extension refuses to change it.

| Setting | Type | Default | Recommended for managed deployments | What it does |
|---|---|---|---|---|
| `syncEnabled` | boolean | `false` | `false` | Sync container names, colours, emoji and assigned-site addresses through the profile's Google account. Turning it off removes the extension's data from the account. |
| `keyStorage` | `"memory"` or `"disk"` | `"memory"` | `"memory"` | Where each container's cookie key lives. `"memory"`: closing Chrome, or an extension update, signs every container out. `"disk"`: sign-ins survive restarts. |
| `idleTimeoutMinutes` | integer, 15 to 43200 | `240` | `240` or less | Sign a container out after this long without real use (bringing its tab to the front, or clicking, typing or scrolling in it). Background requests don't count. Checked every 15 minutes. |
| `signOutOnLock` | boolean | `true` | `true` | Sign every container out when the operating system reports the screen is locked. |
| `stripMicrosoftDeviceHeaders` | boolean | `true` | `true` | Remove `x-ms-RefreshTokenCredential` and `x-ms-DeviceCredential` from container tabs, so a container can't sign in with this device's own work account. |
| `stripDbscHeaders` | boolean | `true` | `true` | Remove `Sec-Session-Registration` and `Sec-Session-Challenge` in container tabs, so Chrome doesn't bind a container's session to the profile's own cookies. |
| `allowBackupExport` | boolean | `true` | `false` | Allow exporting container names and assigned sites to a file. A backup holds no sign-ins, but its names and addresses can identify the organizations you work for. |
| `allowBackupImport` | boolean | `true` | `true` | Allow importing a backup. Files are checked entry by entry and refused whole if anything is invalid. |

### The two device-header settings

Both are on by default, and turning either off has a cost:

- **Microsoft device sign-in.** On: container tabs can't present this device's Windows sign-in, so a container never signs in as the device's own work account by accident. As a result, Conditional Access policies that require a compliant or hybrid-joined device **block container tabs**; use a normal tab for your own organization's tenant. Off: where Chrome's Windows single sign-on is enabled, container tabs on `login.microsoftonline.com` can sign in silently with the device's account, which can put your own identity in a client's container.
- **Device Bound Session Credentials (DBSC).** On: container tabs don't get DBSC's protection against stolen session cookies. Off: Chrome would most likely manage the bound session in the profile's real cookie store, outside the container. That has not been tested yet; treat it as breaking the separation.

Neither setting bypasses a site's security control. Each withholds a credential the browser would otherwise add.

## 3. Setting the policy

The extension reads policy from `chrome.storage.managed`; the schema is [`static/managed_schema.json`](../static/managed_schema.json).

**Google Admin console** (Chrome Enterprise Core): **Devices → Chrome → Apps & extensions → Users & browsers**, select the extension, then paste into **Policy for extensions**:

```json
{
  "syncEnabled": { "Value": false },
  "keyStorage": { "Value": "memory" },
  "idleTimeoutMinutes": { "Value": 240 },
  "signOutOnLock": { "Value": true },
  "stripMicrosoftDeviceHeaders": { "Value": true },
  "stripDbscHeaders": { "Value": true },
  "allowBackupExport": { "Value": false },
  "allowBackupImport": { "Value": true }
}
```

**Windows registry** (Group Policy Preferences, or an Intune PowerShell script or remediation). Chrome reads extension policy from `HKLM\Software\Policies\Google\Chrome\3rdparty\extensions\<id>\policy`, one value per setting: `REG_DWORD` for booleans (0 or 1) and integers, `REG_SZ` for strings.

```reg
Windows Registry Editor Version 5.00

[HKEY_LOCAL_MACHINE\Software\Policies\Google\Chrome\3rdparty\extensions\<id>\policy]
"syncEnabled"=dword:00000000
"keyStorage"="memory"
"idleTimeoutMinutes"=dword:000000f0
"signOutOnLock"=dword:00000001
"stripMicrosoftDeviceHeaders"=dword:00000001
"stripDbscHeaders"=dword:00000001
"allowBackupExport"=dword:00000000
"allowBackupImport"=dword:00000001
```

(`000000f0` is 240.) Chrome picks up policy changes without a restart, within a few minutes; **Reload policies** on `chrome://policy` applies them at once, and the extension follows.

**Check it:** open `chrome://policy` and find the extension's ID under **Extension policies**. On the extension's **Settings** page, each managed setting is disabled with **Set by your organization**.

## 4. Related Chrome policies

- **Turn off Chrome sign-in** (`BrowserSignin` = `0`). Chrome's own Google sign-in can sign the browser in from inside a website. The extension removes the headers involved in container tabs, but turning browser sign-in off removes the risk entirely. This also turns off Chrome sync of bookmarks and passwords for those users, so decide it for the organization as a whole.
- **Install it, and keep it installed:** `ExtensionInstallForcelist`, as in step 1.
- **Developer mode:** most managed fleets block it (`DeveloperToolsAvailability`, `ExtensionDeveloperModeSettings`). That's another reason to use a store listing or a self-hosted package, not **Load unpacked**.

## 5. Offboarding, and lost or handed-over computers

1. On the computer, open the extension's **Settings** and choose **Sign out of all containers**. Every container gets a new key, an empty cookie jar and a new storage prefix, and its tabs reload signed out. With `keyStorage: "memory"`, quitting Chrome has the same effect.
2. Remove the extension (or remove it from the force-install list). Chrome deletes the extension's own storage: containers, assigned sites, encrypted cookies and keys.
3. Prefixed site storage left in websites' own storage isn't the extension's to delete. Clear it with **Delete browsing data → Cookies and other site data** for all time, or remove the Chrome profile.
4. If sync was ever turned on, turning it off (or setting `syncEnabled: false` by policy) removes the extension's data from the Google account.
5. Revoke the person's accounts at each client's identity provider as usual. Signing a container out ends the session in the browser, but not any refresh tokens the identity provider has already issued.

## 6. Known limits to record in your risk assessment

- Not a security boundary against a malicious or compromised site (see the README's Security model).
- Site storage is separated by prefix inside the page, not encrypted.
- IndexedDB used from a Web Worker, the HTTP cache, Cache API, BroadcastChannel and SharedWorkers are shared between containers and normal tabs.
- Assignments are by exact host. Tools that serve every customer from one address (Autotask, Intune) can't tell clients apart by address; techs open the client's container first.
- With `keyStorage: "disk"`, the cookie encryption keys sit next to the data, so someone who can read the profile folder can read container cookies.
