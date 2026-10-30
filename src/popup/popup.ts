// Toolbar popup. List view: which container this tab is in (and where this
// site always opens), then the containers to open a tab in. Edit view: name,
// emoji, colour, sites, sign out, delete.

import type { GroupColor } from "../background/state.ts";
import type { ContainerView, PopupState } from "../shared/messages.ts";
import { COLOR_NAMES, COLORS, avatar, h, icon, send } from "../ui/dom.ts";

const app = document.getElementById("app")!;
const QUICK_EMOJI = ["🏢", "💼", "🏠", "🛒", "🏦", "🛡️", "🔧", "🎮", "📧", "☁️", "🧪", "⭐"];

let state: PopupState;
let tabId: number | undefined;
let windowId: number | undefined;
let query = "";

async function load(): Promise<void> {
  // ?tab=<id> lets the test suite point the popup at a tab; the toolbar uses the active one.
  const override = new URLSearchParams(location.search).get("tab");
  const tab = override ? await chrome.tabs.get(Number(override)) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  tabId = tab?.id;
  windowId = tab?.windowId;
  state = await send<PopupState>({ type: "mac:list", tabId });
}

let firstView = true;

function show(view: HTMLElement, focus?: HTMLElement | null): void {
  // Chrome menus appear in place; only moving between list and edit slides.
  view.classList.add("view");
  if (!firstView) view.classList.add("slide");
  firstView = false;
  app.replaceChildren(view);
  (focus ?? view.querySelector<HTMLElement>("[autofocus]"))?.focus();
}

/** An inline message under the search field (or wherever the view put its .notice). */
function showError(message: string): void {
  const notice = app.querySelector<HTMLElement>(".notice");
  if (!notice) return;
  notice.replaceChildren(icon("error"), h("span", {}, message));
  notice.hidden = false;
}

/** Runs a popup action; a failure shows inline instead of a browser dialog. */
async function attempt(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (e) {
    showError((e as Error).message);
    return false;
  }
}

/** Sizes the bare header select to its chosen option, so its chevron sits right after the name. */
function fitSelect(select: HTMLSelectElement | null): void {
  if (!select) return;
  const ctx = document.createElement("canvas").getContext("2d")!;
  ctx.font = getComputedStyle(select).font;
  const text = select.selectedOptions[0]?.textContent ?? "";
  select.style.width = `${Math.ceil(ctx.measureText(text).width) + 28}px`;
}

const byId = (id: string | null) => state.containers.find((c) => c.id === id) ?? null;
// The avatar beside each dropdown already shows the emoji; options show names only.
const optionLabel = (c: ContainerView) => c.name;

// --- List view ---------------------------------------------------------------

function identity(): HTMLElement {
  const tab = state.tab;
  const current = byId(tab?.containerId ?? null);
  if (!tab || !tab.host) {
    return h("section", { class: "identity" },
      avatar(current, { large: true, thisTab: !!current }),
      h("div", { class: "who" },
        h("strong", {}, current ? current.name : "Chrome page"),
        h("span", { class: "page-note" }, current ? "This tab's page can't change container." : "Pages like this always use your normal profile.")));
  }
  const move = h("select", { class: "select bare", "aria-label": "Container for this tab", onchange: async (e: Event) => {
    const select = e.target as HTMLSelectElement;
    fitSelect(select);
    if (await attempt(() => send({ type: "mac:reopen", tabId: tab.id, id: select.value || null }))) window.close();
  } },
  h("option", { value: "" }, "No container"),
  ...state.containers.map((c) => h("option", { value: c.id, selected: c.id === current?.id }, optionLabel(c))));
  return h("section", { class: "identity" },
    avatar(current, { large: true, thisTab: !!current }),
    h("div", { class: "who" }, move, h("span", { class: "secondary" }, `This tab · ${tab.host}`)));
}

function assignBar(): HTMLElement | null {
  const tab = state.tab;
  if (!tab?.host || !state.containers.length) return null;
  const select = h("select", { class: "select", "aria-label": `Always open ${tab.host} in`, onchange: async (e: Event) => {
    const id = (e.target as HTMLSelectElement).value || null;
    if (!(await attempt(() => send({ type: "mac:assign", host: tab.host!, id, tabId: tab.id })))) return;
    if (id && id !== tab.containerId) window.close(); // the tab is moving there
    else await refresh();
  } },
  h("option", { value: "" }, "Not assigned"),
  ...state.containers.map((c) => h("option", { value: c.id, selected: c.id === tab.assignment?.containerId }, optionLabel(c))));
  return h("div", { class: "assign" }, h("span", { class: "label" }, "Always open ", h("b", {}, tab.host), " in"), select);
}

