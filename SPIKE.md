# Phase 1 spike: cookie virtualization on Chrome MV3

Goal: find out whether a Chrome extension can give tabs Firefox-container-style
isolation (separate cookies and site storage per container, in the same window)
before porting any of Multi-Account Containers' UI.

**Verdict: it's viable for everyday logins, with known gaps (listed below).** All 33
automated isolation checks (35 now) and 7 restart checks pass, in repeated runs, in Chrome for Testing 156.
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

1. **Service workers.** A worker registered from a default tab still controls that site's pages in container tabs, and its fetches carry no tab id, so they get the *real* profile cookies. Container documents can't register workers, which breaks PWAs, offline mode and push in containers.
2. **Chrome's own Google sign-in.** Stripping the sign-in headers only helps if Chrome lets extensions modify them before its sign-in code reads them. That's untested, because Chrome for Testing has no Google sign-in. The tests do confirm the headers are removed before the page sees them. To be safe, turn off **Allow Chrome sign-in** in `chrome://settings/syncSetup`.
3. **Group membership is the record.** Dragging a container tab out of its group, or renaming or recolouring the group, has no effect until a restart. After a restart, the tab follows whatever group it's in. Containers and groups don't stay in sync while Chrome is running.
4. **Redirects inside `fetch`/XHR.** A cookie set by a `3xx` on a subresource request is missing from the redirected request. Only top-level navigations get replayed.
5. **XHR responses** don't get the post-response barrier, only `fetch` does. Synchronous XHR gets neither.
6. **Unisolated state:** HTTP cache, Cache API, BroadcastChannel, SharedWorker, Web Locks, and IndexedDB used from workers. These allow cross-container tracking and some state bleed.
7. **`credentials: "omit"`** and anonymous CORS requests still get container cookies, because DNR can't see the credentials mode.
8. A same-origin `about:blank` iframe that's created and touched synchronously can get ahead of the shim.
9. No Public Suffix List (it only rejects bare TLDs), no CHIPS/`Partitioned` support, and `__Host-`/`__Secure-` checks are basic.
10. Deleting a container leaves its prefixed localStorage/IndexedDB data in each site's storage.
11. A site that knows a container's id could spoof the `Server-Timing` marker. The id is random and hidden from pages.

## Running it

```bash
npm install
npm run build
npm test          # unit: cookie semantics + DNR rule selection (simulated)
npm run e2e       # e2e: needs Chrome for Testing; see below
npm run e2e:restart  # close and relaunch with session restore on one profile
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

Results go to `test-results/sandbox.json`. Chrome keeps an unpacked extension's
worker cached across restarts, so each build writes `dist/build.json` and the
launcher reloads the extension whenever the sandbox is running a different
build. Run `npm run build` before testing a change. When a run fails, the
worker's recent tab events (`mac.events()` in its console) show what happened. If a site asks
you to sign in again or for a verification code, open the sandbox with
`npm run sandbox` and deal with it by hand.

## Planning for work use (Autotask, Intune, client tenants)

Not tested, because it needs those accounts, but it shapes the next phases:

- **Windows / Entra ID single sign-on.** Container tabs remove the headers Chrome uses to sign in to Microsoft with the device's own work account (`x-ms-RefreshTokenCredential`, `x-ms-DeviceCredential`). Containers will never sign in as your own tenant by accident. The flip side: your own tenant's "compliant device" Conditional Access can't pass inside a container, so use a normal tab for your own tenant. Client tenants can't see your device as compliant anyway.
- **Cookie jars on disk aren't encrypted.** Chrome encrypts its own cookies with Windows DPAPI. This extension keeps container cookies in `chrome.storage.local` in plain text. For client sessions, that should be fixed before real use: encrypt the jars, possibly with a passphrase per browser session. That's a Phase 2 decision.
- **Rule budget.** Microsoft sign-ins touch many domains (`login.microsoftonline.com`, `*.microsoft.com`, `intune.microsoft.com`, `portal.azure.com`, `*.office.com`, SharePoint). Many client containers multiply that, and Chrome caps the extension at 1,000 pattern rules. Compacting the rules is needed before heavy use.
- **MSAL sign-in** (Intune and most Microsoft portals) uses popups, hidden cross-site iframes to renew tokens silently, and `sessionStorage`/`localStorage` token caches. The tests already cover all three patterns.
- **Service workers** (Outlook and Teams on the web) make the service-worker gap matter more for Microsoft 365 work.
- **"Always open this site in container X"**, from Multi-Account Containers, is what makes client work practical. It belongs in the Phase 2 interface port.
