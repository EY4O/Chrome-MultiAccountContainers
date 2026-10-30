// Right-click menus: open a link in a container, reopen the current tab in a
// container, and always open this site in a container. Rebuilt whenever the
// containers change, so each submenu lists them in the popup's order.

import * as state from "./state.ts";

export interface MenuActions {
  openLink(url: string, containerId: string, tab: chrome.tabs.Tab): Promise<unknown>;
  reopen(tabId: number, containerId: string | null): Promise<unknown>;
  assign(host: string, containerId: string | null, tabId: number): Promise<unknown>;
}

const NONE = "none";
let rebuildTimer: ReturnType<typeof setTimeout> | undefined;

function rebuild(): Promise<void> {
  return new Promise((resolve) => {
    chrome.contextMenus.removeAll(() => {
      const containers = state.listContainers();
      const label = (c: state.Container) => state.groupTitle(c);
      if (containers.length) {
        chrome.contextMenus.create({ id: "open-link", title: "Open link in container", contexts: ["link"] });
        for (const c of containers) {
          chrome.contextMenus.create({ id: `open-link:${c.id}`, parentId: "open-link", title: label(c), contexts: ["link"] });
        }
      }
      const pages: ["page", "frame"] = ["page", "frame"];
      const web = ["http://*/*", "https://*/*"];
      chrome.contextMenus.create({ id: "reopen", title: "Reopen this tab in container", contexts: pages, documentUrlPatterns: web });
      for (const c of containers) {
        chrome.contextMenus.create({ id: `reopen:${c.id}`, parentId: "reopen", title: label(c), contexts: pages, documentUrlPatterns: web });
      }
      chrome.contextMenus.create({ id: "reopen-sep", parentId: "reopen", type: "separator", contexts: pages, documentUrlPatterns: web });
      chrome.contextMenus.create({ id: `reopen:${NONE}`, parentId: "reopen", title: "No container", contexts: pages, documentUrlPatterns: web });

      if (containers.length) {
        chrome.contextMenus.create({ id: "assign", title: "Always open this site in", contexts: pages, documentUrlPatterns: web });
        for (const c of containers) {
          chrome.contextMenus.create({ id: `assign:${c.id}`, parentId: "assign", title: label(c), contexts: pages, documentUrlPatterns: web });
        }
        chrome.contextMenus.create({ id: "assign-sep", parentId: "assign", type: "separator", contexts: pages, documentUrlPatterns: web });
        chrome.contextMenus.create({ id: `assign:${NONE}`, parentId: "assign", title: "Any container (remove)", contexts: pages, documentUrlPatterns: web });
      }
      resolve();
    });
  });
}

export async function handleMenuClick(info: chrome.contextMenus.OnClickData, tab: chrome.tabs.Tab | undefined, actions: MenuActions): Promise<void> {
  const [kind, target] = String(info.menuItemId).split(":");
  const containerId = target === NONE ? null : target;
  if (!tab?.id) return;
  if (kind === "open-link" && containerId && info.linkUrl) await actions.openLink(info.linkUrl, containerId, tab);
  if (kind === "reopen") await actions.reopen(tab.id, containerId);
  if (kind === "assign") {
    const url = info.frameUrl && info.frameId ? info.frameUrl : info.pageUrl ?? tab.url;
    if (url && /^https?:/.test(url)) await actions.assign(new URL(url).hostname, containerId, tab.id);
  }
}

export function installMenus(actions: MenuActions): void {
  chrome.contextMenus.onClicked.addListener((info, tab) => void handleMenuClick(info, tab, actions));
  state.onChange(() => {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => void rebuild(), 100);
  });
  void rebuild();
}
