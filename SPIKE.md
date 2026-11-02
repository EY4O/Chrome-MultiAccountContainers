# Phase 1 spike: cookie virtualization on Chrome MV3

Goal: find out whether a Chrome extension can give tabs Firefox-container-style
isolation (separate cookies and site storage per container, in the same window)
before porting any of Multi-Account Containers' UI.

**Verdict: it's viable for everyday logins, with known gaps (listed below).** All 33
automated isolation checks (50 now), 7 restart checks and 27 real-site sandbox checks pass, in repeated runs, in Chrome for Testing 156.
Logging in to real sites is the next gate, and that's your manual test (see
the end of this file).

## How it works

| Layer | Mechanism | Where |
|---|---|---|
| Outgoing cookies | `declarativeNetRequest` session rules scoped by `tabIds` set the `Cookie` header from the container's jar. There's one rule per scope, path, scheme and SameSite context, and priority picks the most specific. | `src/background/rules.ts` |
| Incoming cookies | A DNR rule strips `Set-Cookie` in container tabs. A non-blocking `webRequest.onHeadersReceived` (`extraHeaders`) still sees the original header and writes it to the jar. | `src/background/index.ts` |
| Real profile | Container tabs never send the profile's cookies (fallback "remove Cookie" rule) and never write to them. The same rule removes the headers Google uses to sign *the browser itself* in (Chrome account consistency, device-bound session registration), which would otherwise let Chrome rebuild a container's Google login in the real cookie jar. | `rules.ts` |
| `document.cookie` | MAIN-world shim at `document_start`. The page's container and a cookie snapshot arrive **synchronously** in a `Server-Timing` header that the DNR rules append to each container document, which can be read from the first inline script. The shim then hides these entries from the page. | `src/content/main.ts` |
| Storage | `localStorage`, `sessionStorage` and IndexedDB keys get a `__mac_<id>__` prefix. Default tabs can't see container keys. | `main.ts` |
| Write barrier | `fetch`/XHR wait for pending `document.cookie` writes to reach the rules. A `fetch` response isn't handed to the page until any `Set-Cookie` on it has reached the rules. | `main.ts`, `isolated.ts` |
| Stale-navigation replay | A top-level GET that left before the rules caught up (login → `302` + `Set-Cookie` → `/home`) is detected in `onSendHeaders` and replayed. The stale response's cookies are discarded, so an anonymous session can't overwrite the login. | `index.ts` |
| New tabs | A tab only inherits its opener's container on `webNavigation.onCreatedNavigationTarget`. A tab Chrome creates inside a container's group joins that container. Until it's classified, the tab's requests are blocked, and the blocked load is replayed once it's classified. | `index.ts` |
| Lockdown | A persistent dynamic rule blocks every request. A session rule lifts it for the tabs the worker has classified. Session rules disappear on browser restart and extension reload, so restored tabs can't send anything until the worker has re-assigned them. If the rules can't be written twice in a row, the lockdown is removed (fails open) so browsing keeps working. | `rules.ts`, `index.ts` |
| Restart | Container tabs live in a tab group titled with the container's name (names must be unique). On startup, tabs in a group whose title and colour match a container go back into it. Their blocked loads are found with `webNavigation.getAllFrames` and replayed. Session cookies are kept if the session restored any tabs, as Chrome does with "Continue where you left off". | `index.ts` |

## Measured

- Rule sync (`updateSessionRules`, full replace): 4–28 ms with about 15 rules.
- `fetch` overhead from the barrier: none measurable (4.8 ms container vs 4.9 ms default, local server).
- Cookie set by `fetch` → visible on the next `fetch`: 10/10. Without the barrier it was 1/10.
- Rule budget: the test jars used 13 regex rules. Chrome allows **1,000 regex rules** in total across dynamic and session rules. Each (cookie domain × path × SameSite tier) costs one, so heavy users with many containers and sites will run out. That needs work before shipping (see next phases).

## Known gaps

Not handled yet, roughly from most to least important:

