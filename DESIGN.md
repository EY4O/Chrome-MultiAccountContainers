---
name: Containers
description: Per-tab identity containers for Chrome, dressed as a native Chrome feature.
colors:
  surface: "#ffffff"
  surface-low: "#f8fafd"
  surface-container: "#f0f4f9"
  surface-high: "#e9eef6"
  on-surface: "#1f1f1f"
  on-surface-variant: "#474747"
  outline: "#747775"
  outline-variant: "#e3e3e3"
  primary: "#0b57d0"
  on-primary: "#ffffff"
  primary-container: "#d3e3fd"
  on-primary-container: "#041e49"
  error: "#b3261e"
  error-container: "#f9dedc"
  on-error-container: "#410e0b"
  hover: "rgb(31 31 31 / 0.08)"
  pressed: "rgb(31 31 31 / 0.12)"
  this-tab: "#f26d6d"
  surface-dark: "#28292c"
  surface-low-dark: "#1f1f1f"
  surface-container-dark: "#303134"
  surface-high-dark: "#3c3d41"
  on-surface-dark: "#e3e3e3"
  on-surface-variant-dark: "#c4c7c5"
  outline-dark: "#8e918f"
  outline-variant-dark: "#47484b"
  primary-dark: "#a8c7fa"
  on-primary-dark: "#062e6f"
  primary-container-dark: "#0842a0"
  on-primary-container-dark: "#d3e3fd"
  error-dark: "#f2b8b5"
  error-container-dark: "#8c1d18"
  on-error-container-dark: "#f9dedc"
  hover-dark: "rgb(227 227 227 / 0.08)"
  pressed-dark: "rgb(227 227 227 / 0.12)"
  group-grey: "#5f6368"
  group-blue: "#1a73e8"
  group-red: "#d93025"
  group-yellow: "#f9ab00"
  group-green: "#188038"
  group-pink: "#d01884"
  group-purple: "#a142f4"
  group-cyan: "#007b83"
  group-orange: "#fa903e"
  group-grey-dark: "#bdc1c6"
  group-blue-dark: "#8ab4f8"
  group-red-dark: "#f28b82"
  group-yellow-dark: "#fdd663"
  group-green-dark: "#81c995"
  group-pink-dark: "#ff8bcb"
  group-purple-dark: "#d7aefb"
  group-cyan-dark: "#78d9ec"
  group-orange-dark: "#fcad70"
typography:
  headline:
    fontFamily: "system-ui, \"Segoe UI Variable Text\", \"Segoe UI\", Roboto, sans-serif"
    fontSize: "20px"
    fontWeight: 400
    lineHeight: "28px"
  title:
    fontFamily: "system-ui, \"Segoe UI Variable Text\", \"Segoe UI\", Roboto, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: "22px"
  section:
    fontFamily: "system-ui, \"Segoe UI Variable Text\", \"Segoe UI\", Roboto, sans-serif"
    fontSize: "15px"
    fontWeight: 500
    lineHeight: "22px"
  body:
    fontFamily: "system-ui, \"Segoe UI Variable Text\", \"Segoe UI\", Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "20px"
  body-strong:
    fontFamily: "system-ui, \"Segoe UI Variable Text\", \"Segoe UI\", Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: "20px"
  secondary:
    fontFamily: "system-ui, \"Segoe UI Variable Text\", \"Segoe UI\", Roboto, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "16px"
  label:
    fontFamily: "system-ui, \"Segoe UI Variable Text\", \"Segoe UI\", Roboto, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: "16px"
  hint:
    fontFamily: "system-ui, \"Segoe UI Variable Text\", \"Segoe UI\", Roboto, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: "16px"
rounded:
  kbd: "4px"
  field: "8px"
  card: "12px"
  pill: "999px"
  circle: "50%"
spacing:
  xxs: "4px"
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "20px"
  xl: "24px"
  xxl: "28px"
