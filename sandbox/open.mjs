// Opens the sandbox Chrome for setup by hand: no debugging port, nothing
// attached, so signing in works exactly as it does in normal Chrome.

import { DIST, PROFILE, assertNotRunning, spawnChrome } from "./chrome.mjs";

await assertNotRunning();
spawnChrome(["chrome://extensions"]);
console.log(`Sandbox Chrome opened on ${PROFILE}

One-time setup:
  1. Turn on Developer mode, click "Load unpacked" and choose:
       ${DIST}
  2. In the extension's popup, create one container per test account.
  3. Open each site from the popup in its container and sign in to that
     container's test account. Leave normal (no container) tabs signed out.
  4. Copy sandbox/scenarios.example.json to sandbox/scenarios.json and fill in
     your container names and something each account shows on screen.
  5. Close the sandbox Chrome, then run: npm run sandbox:test`);