1. **Service workers, residual.** Normal tabs can't register service workers for a site while a container uses it, meaning the container holds cookies for it or opened it as a page. Existing workers for that site are removed the first time a container opens it, and again at each browser start. Deleting or resetting a container forgets the pages it opened. Frames that leave no cookies, such as most ads, never count. What remains: the very first container visit to a site can still be answered by a worker registered earlier in a normal tab, if the visit didn't come from the popup. A site whose container login lives only in page storage (no cookies) is protected only while that container's opened-pages record lists it. Container pages never get service workers.
2. **Chrome's own Google sign-in.** Stripping the sign-in headers only helps if Chrome lets extensions modify them before its sign-in code reads them. That's untested, because Chrome for Testing has no Google sign-in. The tests do confirm the headers are removed before the page sees them. To be safe, turn off **Allow Chrome sign-in** in `chrome://settings/syncSetup`.
3. **Dragging a tab to a new window** takes it out of its group, so it becomes a normal tab and reloads, consistent with "the group is the container". Dragging a whole group keeps it.
4. **Redirects inside `fetch`/XHR.** A cookie set by a `3xx` on a subresource request is missing from the redirected request. Only top-level navigations get replayed.
5. **XHR responses** don't get the post-response barrier, only `fetch` does. Synchronous XHR gets neither.
6. **Unisolated state:** HTTP cache, Cache API, BroadcastChannel, SharedWorker, Web Locks, and IndexedDB used from workers. These allow cross-container tracking and some state bleed.
7. **`credentials: "omit"`** and anonymous CORS requests still get container cookies, because DNR can't see the credentials mode.
8. A same-origin `about:blank` iframe that's created and touched synchronously can get ahead of the shim.
9. No Public Suffix List (it only rejects bare TLDs), no CHIPS/`Partitioned` support, and `__Host-`/`__Secure-` checks are basic.
10. Deleting a container leaves its prefixed localStorage/IndexedDB data in each site's storage.
11. A site that knows a container's id could spoof the `Server-Timing` marker. The id is random and hidden from pages.

## Phase 2 (engine)

| Item | What it does | Checked by |
|---|---|---|
| Rule compaction | Root-path cookie rules use plain URL patterns (`|https://host^`, `requestDomains`) instead of regex. Identical SameSite tiers are merged. WebSockets (`wss://`, `ws://`) now get their cookies, which the regex version missed. | Unit tests compare against Chrome's cookie rules across schemes, ports and look-alike domains. Sandbox: 253 rules, 30 regex (was 154 and 150). |
| Budget limit | A new container tab is refused when its rules wouldn't fit. If open containers outgrow the limit, the least recently used ones lose their cookie rules (signed out, not leaked) and the icon shows a "!". | e2e |
| Encryption | Jars are sealed with AES-256-GCM, one key per container. Old plain-text jars are converted on load. | Unit tests: round trip, wrong key, tampering. e2e checks there's no plain text at rest. Sandbox: existing containers converted and still signed in. |
| 30-day reset | Hourly check (`chrome.alarms`). An unused container gets a new key, an empty jar and a new storage prefix, and its open tabs reload. Containers created before this release start their clock at first load. | e2e (simulated by backdating) |
| Live group sync | Dragging a tab into or out of a container's group switches it and reloads it. Renaming or recolouring a container's group updates the container. An empty or duplicate name is put back. | e2e |
| Service workers | For sites a container uses (holds cookies for, or opened as a page), workers are removed from the profile and normal pages, including ones already open, refuse new registrations. The list forgets a container's pages when it's deleted or reset. | Unit tests, e2e, sandbox |

## Phase 3 (interface)

The extension's pages look like native Chrome UI (Chrome's current Material styling, light and dark), modelled on the tab group editor, the profile and extensions menus, and `chrome://settings`. The only brand marks are the icon and a coral dot on the current tab's container. Design context lives in `PRODUCT.md` and `.impeccable/`.