function meta(c: ContainerView): string {
  const tabs = c.tabs === 0 ? "No tabs open" : c.tabs === 1 ? "1 tab" : `${c.tabs} tabs`;
  const sites = c.sites.length ? ` · ${c.sites.length} site${c.sites.length === 1 ? "" : "s"}` : "";
  return `${c.hidden ? "Hidden · " : ""}${tabs}${sites}`;
}

function matches(c: ContainerView): boolean {
  const q = query.trim().toLowerCase();
  return !q || c.name.toLowerCase().includes(q) || c.sites.some((s) => s.includes(q));
}

async function openIn(c: ContainerView): Promise<void> {
  if (await attempt(() => send({ type: "mac:open", id: c.id, windowId }))) window.close();
}

function moveFocus(from: HTMLElement, delta: number): void {
  const mains = [...app.querySelectorAll<HTMLElement>(".item .row")];
  const next = mains[mains.indexOf(from) + delta];
  if (next) next.focus();
  else if (delta < 0) app.querySelector<HTMLInputElement>(".search input")?.focus();
}

async function reorder(ids: string[], focusId?: string): Promise<void> {
  if (await attempt(() => send({ type: "mac:reorder", ids }))) await refresh(focusId);
}

function item(c: ContainerView): HTMLElement {
  const isCurrent = c.id === state.tab?.containerId;
  const main = h("button", { class: "row", type: "button", "data-id": c.id, title: `Open a new tab in ${c.name}`,
    onclick: () => void openIn(c),
    onkeydown: (e: KeyboardEvent) => {
      const ids = state.containers.map((x) => x.id);
      const i = ids.indexOf(c.id);
      if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        const j = i + (e.key === "ArrowUp" ? -1 : 1);
        if (j < 0 || j >= ids.length) return;
        [ids[i], ids[j]] = [ids[j], ids[i]];
        void reorder(ids, c.id);
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        moveFocus(main, e.key === "ArrowDown" ? 1 : -1);
      } else if (e.key === "Escape") {
        app.querySelector<HTMLInputElement>(".search input")?.focus();
      }
    } },
  avatar(c),
  h("span", { class: "text" },
    h("span", { class: "name" }, h("span", {}, c.name), isCurrent && h("span", { class: "this-tab-dot", title: "This tab is in this container" })),
    h("span", { class: "secondary meta" }, meta(c))),
  c.shortcut && h("span", { class: "shortcut num", "aria-label": `Shortcut ${c.shortcut}` }, c.shortcut));

  const actions = h("span", { class: "actions" },
    c.tabs > 0 && h("button", { class: "icon-btn", type: "button", "aria-pressed": c.hidden ? "true" : "false",
      "aria-label": c.hidden ? `Show ${c.name}'s tabs` : `Hide ${c.name}'s tabs`, title: c.hidden ? "Show tabs" : "Hide tabs",
      onclick: async () => {
        if (await attempt(() => send({ type: "mac:hide", id: c.id, hidden: !c.hidden }))) await refresh(c.id);
      } }, icon(c.hidden ? "eyeOff" : "eye")),
    h("button", { class: "icon-btn", type: "button", "aria-label": `Edit ${c.name}`, title: "Edit", onclick: () => editView(c) }, icon("edit")));

  const li: HTMLLIElement = h("li", { class: `item${c.hidden ? " is-hidden" : ""}`, draggable: "true", "data-id": c.id,
    ondragstart: (e: DragEvent) => {
      e.dataTransfer?.setData("text/plain", c.id);
      li.classList.add("dragging");
    },
    ondragend: () => li.classList.remove("dragging"),
    ondragover: (e: DragEvent) => {
      e.preventDefault();
      const after = e.offsetY > li.offsetHeight / 2;
      li.classList.toggle("drop-after", after);
      li.classList.toggle("drop-before", !after);
    },
    ondragleave: () => li.classList.remove("drop-before", "drop-after"),
    ondrop: (e: DragEvent) => {
      e.preventDefault();
      const moved = e.dataTransfer?.getData("text/plain");
      const after = li.classList.contains("drop-after");
      li.classList.remove("drop-before", "drop-after");
      if (!moved || moved === c.id) return;
      const ids = state.containers.map((x) => x.id).filter((id) => id !== moved);
      ids.splice(ids.indexOf(c.id) + (after ? 1 : 0), 0, moved);
      void reorder(ids, moved);
    } },
  main, actions);
  return li;
}

