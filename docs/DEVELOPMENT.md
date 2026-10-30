# Development

TypeScript sources in `src/` and static pages in `static/` are bundled by esbuild into `dist/`, which is the unpacked extension.

```
src/background/  service worker: cookie rules, tab tracking, containers, menus, sync
src/content/     page scripts: document.cookie and storage shims (MAIN world), bridge (ISOLATED)
src/popup/       toolbar popup
src/prompt/      "Open in …?" page for assigned sites
src/options/     settings page
src/shared/      cookie parsing, encryption, message types
src/ui/          shared DOM helpers and icons
static/          manifest, HTML, CSS, icons
test/            unit tests and Puppeteer end-to-end suites
harness/         multi-site local test server (*.localhost)
sandbox/         scripts that drive your installed Chrome on a throwaway profile
tools/           icon generator
docs/            this file, README images
```

Design and engineering notes live in `SPIKE.md` (how the isolation works, phase by phase, and the known gaps), `PRODUCT.md` and `DESIGN.md` (interface).

## Run it locally

Needs Node.js 22.18 or newer (the unit tests run TypeScript directly).

```
npm install
npm run build        # or: npm run watch
```

Load `dist/` with **Load unpacked** in `chrome://extensions`. After a rebuild, press the extension's reload arrow. `npm run typecheck` runs `tsc`.

## Tests

The end-to-end suites use Puppeteer's Chrome for Testing. Install it once with `npx puppeteer browsers install chrome`; set `CHROME_PATH` if it's somewhere else. Run `npm run build` first. `HEADFUL=1` shows the browser.

```
npm test
npm run e2e
npm run e2e:restart
npm run e2e:phase3
```

| Suite | Covers |
|---|---|
| `npm test` | Cookie parsing and matching, the rule builder (against Chrome's cookie rules), encryption |
| `e2e` | Isolation of cookies and storage across tabs, frames, redirects, popups and new tabs; Set-Cookie capture; rule budget; 30-day reset; service workers; identity headers |
| `e2e:restart` | Containers and sign-ins come back after a browser restart |
| `e2e:phase3` | The real popup, edit panel, emoji and tab-group titles, site assignments and the prompt, menus, shortcuts, sync, backup |
| `release:check` | The upload package: no source maps or test hooks, and isolation still works |

### Real-Chrome sandbox

Real sites (Google, Discord) need real Chrome, with its own Google sign-in. `npm run sandbox` opens your installed Chrome on a throwaway profile in `.sandbox-profile/` that shares nothing with your own; load `dist/` there and sign in to test accounts by hand. Copy `sandbox/scenarios.example.json` to `sandbox/scenarios.json` (ignored by git) and fill in which account belongs in which container, then close the sandbox and run `npm run sandbox:test` or `npm run sandbox:phase2`.

## Releasing

1. Bump `version` in `static/manifest.json` and `package.json`, and add the version's line to the README changelog.
2. `npm run release` builds `release/unpacked/` without source maps, test hooks or diagnostics, and zips it to `release/containers-<version>.zip` with `manifest.json` at the root.
3. `npm run release:check` loads that package in Chrome for Testing and checks it.
4. Commit, push to `main`, then publish the zip:
   ```
   gh release create v<version> release/containers-<version>.zip --title "<version>" --notes-file <notes>
   ```
5. For the Chrome Web Store, upload the same zip in the developer dashboard. The store rejects a version number it already has.
