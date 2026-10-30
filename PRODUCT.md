# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Chrome extension, Manifest V3. Plain HTML, CSS and TypeScript, bundled with esbuild; no UI framework. Surfaces are extension pages: the toolbar popup, full-page extension pages (the "wrong container" prompt, options), and content shown inside Chrome's own UI (tab groups, context menus, the toolbar badge).

## Users

An MSP technician and their team. Their day is spent switching between many client tenants (Autotask, Microsoft Intune and other Microsoft 365 portals, client-specific sites and credentials) alongside their own work and personal accounts (Gmail, Discord). They need several signed-in identities on the same sites at once, in one Chrome window, without one identity bleeding into another.

## Product Purpose

Gives Chrome what Firefox Multi-Account Containers gives Firefox: each container is a separate identity (its own cookies and site storage) that tabs can be opened in, side by side in the same window. Success is being signed in to Client A and Client B on the same site in two tabs, with normal tabs untouched, and having that survive a restart.

## Positioning

Per-tab identities inside one Chrome profile, which Chrome itself only offers per profile or per window. Containers are shown as Chrome's own coloured tab groups, so the identity of a tab is visible in the tab strip. The engine rewrites cookies and storage per container, encrypts saved logins at rest, and signs a container out after 30 days unused.

## Operating Context

- Used all day, in short bursts: open a client's container, check something, switch to the next client.
- Several Microsoft and Autotask tools serve every client from the same address (`ww*.autotask.net`, `intune.microsoft.com`), so a site alone can't say which client it's for; the person chooses the container.
- Teams share the extension; container definitions and site assignments sync through each person's Chrome account and can be exported to a file.
- Chrome-native affordances are part of the product: tab groups (name, one of 9 colours, collapse), context menus, keyboard shortcuts, the toolbar popup.

## Capabilities and Constraints

- Containers have a name (unique), one of Chrome's 9 tab-group colours, and an optional emoji that is also shown in the tab group's title.
- "Hide" a container = collapse its tab groups (Chrome can't hide tabs).
- Site assignments are by exact host. Opening an assigned site outside its container shows a prompt (open in its container / stay here, with "remember my choice").
- Right-click: open link in container, reopen tab in container, always open this site in a container. Shortcuts: Ctrl+Period opens the popup; Ctrl+Shift+1/2/3 open the first three containers; more are user-assignable.
- Sync covers container definitions and site assignments only; cookies and logins never leave the machine.
- Chrome caps the extension's rules; when the cap is reached, opening another container is refused with an explanation.
- Undecided: the product name. "Containers" is a working name.

## Brand Commitments

- The extension's own pages look like native Chrome UI (Chrome's current Material styling, light and dark): the tab group editor, the profile menu, the extensions menu and chrome://settings are the bar. The only brand elements inside them are the extension icon and a small coral dot (#f26d6d) marking the container the current tab is in.
- The icon family shared with the user's other tools (Prompto, Model Librarian, Model Librarian Gallery): a white rounded tile with a lavender hairline (#dcdbe3), a holographic diagonal gradient (#f7dccf, #f4a7c0, #b9a3e3, #8fcfe3), a glossy coral orb (#f26d6d), near-black ink (#101117). The extension icon is three stacked browser windows (`tools/make_icon.py`, `docs/images/icon.png`).

## Evidence on Hand

- Working engine with automated and real-account tests (`SPIKE.md`). No screenshots of a finished interface, no users' quotes, no store listing yet; don't invent any.

## Product Principles

1. The container is always obvious: a person should never wonder which identity a tab is using.
2. Never leak: when in doubt, sign out rather than send one identity's cookies to another.
3. Chrome-native first: lean on tab groups, menus and shortcuts people already know rather than inventing parallel controls.
4. Fast for repeat use: the common actions (open a client's container, switch a tab, assign a site) take one or two clicks.