function listBody(): HTMLElement {
  if (!state.containers.length) {
    return h("div", { class: "empty" },
      h("h2", {}, "No containers yet"),
      h("p", { class: "secondary" }, "A container keeps its own sign-ins, separate from your normal tabs."),
      h("button", { class: "btn filled", type: "button", onclick: () => editView(null) }, icon("plus"), "New container"));
  }
  const shown = state.containers.filter(matches);
  if (!shown.length) {
    const name = query.trim();
    return h("div", { class: "empty" },
      h("h2", {}, `No containers match “${name}”`),
      h("button", { class: "btn tonal", type: "button", onclick: () => editView(null, name) }, icon("plus"), `Create “${name}”`));
  }
  return h("ul", { class: "list", "aria-label": "Containers" }, ...shown.map(item));
}

function listView(focusId?: string): void {
  const input = h("input", { type: "search", placeholder: "Search containers", "aria-label": "Search containers",
    value: query, autofocus: !focusId, autocomplete: "off",
    oninput: (e: Event) => {
      query = (e.target as HTMLInputElement).value;
      body.replaceWith((body = listBody()));
    },
    onkeydown: (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        app.querySelector<HTMLElement>(".item .row")?.focus();
      } else if (e.key === "Enter") {
        const first = state.containers.find(matches);
        if (first) void openIn(first);
        else if (query.trim()) editView(null, query.trim());
      }
    } });
  let body = listBody();
  const view = h("div", {},
    identity(),
    assignBar(),
    h("hr", { class: "divider" }),
    h("div", { class: "search-wrap" }, h("label", { class: "search" }, icon("search"), input)),
    h("div", { class: "notice", role: "alert", hidden: true }),
    body,
    h("hr", { class: "divider" }),
    h("nav", { class: "footer", "aria-label": "More" },
      // With no containers the empty state's button is the one way to create one.
      state.containers.length > 0 && h("button", { class: "row", type: "button", onclick: () => editView(null) }, icon("plus"), "New container"),
      h("button", { class: "row", type: "button", onclick: () => chrome.runtime.openOptionsPage() }, icon("settings"), "Settings")));
  show(view, focusId ? view.querySelector<HTMLElement>(`.item .row[data-id="${focusId}"]`) : undefined);
  fitSelect(view.querySelector<HTMLSelectElement>(".select.bare"));
}

async function refresh(focusId?: string): Promise<void> {
  state = await send<PopupState>({ type: "mac:list", tabId });
  listView(focusId);
}

// --- Edit view -------------------------------------------------------------------