components:
  button-outlined:
    backgroundColor: "transparent"
    textColor: "{colors.primary}"
    typography: "{typography.body-strong}"
    rounded: "{rounded.pill}"
    padding: "0 16px"
    height: "36px"
  button-filled:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.body-strong}"
    rounded: "{rounded.pill}"
    padding: "0 16px"
    height: "36px"
  button-tonal:
    backgroundColor: "{colors.primary-container}"
    textColor: "{colors.on-primary-container}"
    typography: "{typography.body-strong}"
    rounded: "{rounded.pill}"
    padding: "0 16px"
    height: "36px"
  button-text:
    backgroundColor: "transparent"
    textColor: "{colors.primary}"
    typography: "{typography.body-strong}"
    rounded: "{rounded.pill}"
    padding: "0 12px"
    height: "36px"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.error}"
    typography: "{typography.body-strong}"
    rounded: "{rounded.pill}"
    padding: "0 16px"
    height: "36px"
  button-danger-filled:
    backgroundColor: "{colors.error}"
    textColor: "{colors.surface}"
    rounded: "{rounded.pill}"
    padding: "0 16px"
    height: "36px"
  button-hover:
    backgroundColor: "{colors.hover}"
  button-pressed:
    backgroundColor: "{colors.pressed}"
  icon-button:
    backgroundColor: "transparent"
    textColor: "{colors.on-surface-variant}"
    rounded: "{rounded.circle}"
    size: "32px"
  input:
    backgroundColor: "transparent"
    textColor: "{colors.on-surface}"
    typography: "{typography.body}"
    rounded: "{rounded.field}"
    padding: "0 12px"
    height: "36px"
  search:
    backgroundColor: "{colors.surface-high}"
    textColor: "{colors.on-surface}"
    typography: "{typography.body}"
    rounded: "{rounded.pill}"
    padding: "0 12px"
    height: "36px"
  menu-row:
    backgroundColor: "transparent"
    textColor: "{colors.on-surface}"
    typography: "{typography.body}"
    padding: "0 16px"
    height: "40px"
  menu-row-hover:
    backgroundColor: "{colors.hover}"
  container-row:
    backgroundColor: "transparent"
    textColor: "{colors.on-surface}"
    typography: "{typography.body}"
    padding: "0 16px"
    height: "48px"
  avatar:
    rounded: "{rounded.circle}"
    size: "28px"
  avatar-large:
    rounded: "{rounded.circle}"
    size: "40px"
  this-tab-dot:
    backgroundColor: "{colors.this-tab}"
    rounded: "{rounded.circle}"
    size: "8px"
  settings-card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.card}"
  settings-card-row:
    typography: "{typography.body}"
    padding: "12px 20px"
    height: "56px"
  inset-panel:
    backgroundColor: "{colors.surface-container}"
    rounded: "{rounded.card}"
  error-notice:
    backgroundColor: "{colors.error-container}"
    textColor: "{colors.on-error-container}"
    typography: "{typography.secondary}"
    rounded: "{rounded.field}"
    padding: "8px 12px"
  switch:
    backgroundColor: "{colors.surface-high}"
    rounded: "{rounded.pill}"
    width: "36px"
    height: "20px"
  switch-on:
    backgroundColor: "{colors.primary}"
  kbd:
    backgroundColor: "{colors.surface-high}"
    textColor: "{colors.on-surface}"
    typography: "{typography.body-strong}"
    rounded: "{rounded.kbd}"
    padding: "0 6px"
---

# Design System: Containers

## Overview

**Creative North Star: "Indistinguishable From Chrome"**

Every surface the extension owns (the 340px toolbar popup, the full-page site prompt, the settings page) is built to read as a Chrome feature, not an extension's mini-app. The reference set is Chrome's own current Material UI: the profile menu, the extensions menu, the tab group editor and chrome://settings, in light and dark. Craft is measured by whether a person could tell the extension's popup apart from those menus; the goal is that they cannot.

