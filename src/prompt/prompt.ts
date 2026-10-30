// Shown instead of an assigned site when it opens outside its container. The
// redirect rule puts the original address after the '#'.

import type { PromptInfo } from "../shared/messages.ts";
import { avatar, h, send } from "../ui/dom.ts";

const app = document.getElementById("app")!;
const url = location.hash.slice(1);

document.documentElement.dataset.quietFocus = "";
addEventListener("keydown", () => delete document.documentElement.dataset.quietFocus, { once: true });

function who(c: PromptInfo["target"], after = ""): HTMLElement {
  return h("span", { class: "who" }, avatar(c), `${c.name}${after}`);
}

function working(text: string): void {
  app.replaceChildren(h("div", { class: "status" }, h("span", { class: "spinner", "aria-hidden": "true" }), text));
}

async function choose(info: PromptInfo, open: boolean, remember: boolean): Promise<void> {
  working(open ? `Opening in ${info.target.name}…` : "Opening here…");
  await send({ type: "mac:prompt-choice", url, open, remember });
}

function notAssigned(): void {
  // The assignment was removed (or the address is missing) since the redirect.
  const valid = /^https?:\/\//.test(url);
  app.replaceChildren(
    h("header", {}, h("img", { class: "mark", src: "icons/icon128.png", alt: "" }), h("h1", {}, valid ? "This site no longer has a container" : "Nothing to open")),
    h("p", { class: "body" }, valid ? "It isn't set to always open in a container anymore, so it can open here." : "This page opens when a site is set to always open in a container."),
    ...(valid ? [h("div", { class: "actions" }, h("div", { class: "buttons" },
      h("a", { class: "btn filled", href: url, autofocus: true }, "Continue to site")))] : []),
  );
  app.querySelector<HTMLElement>("[autofocus]")?.focus();
}

async function main(): Promise<void> {
  const info = /^https?:\/\//.test(url) ? await send<PromptInfo | null>({ type: "mac:prompt-info", url }) : null;
  if (!info) return notAssigned();
  document.title = `Open in ${info.target.name}?`;
  if (!info.ask) return choose(info, true, false);

  const remember = h("input", { type: "checkbox", id: "remember" });
  const where = info.current ? `This tab is in ${info.current.name}` : "This tab isn't in a container";
  app.replaceChildren(
    h("header", {},
      h("img", { class: "mark", src: "icons/icon128.png", alt: "" }),
      h("h1", {}, "Open ", h("span", { class: "site" }, info.host), " in ", who(info.target, "?"))),
    h("p", { class: "body" },
      `You chose to always open `, h("span", { class: "site" }, info.host), ` in ${info.target.name}. ${where}, so it won't be signed in as ${info.target.name}.`),
    h("div", { class: "actions" },
      h("label", { class: "check" }, remember, "Remember my choice for this site"),
      h("div", { class: "buttons" },
        h("button", { class: "btn", type: "button", onclick: () => void choose(info, false, remember.checked) }, "Stay here"),
        h("button", { class: "btn filled", type: "button", autofocus: true, onclick: () => void choose(info, true, remember.checked) },
          `Open in ${info.target.name}`))),
  );
  app.querySelector<HTMLElement>("[autofocus]")?.focus();
}

void main().catch((e) => {
  app.replaceChildren(h("h1", {}, "Something went wrong"), h("p", { class: "body" }, String(e?.message ?? e)),
    h("div", { class: "actions" }, h("div", { class: "buttons" }, h("button", { class: "btn filled", type: "button", onclick: () => location.reload() }, "Try again"))));
});