function editView(c: ContainerView | null, presetName = ""): void {
  let color: GroupColor = c?.color ?? COLORS[state.containers.length % COLORS.length];
  const name = h("input", { class: "input", value: c?.name ?? presetName, maxlength: 40, required: true, autofocus: true,
    autocomplete: "off", "aria-describedby": "name-error" });
  const nameError = h("span", { class: "error-text", id: "name-error", role: "alert" });
  // One selection: a pressed quick pick, or anything typed into "Other".
  let chosenEmoji = c?.emoji ?? "";
  const emoji = h("input", { class: "input emoji-input", value: QUICK_EMOJI.includes(chosenEmoji) ? "" : chosenEmoji,
    "aria-label": "Other emoji", placeholder: "Other", autocomplete: "off",
    oninput: () => {
      chosenEmoji = emoji.value.trim();
      syncPicks();
    } });
  const picks = QUICK_EMOJI.map((e) => h("button", { class: "emoji-pick", type: "button", "aria-label": `Use ${e}`, "aria-pressed": "false",
    onclick: () => {
      chosenEmoji = chosenEmoji === e ? "" : e;
      emoji.value = "";
      syncPicks();
    } }, e));
  function syncPicks(): void {
    for (const p of picks) p.setAttribute("aria-pressed", String(p.textContent === chosenEmoji));
  }
  syncPicks();

  const swatches = COLORS.map((col) => h("button", { class: "swatch", type: "button", role: "radio", "data-color": col,
    "aria-label": COLOR_NAMES[col], "aria-checked": String(col === color), tabindex: col === color ? "0" : "-1",
    onclick: () => select(col),
    onkeydown: (e: KeyboardEvent) => {
      const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      const next = COLORS[(COLORS.indexOf(color) + step + COLORS.length) % COLORS.length];
      select(next);
      swatches[COLORS.indexOf(next)].focus();
    } }, icon("check")));
  function select(col: GroupColor): void {
    color = col;
    swatches.forEach((s, i) => {
      s.setAttribute("aria-checked", String(COLORS[i] === col));
      s.tabIndex = COLORS[i] === col ? 0 : -1;
    });
  }

  const confirmSlot = h("div", {});
  function confirm(text: string, action: string, run: () => Promise<void>): void {
    const box = h("div", { class: "confirm", role: "alertdialog", "aria-label": action },
      h("p", {}, text),
      h("div", { class: "buttons" },
        h("button", { class: "btn text", type: "button", onclick: () => confirmSlot.replaceChildren() }, "Cancel"),
        h("button", { class: "btn danger filled", type: "button", onclick: async () => {
          try {
            await run();
            await refresh();
          } catch (e) {
            box.querySelector("p")!.textContent = `Couldn't ${action.toLowerCase()}: ${(e as Error).message}`;
          }
        } }, action)));
    confirmSlot.replaceChildren(box);
    box.querySelector<HTMLElement>(".danger")?.focus();
  }

  const sites = c && h("section", {},
    h("h2", { class: "section-title" }, "Always opens here"),
    c.sites.length
      ? h("ul", { class: "sites" }, ...c.sites.map((site) => h("li", { class: "site" }, icon("globe"), h("span", {}, site),
        h("button", { class: "icon-btn", type: "button", "aria-label": `Stop always opening ${site} here`, title: "Remove",
          onclick: async (e: Event) => {
            await send({ type: "mac:assign", host: site, id: null });
            (e.currentTarget as HTMLElement).closest("li")?.remove();
            c.sites = c.sites.filter((s) => s !== site);
          } }, icon("close")))))
      : h("p", { class: "secondary" }, "No sites yet. On a site, choose “Always open” in this popup or the right-click menu."));

  const actions = c && h("div", { class: "edit-actions" },
    h("button", { class: "row", type: "button", onclick: () => confirm(
      `Sign out of every site in ${c.name}? Its cookies and site data are erased; the container stays.`, "Sign out",
      () => send({ type: "mac:reset", id: c.id })) }, icon("signOut"), "Sign out of everything"),
    h("button", { class: "row danger", type: "button", onclick: () => confirm(
      `Delete ${c.name}? Its ${c.tabs === 1 ? "tab closes" : "tabs close"} and its sign-ins are erased.`, "Delete",
      () => send({ type: "mac:delete", id: c.id })) }, icon("trash"), "Delete container"));

  const form = h("form", { novalidate: true, onsubmit: async (e: Event) => {
    e.preventDefault();
    const fields = { name: name.value.trim(), color, emoji: chosenEmoji };
    if (!fields.name) {
      nameError.textContent = "Give the container a name.";
      name.setAttribute("aria-invalid", "true");
      name.focus();
      return;
    }
    try {
      await send(c ? { type: "mac:update", id: c.id, ...fields } : { type: "mac:create", ...fields });
      query = "";
      await refresh(c?.id);
    } catch (err) {
      nameError.textContent = `${(err as Error).message.replace(/"([^"]*)"/g, "“$1”")}.`;
      name.setAttribute("aria-invalid", "true");
      name.focus();
    }
  } },
  h("header", { class: "panel-head" },
    h("button", { class: "icon-btn", type: "button", "aria-label": "Back", onclick: () => listView(c?.id) }, icon("back")),
    h("h1", {}, c ? "Edit container" : "New container")),
  h("div", { class: "panel-body" },
    h("label", { class: "field" }, h("span", {}, "Name"), name, nameError),
    h("div", { class: "field", role: "group", "aria-label": "Emoji" }, h("span", {}, "Emoji"), h("div", { class: "emoji-row" }, ...picks, emoji)),
    h("div", { class: "field" }, h("span", { id: "colour-label" }, "Colour"),
      h("div", { class: "swatches", role: "radiogroup", "aria-labelledby": "colour-label" }, ...swatches)),
    sites,
    actions,
    confirmSlot),
  h("footer", { class: "panel-foot" },
    h("button", { class: "btn text", type: "button", onclick: () => listView(c?.id) }, "Cancel"),
    h("button", { class: "btn filled", type: "submit" }, c ? "Save" : "Create")));
  form.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !confirmSlot.childElementCount) {
      e.preventDefault();
      listView(c?.id);
    }
  });
  name.addEventListener("input", () => {
    nameError.textContent = "";
    name.removeAttribute("aria-invalid");
  });
  show(form, name);
}

void load().then(() => listView());