The system is dense and quiet. Body text sits at Chrome's 13px, rows are menu-height, state is shown with 8% and 12% overlays of the text colour, and separation comes from 1px hairline dividers and tonal containers rather than decoration. Colour is functional: blue for focus and primary action, red for error, Chrome's nine tab-group colours for container identity. The rejected alternative is the bespoke card dashboard most container extensions ship.

There are exactly two brand marks inside these pages: the extension icon (in the settings top bar and on the prompt card) and the small coral dot that marks the container the current tab is in. Everything else is borrowed from the platform.

**Key Characteristics:**
- Chrome Material tokens, light and dark, switched by `prefers-color-scheme` only.
- System UI font at Chrome's sizes; a 13px/20px body and nothing larger than 20px.
- Full-width menu rows with full-row hover bands; pill buttons and a pill search.
- Container identity carried by emoji-or-initial avatars on tab-group colours.
- One coral dot (#f26d6d) as the only extension-owned accent.

## Colors

A neutral Chrome palette with one functional blue, one functional red, nine identity colours, and a single coral brand dot.

### Primary
- **Chrome Action Blue** (light `primary`, dark `primary-dark`): focus rings (2px, offset 2px), filled buttons, outlined and text button labels, checked switches, the focused field border, the drag-and-drop insertion line, caret and selection. Never used as a surface fill for decoration.
- **Blue Container** (`primary-container` / `on-primary-container`): tonal buttons, the pressed state of an emoji choice, text selection, the spinner track.

### Secondary
- **Chrome Error Red** (`error`, `error-container`, `on-error-container`): danger buttons and rows, invalid field borders, error text, and the inline error notice (container fill, on-container text).

### Tertiary
- **Tab-Group Colours** (`group-*`, nine hues, each with a `-dark` variant): Chrome's own tab group palette, used only for container identity: avatar tints, edit-panel swatches. In light mode an avatar is the colour mixed 22% into the surface with the colour as glyph ink; in dark mode the avatar is the colour itself with near-black ink, because a 22% tint goes muddy on dark surfaces.
- **This-Tab Coral** (`this-tab`): the coral dot marking the current tab's container, in the identity header (12px, ringed in the surface colour, on the avatar corner) and in the list (8px, after the name). Shared with the extension icon's orb.

### Neutral
- **Bubble White / Dark Bubble** (`surface`, `surface-dark`): the popup, cards, select menus.
- **Page Wash** (`surface-low`, `surface-low-dark`): the settings and prompt page background behind cards.
- **Inset Grey-Blue** (`surface-container`): the "Always open … in" row and the delete-confirm panel.
- **Raised Grey-Blue** (`surface-high`): the pill search field, the switch track, `kbd` chips, the empty avatar.
- **Ink** (`on-surface`) and **Muted Ink** (`on-surface-variant`): primary text; secondary text, icons, placeholders, shortcut hints, field labels.
- **Outline** (`outline`): button and field strokes, switch border, scrollbar thumb. **Hairline** (`outline-variant`): dividers and card-row separators.
- **State Overlays** (`hover` 8%, `pressed` 12% of the ink colour): every interactive hover and press, on any surface.

### Named Rules
**The Two Marks Rule.** The only brand elements inside the pages are the extension icon and the coral this-tab dot. No other colour, gradient or ornament from the icon family enters the UI.

**The Blue Means Act Rule.** Primary blue appears only where the user can act or is focused: buttons, focus rings, checked controls, insertion lines. It is never a heading colour or a decorative fill.

**The Identity Palette Rule.** Tab-group colours identify containers and nothing else. They are not status colours and never tint chrome.

## Typography

**Body Font:** system-ui (with "Segoe UI Variable Text", "Segoe UI", Roboto, sans-serif)

**Character:** One family, the operating system's own, exactly as Chrome draws its menus and settings. Hierarchy comes from size steps and weight (400, 500, 600), never from a second face, uppercase or tracking.

### Hierarchy
- **Headline** (400, 20px, 28px): the settings top-bar title and the prompt card's question. The largest type in the system.
- **Title** (600, 15px, 22px): the popup identity header's container name and the edit panel's heading.
- **Section** (500, 15px, 22px): settings section headings above each card.
- **Body** (400, 13px, 20px): rows, buttons (at 500), field values, prompt copy. Tabular numerals where counts or shortcuts align.
- **Secondary** (400, 12px, 16px): row meta ("3 tabs · 2 sites"), notices, the page note under the identity header.
- **Label** (500, 12px, 16px): field labels above inputs and edit-panel section titles, in sentence case.
- **Hint** (400, 11px, 16px): keyboard shortcut hints at the right edge of container rows.

### Named Rules
**The Chrome Sizes Rule.** Type stays on Chrome's ramp: 11, 12, 13, 15, 20px. Nothing larger, no display face, no uppercase labels.

## Layout

The popup is a fixed 340px column: identity header (16px sides), the inset "Always open" row, a hairline divider, the pill search, the container list (scrolls at 312px; gives up height to 248px when a notice shows so the footer stays inside Chrome's 600px popup cap), a divider, footer menu rows. Horizontal inset is a consistent 16px; rows span the full width so their hover band reaches both edges.

The settings page is a centered 680px column of sectioned cards on the page wash, under a 56px top bar with the icon and headline; 28px between sections, 10px between a heading and its card. The prompt page centers a single card up to 520px wide with 28px padding. Both reflow to the viewport width with 16px side padding on narrow screens.

Spacing steps by 4: 4, 8, 12, 16, 20, 24, 28px. Gaps inside rows are 12px (avatar to text) or 16px (settings rows).

## Elevation & Depth

Flat tonal layering with one shadow. Inside the popup there are no shadows at all: depth is surface tone (inset grey-blue panels on the white bubble) and hairline dividers. The settings and prompt cards carry Chrome's single elevation-1 shadow to lift them off the page wash.

### Shadow Vocabulary
- **Card Lift** (`box-shadow: 0 1px 2px rgb(0 0 0 / 0.3), 0 1px 3px 1px rgb(0 0 0 / 0.15)`; dark `0 1px 2px rgb(0 0 0 / 0.5), 0 1px 3px 1px rgb(0 0 0 / 0.3)`): settings cards and the prompt card only.
- **Surface Ring** (`box-shadow: 0 0 0 2px <surface>`): separates the coral dot from the avatar it sits on, and the selected swatch from its 2px colour ring.

### Named Rules
**The Popup Is Flat Rule.** Nothing inside the popup casts a shadow; Chrome draws the bubble, the extension draws tone and hairlines.

## Shapes

Three corner families, each tied to a Chrome control type: full pills (999px) for buttons, the search field and the switch; gentle 8px corners for text fields, selects, emoji choices and the inline notice; 12px for containers (settings cards, the prompt card, the inset "Always open" and confirm panels). Circles for avatars, icon buttons, swatches and the coral dot. `kbd` chips use 4px. Strokes are 1px outline; dividers are 1px hairline.

Icons are a Feather-style line set drawn inline as SVG: 24-unit viewBox, 1.75 stroke, round caps and joins, 20px in rows (18px in icon buttons, 16px in notices and site lists), in the current text colour.

## Components

### Buttons
Chrome's pill buttons: quiet by default, filled only for the one primary action.
- **Shape:** full pill (999px), 36px tall, 16px side padding, 8px icon gap, label weight 500.
- **Outlined (default):** transparent with a 1px outline stroke and blue label.
- **Filled:** blue fill, on-primary label. **Tonal:** blue-container fill. **Text:** no stroke, 12px padding. **Danger:** red label; filled danger is a red fill with surface-colour text.
- **Hover / Press:** an overlay layer inside the pill takes the 8% / 12% state colour over 120ms. Disabled is 38% opacity with no overlay.
- **Icon button:** 32px circle, muted-ink icon at 18px, same overlays.

### Inputs / Fields
- **Style:** outlined, 1px outline stroke, transparent fill, 8px corners, 36px tall, 12px padding; label above in the Label style with a 6px gap. Selects use the same box with a chevron at the right.
- **Hover:** stroke darkens to ink. **Focus:** stroke turns blue and doubles via a 1px inset ring.
- **Error:** red stroke with the same inset doubling; 12px red error text beneath.
- **Bare select:** the identity header's container switcher drops the box entirely, shows the name in the Title style, and underlines on hover.

### Search
Chrome's pill search: raised grey-blue fill, no stroke, 36px, magnifier icon in muted ink. Focus draws a 2px blue ring inset on the pill.

### Menu Rows
- **Style:** full-width, 40px minimum (48px for container rows), 16px side padding, 12px gap, muted-ink leading icon. Hover and press fill the whole row with the state overlays.
- **Container rows:** avatar, name (with the coral dot if this tab's container), secondary meta, and a right-edge shortcut hint. On hover or keyboard focus the hint gives way to round hide and edit icon buttons, which keep their own circular overlay inside the row's band. Hidden containers show the actions permanently and dim the name to muted ink. Drag reordering shows a 2px blue insertion line inset 16px.
- **Danger rows:** red label and icon.

### Avatars
Circle, 28px (40px in the identity header), holding the container's emoji or its initial at 55% of the size, weight 600. Light: 22% tint of the tab-group colour; dark: the solid group colour. No container: raised grey with muted ink.

### Cards / Containers
- **Settings card:** surface fill, 12px corners, Card Lift shadow, rows of 56px minimum with 12px/20px padding separated by hairlines; trailing control (switch, outlined button, `kbd`, external-link icon) at the right.
- **Inset panel:** surface-container fill, 12px corners, no shadow; used for the "Always open … in" row and the delete confirmation.
- **Error notice:** error-container fill, 8px corners, 16px error icon, secondary type.

### Switch and Checkbox
Chrome settings' compact switch: 36 by 20px pill with a 2px outline border and raised-grey track; the thumb grows from 10 to 12px and slides 15px over 150ms on `cubic-bezier(.2,0,0,1)`, and the track turns solid blue when on. Checkboxes are native 18px boxes with a blue accent.

### Edit Panel
The tab-group-editor-style panel slides in place (180ms, 8px from the right, same easing): a back button and Title heading, the name field, a row of 30px emoji choices with an emoji input, the nine 28px tab-group swatches (selected shows a check and a 2px colour ring off a 2px surface gap), the "Always opens here" site list, and a hairline-topped footer of pill buttons.

## Do's and Don'ts

### Do:
- **Do** take every colour from the token set and switch light and dark with `prefers-color-scheme` alone.
- **Do** show hover and press as the 8% and 12% ink overlays, across the full width of a row.
- **Do** keep type on Chrome's ramp (11, 12, 13, 15, 20px) in the system UI font, with weight as the only emphasis.
- **Do** use the 2px blue focus ring (offset 2px, inset -2px on full-width rows and the search pill) on every focusable control.
- **Do** draw icons as inline 1.75-stroke line SVGs in the current text colour.
- **Do** honour `prefers-reduced-motion` by collapsing transitions and animations to 0ms.

### Don't:
- **Don't** add brand colour, gradients or ornaments from the icon family to the pages; the icon and the coral dot are the only marks.
- **Don't** use primary blue as decoration, or the tab-group colours for anything but container identity.
- **Don't** put shadows inside the popup; the Card Lift shadow belongs to settings and prompt cards only.
- **Don't** introduce a second typeface, uppercase labels, or type larger than 20px.
- **Don't** build bespoke cards or dashboard tiles for the container list; it is a menu of rows.