| Feature | What it does | Checked by |
|---|---|---|
| Popup | The header shows this tab's container (change it to move the tab) and "Always open *site* in". Below: search (Enter opens the first match), then containers with emoji, tab and site counts, and shortcut hints. Hide (collapses the tab group) and edit appear on hover or focus. Drag, or Alt+Up/Down, to reorder. Footer rows: New container, Settings. | e2e (`npm run e2e:phase3`), driving the real popup |
| Edit panel | Name, any emoji (with quick picks), the 9 tab-group colours, the sites that always open here, sign out of everything, and delete with an inline confirm. | e2e |
| Emoji in tab groups | A group's title is "emoji name". Renaming a group with an emoji in front updates both the name and the emoji. | e2e |
| Site assignments | Exact host. Opening an assigned site in any other tab is redirected, before any request leaves, to a prompt with "Open in *X*" / "Stay here" and "Remember my choice". Remember + open switches automatically from then on. Remember + stay never asks again. Stay alone exempts that tab only. | Unit test on the redirect rule, e2e |
| Right-click menus | Open link in container, reopen this tab in container (or no container), always open this site in a container. | e2e (through the click handler) |
| Shortcuts | Ctrl+Period opens the popup; Ctrl+Shift+1/2/3 open your first three containers; containers 4 to 10 can be given keys in `chrome://extensions/shortcuts`. | e2e |
| Sync | One `chrome.storage.sync` item per container (name, colour, emoji, order, sites), plus deletion records. The newer change wins per container. Cookies, keys and site storage never sync. Can be turned off on the options page. | e2e (simulated remote add, rename and delete) |
| Backup | Export and import a JSON file of containers and sites. Import merges by id, and renames on a name clash. | e2e |
| Options page | Sync switch and status, backup, current shortcuts, and privacy notes (encrypted at rest, 30-day sign-out). | e2e, screenshots |

Not built: "limit a container to its assigned sites". Assignments can't tell clients apart on shared-host tools (Autotask, Intune); for those, open the client's container first.

## Hardening (managed deployments)

For use with other organizations' admin sessions, reviewed against a security policy. Administrator guide: `docs/CONFIGURATION.md`.

| Item | What it does | Checked by |
|---|---|---|
| Settings and policy | Managed value (`chrome.storage.managed`, `static/managed_schema.json`) over the user's choice over the default; managed settings are locked on the options page and refused by the worker. | Unit tests (precedence), e2e (lock shown, change refused) |
| Keys in memory | `keyStorage: "memory"` (default) keeps jar keys in `chrome.storage.session`; a container whose key is gone gets a new key, an empty jar and a new storage prefix. Switching modes moves the keys. | e2e restart: disk stays signed in, memory signs out |
| Idle sign-out | `idleTimeoutMinutes` (default 240), checked every 15 minutes. Only real use counts: tab activation, or a trusted click, key, wheel or touch in a container page (reported at most once a minute). | Unit test, e2e |
| Lock sign-out | `signOutOnLock` (default on), via `chrome.idle`'s locked state. | e2e (through the same path) |
| Device headers | Google account consistency always removed; Microsoft device sign-in and DBSC behind `stripMicrosoftDeviceHeaders` and `stripDbscHeaders` (both on). | Unit tests |
| Sync off by default | Turning it off, by hand or by policy, removes the extension's items from `chrome.storage.sync`. | e2e |
| Prompt page | `use_dynamic_url`: sites can't frame or open it. The worker only takes prompt messages from its top frame in its own tab; the page renders nothing when framed. | e2e |
| Backup checks | The whole file is validated before import; one bad entry refuses it. Export and import can be turned off. | Unit tests, e2e |
| Sign out of all | Options page, with a confirm. | e2e |

Confirmed by test: a dedicated worker's requests carry its container's cookies, but IndexedDB used from inside a worker is shared with normal tabs.

## Running it

```bash
npm install
npm run build
npm test          # unit: cookie semantics + DNR rule selection (simulated)
npm run e2e       # e2e: needs Chrome for Testing; see below
npm run e2e:restart  # close and relaunch with session restore on one profile
npm run e2e:phase3   # popup, prompt, menus, shortcuts, sync, backup, options
```

Branded Chrome no longer accepts `--load-extension`, so the e2e suite uses
Puppeteer's Chrome for Testing. If its version doesn't match the cached one,
point `CHROME_PATH` at a cached build, for example
`~/.cache/puppeteer/chrome/win64-156.0.8078.47/chrome-win64/chrome.exe`.
Set `HEADFUL=1` to watch it run.

`npm run harness` starts the test sites on `http://a.localhost:8787/page` (any
`*.localhost` host works) for poking at things by hand.

## Your manual test: real sites in your Chrome

2. Run `npm run build`, open `chrome://extensions`, turn on Developer mode, then **Load unpacked** → `dist/`.
3. Open the extension popup and create two containers, for example "Personal" and "Work".
4. For each site below, open it from the popup in both containers and sign in to a *different* account in each. Keep a default (no container) tab signed in to a third account, or signed out.
5. For each site, note: does login work, do both containers stay signed in after a reload, does the default tab stay unaffected, and does anything look broken.

