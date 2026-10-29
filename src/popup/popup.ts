import type { Container, GroupColor } from "../background/state.ts";
import type { BgMessage } from "../shared/messages.ts";

const COLORS: Record<GroupColor, string> = {
  grey: "#5f6368", blue: "#1a73e8", red: "#d93025", yellow: "#f9ab00", green: "#188038",
  pink: "#d01884", purple: "#a142f4", cyan: "#007b83", orange: "#fa903e",
};

const send = <T>(msg: BgMessage) => chrome.runtime.sendMessage(msg) as Promise<T>;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function render(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const { containers, current } = await send<{ containers: Container[]; current: string | null }>({
    type: "mac:list",
    tabId: tab?.id,
  });

  const currentName = containers.find((c) => c.id === current)?.name;
  $("current").textContent = currentName ? `This tab: ${currentName}` : "This tab: no container";

  const list = $<HTMLUListElement>("list");
  list.replaceChildren(...containers.map((c) => {
    const li = document.createElement("li");
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = COLORS[c.color];
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = c.name;
    const open = document.createElement("button");
    open.textContent = "Open tab";
    open.onclick = async () => {
      const opened = await send<{ error?: string }>({ type: "mac:open", id: c.id, url: "about:blank", windowId: tab?.windowId });
      if (opened?.error) return alert(opened.error);
      window.close();
    };
    const del = document.createElement("button");
    del.textContent = "Delete";
    del.onclick = async () => {
      if (!confirm(`Delete "${c.name}" and its cookies? Its open tabs will close.`)) return;
      await send({ type: "mac:delete", id: c.id });
      void render();
    };
    li.append(dot, name, open, del);
    return li;
  }));
}

const form = $<HTMLFormElement>("create");
const select = form.elements.namedItem("color") as HTMLSelectElement;
for (const color of Object.keys(COLORS)) select.add(new Option(color, color));
select.value = "blue";
form.onsubmit = async (e) => {
  e.preventDefault();
  const data = new FormData(form);
  const created = await send<{ error?: string }>({
    type: "mac:create",
    name: String(data.get("name")),
    color: data.get("color") as GroupColor,
  });
  if (created?.error) return alert(created.error);
  form.reset();
  select.value = "blue";
  void render();
};

void render();
