---
version: 1
slug: "static-popup-html"
primary_target: "static/popup.html"
related_targets: ["static/prompt.html","static/options.html"]
---

# Surface brief: toolbar popup, wrong-container prompt, options page

Scope: `static/popup.html` (toolbar popup, ~340px), `static/prompt.html` (full page shown when an assigned site opens outside its container), `static/options.html` (sync, backup, shortcuts). Mode: Operate.

Audience and job: an MSP technician (and team) with under ten containers, opening a client's container many times a day; occasionally moving a tab, assigning a site, or editing a container. Must not feel playful, corporate-generic, un-Chrome-like, or dense.

Chosen direction: the category standard, played straight, at the level of Chrome's own UI (user's explicit choice after two rolled hands). References: Chrome's tab group editor bubble, profile menu, extensions menu, and chrome://settings.

## Direction contract

THESIS: The popup is a Chrome menu, not an extension's mini-app: it should be indistinguishable in craft from the profile and extensions menus, so containers feel like a Chrome feature. Refuses the bespoke-card dashboard most container extensions ship.

OWN-WORLD: Chrome's current Material surfaces: white (dark: #1f1f1f-family) bubble, neutral greys, primary blue #0b57d0 (dark #a8c7fa) for focus and primary buttons only, 8% state overlays, 1px outline-variant dividers, pill search field, Chrome's nine tab-group colours as avatar tints. System UI font at Chrome's sizes. The only brand marks: the extension icon and a coral dot (#f26d6d) on the current tab's container.

STORY: Open the popup, see which container this tab is in, find a client by typing or arrow keys, press Enter to open a tab in it. Edit, hide, assign and settings are one level away and never in the way.

FIRST VIEWPORT: Top: identity header like the profile menu (container avatar, name, this tab's host, coral dot; or "Not in a container"), with an "Always open <host> in" row. Then a pill search field. Then the container list like the extensions menu: tinted emoji avatar, name, "N tabs · N sites", shortcut hint, trailing hide and edit buttons. Footer menu rows: New container, Settings. Edit opens a tab-group-editor-style panel in place.

FORM: Canon (the standing exit), taken by the user in words after re-roll 1; not on the ordered list. Seed key a6ee4798.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