| Site | Why it's a good test |
|---|---|
| GitHub | Classic login with redirect and form POST, and a `__Host-` cookie |
| Google (Gmail) | Many cookie domains, a sign-in redirect chain, and service workers |
| Slack or Discord (web) | Heavy IndexedDB and WebSocket use |
| AWS console | Cross-subdomain cookies and SameSite=None |
| Any "Sign in with Google" site | OAuth popup with `window.opener` |

If something breaks, the worker's counters help: open `chrome://extensions` →
"service worker" → console, then run `mac.stats` and `await mac.rules()`.

## Sandbox testing with real accounts

The automated suites only see local test sites. For real sites, the `sandbox/`
scripts drive **your installed Chrome** on a throwaway profile folder
(`.sandbox-profile/`, ignored by git). That folder shares nothing with your
real profile, and deleting it wipes everything. You create the test accounts
and sign in yourself. The scripts never type credentials.

One-time setup:

1. Run `npm run build`, then `npm run sandbox`. This opens the sandbox Chrome with nothing attached, so signing in works normally.
2. Follow the steps it prints: load `dist/` with Load unpacked, create one container per test account, and sign each account in to its own container. Leave normal tabs signed out.
3. Copy `sandbox/scenarios.example.json` to `sandbox/scenarios.json` (ignored by git). For each site, set the container names and a piece of text each account shows on screen, such as the Gmail address or the Discord or GitHub username.
4. Close the sandbox Chrome.

Then, any time (Chrome must be closed):

```bash
npm run sandbox:test
```

This relaunches the sandbox with a debugging port that only this machine can
reach, and checks four things:
- each container shows only its own account,
- normal tabs show none of them,
- `chrome://signin-internals` lists none of them,
- after a close-and-restore, restored tabs keep their accounts and a fresh normal tab still shows none.

`npm run sandbox:phase2` checks the Phase 2 features on the first site in
`scenarios.json`: jars encrypted at rest; dragging a tab between groups; rename,
rejected duplicate and recolour (all put back afterwards); service workers in
normal tabs; the rule-limit refusal; and the 30-day reset. The last two only
touch temporary containers, which are deleted afterwards.

Results go to `test-results/sandbox.json` (and `sandbox-phase2.json`). Chrome keeps an unpacked extension's
worker cached across restarts, so each build writes `dist/build.json` and the
launcher reloads the extension whenever the sandbox is running a different
build. Run `npm run build` before testing a change. When a run fails, the
worker's recent tab events (`mac.events()` in its console) show what happened. If a site asks
you to sign in again or for a verification code, open the sandbox with
`npm run sandbox` and deal with it by hand.

## Planning for work use (Autotask, Intune, client tenants)

Not tested, because it needs those accounts, but it shapes the next phases:

- **Windows / Entra ID single sign-on.** Container tabs remove the headers Chrome uses to sign in to Microsoft with the device's own work account (`x-ms-RefreshTokenCredential`, `x-ms-DeviceCredential`). Containers will never sign in as your own tenant by accident. The flip side: your own tenant's "compliant device" Conditional Access can't pass inside a container, so use a normal tab for your own tenant. Client tenants can't see your device as compliant anyway.
- **Cookie jars are encrypted at rest** (AES-256-GCM, one key per container, stored next to the data). That keeps cookies out of plain sight in the profile, but doesn't stop someone who can read the whole profile while a key exists. A container unused for **30 days** gets a fresh key, an empty jar and a new storage prefix, which is a full sign-out. Chrome's own cookies are protected by Windows DPAPI. This doesn't match that.
- **Rule budget.** Measured on your sandbox: a Google-heavy container costs about 125 of Chrome's 5,000 session rules, so roughly 39 such containers fit (about 13 did before Phase 2). Regex rules (1,000 allowed) are no longer the limit, at about 15 per container. Lighter sites cost far less: Discord alone is about 20 rules. When the budget is full, opening a tab in another container is refused with a message.
- **MSAL sign-in** (Intune and most Microsoft portals) uses popups, hidden cross-site iframes to renew tokens silently, and `sessionStorage`/`localStorage` token caches. The tests already cover all three patterns.
- **Service workers** (Outlook and Teams on the web): they're blocked in containers. Normal tabs lose them for any site you also use in a container.
- **"Always open this site in container X"**, from Multi-Account Containers, is what makes client work practical. It belongs in the Phase 2 interface port.
