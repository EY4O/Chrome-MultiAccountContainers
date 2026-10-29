import assert from "node:assert/strict";
import { test } from "node:test";
import { LOCKDOWN_RULE, buildRules, ruleUsage } from "../../src/background/rules.ts";
import { type Cookie, type SiteContext, cookiesForUrl, parseSetCookie, serialize } from "../../src/shared/cookie.ts";

const now = 1_700_000_000_000;
type Rule = ReturnType<typeof buildRules>[number];

/** DNR urlFilter syntax as a RegExp: |, ||, ^ and * (enough for what we generate). */
function urlFilterRegExp(filter: string): RegExp {
  let re = "";
  let body = filter;
  if (body.startsWith("||")) {
    re = "^[a-z][a-z0-9+.-]*://([^/?#]*\\.)?";
    body = body.slice(2);
  } else if (body.startsWith("|")) {
    re = "^";
    body = body.slice(1);
  }
  const end = body.endsWith("|") ? "$" : "";
  if (end) body = body.slice(0, -1);
  for (const ch of body) {
    if (ch === "*") re += ".*";
    else if (ch === "^") re += "([^A-Za-z0-9_.%-]|$)";
    else re += ch.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  }
  return new RegExp(re + end, "i");
}

/** Simulates DNR's choice of the Cookie header for one request. */
function cookieHeaderFor(rules: Rule[], tabId: number, url: string, ctx: SiteContext, type = "xmlhttprequest", method = "get"): string | null {
  const thirdParty = ctx !== "same-site";
  const matching = rules
    .filter((r) => {
      const c = r.condition;
      if (r.action.type !== "modifyHeaders" || !r.action.requestHeaders) return false;
      if (c.tabIds && !c.tabIds.includes(tabId)) return false;
      if (c.resourceTypes && !c.resourceTypes.includes(type as never)) return false;
      if (c.requestMethods && !c.requestMethods.includes(method as never)) return false;
      if (c.domainType === "firstParty" && thirdParty) return false;
      if (c.domainType === "thirdParty" && !thirdParty) return false;
      if (c.regexFilter && !new RegExp(c.regexFilter).test(url)) return false;
      if (c.urlFilter && !urlFilterRegExp(c.urlFilter).test(url)) return false;
      const host = new URL(url).hostname;
      if (c.requestDomains && !c.requestDomains.some((d) => host === d || host.endsWith("." + d))) return false;
      return true;
    })
    .sort((a, b) => b.priority! - a.priority!);
  const top = matching[0]?.action.requestHeaders?.find((h) => h.header === "cookie");
  if (!top) return null;
  return top.operation === "remove" ? "" : top.value!;
}

function jarFrom(lines: [string, string][]): Cookie[] {
  return lines.map(([s, url]) => parseSetCookie(s, new URL(url), { now })!);
}

test("DNR rule choice matches browser cookie semantics", () => {
  const jar = jarFrom([
    ["host=1", "https://a.example.com/"],
    ["dom=1; Domain=example.com", "https://a.example.com/"],
    ["sub=1; Domain=a.example.com", "https://a.example.com/"],
    ["deep=1; Path=/app", "https://a.example.com/"],
    ["sec=1; Secure", "https://a.example.com/"],
    ["strict=1; SameSite=Strict; Domain=example.com", "https://a.example.com/"],
    ["none=1; SameSite=None; Secure; Domain=example.com", "https://a.example.com/"],
    ["other=1", "https://other.org/"],
  ]);
  const rules = buildRules({ containers: [{ id: "c1", tabIds: [7], cookies: jar }], knownTabIds: [7], now });

  const urls = [
    "https://a.example.com/", "https://a.example.com/app", "https://a.example.com/app/x", "https://a.example.com/apple",
    "http://a.example.com/app", "https://x.a.example.com/", "https://b.example.com/", "https://example.com/",
    "https://a.example.com:8443/app", "https://other.org/", "https://unrelated.net/",
    "wss://a.example.com/socket", "ws://a.example.com/socket", "wss://x.a.example.com/",
    "https://xexample.com/", "https://a.example.com.evil.net/", "http://example.com:8080/",
  ];
  const cases: [SiteContext, string, string][] = [
    ["same-site", "xmlhttprequest", "get"],
    ["cross-site-navigation", "main_frame", "get"],
    ["cross-site", "main_frame", "post"],
    ["cross-site", "image", "get"],
  ];
  for (const url of urls) {
    for (const [ctx, type, method] of cases) {
      const expected = serialize(cookiesForUrl(jar, new URL(url), ctx, now));
      const actual = cookieHeaderFor(rules, 7, url, ctx, type, method);
      assert.equal(actual, expected, `${url} ${ctx} ${type} ${method}`);
    }
  }
  assert.equal(cookieHeaderFor(rules, 99, "https://a.example.com/", "same-site"), null, "other tabs untouched");
});

test("container tabs can't hand an identity to the browser itself", () => {
  const rules = buildRules({ containers: [{ id: "c1", tabIds: [5], cookies: [] }], knownTabIds: [5], now });
  const fallback = rules.find((r) => r.action.responseHeaders?.some((h) => h.header === "set-cookie"))!;
  const removed = (list?: { header: string; operation: string }[]) =>
    (list ?? []).filter((h) => h.operation === "remove").map((h) => h.header);
  for (const h of ["x-chrome-id-consistency-response", "sec-session-registration", "set-cookie"]) {
    assert.ok(removed(fallback.action.responseHeaders).includes(h), h);
  }
  assert.ok(removed(fallback.action.requestHeaders).includes("x-chrome-id-consistency-request"));
  assert.deepEqual(fallback.condition.tabIds, [5], "only container tabs");
});

test("a Google-sized jar fits in a small, mostly regex-free budget", () => {
  const lines: [string, string][] = [];
  const add = (n: number, attrs: string, url: string) => {
    for (let i = 0; i < n; i++) lines.push([`c${lines.length}=v; ${attrs}`, url]);
  };
  // Shaped like a real signed-in Gmail + YouTube + Discord container.
  add(10, "Domain=google.com; Path=/; Secure; SameSite=None", "https://accounts.google.com/");
  add(5, "Domain=google.com; Path=/; Secure; HttpOnly", "https://accounts.google.com/");
  add(2, "Domain=google.com; Path=/; Secure; SameSite=Strict", "https://accounts.google.com/");
  add(10, "Domain=youtube.com; Path=/; Secure; SameSite=None", "https://www.youtube.com/");
  add(7, "Domain=youtube.com; Path=/; Secure", "https://www.youtube.com/");
  add(7, "Path=/; Secure; HttpOnly", "https://accounts.google.com/");
  add(3, "Path=/; Secure", "https://mail.google.com/");
  add(3, "Path=/mail; Secure", "https://mail.google.com/");
  for (const h of ["contacts", "ogs", "play", "gds"]) add(1, "Path=/; Secure; SameSite=None", `https://${h}.google.com/`);
  add(2, "Domain=workspace.google.com; Path=/; Secure", "https://workspace.google.com/");
  add(3, "Path=/; Secure; HttpOnly", "https://discord.com/");
  add(5, "Domain=discord.com; Path=/; Secure; SameSite=Lax", "https://discord.com/");
  const jar = jarFrom(lines);
  const rules = buildRules({ containers: [{ id: "c1", tabIds: [1], cookies: jar }], knownTabIds: [1], now });
  const usage = ruleUsage(rules);
  console.log("rules for one Google-sized container:", usage);
  // The all-regex generator needed ~75 regex rules for this jar (1,000 allowed).
  assert.ok(usage.regex <= 6, `regex rules: ${usage.regex}`);
  assert.ok(usage.total <= 80, `total rules: ${usage.total}`);

  for (const url of ["https://mail.google.com/mail/u/0/", "https://www.youtube.com/", "wss://discord.com/", "http://mail.google.com/"]) {
    for (const [ctx, type] of [["same-site", "xmlhttprequest"], ["cross-site-navigation", "main_frame"], ["cross-site", "image"]] as const) {
      assert.equal(cookieHeaderFor(rules, 1, url, ctx, type), serialize(cookiesForUrl(jar, new URL(url), ctx, now)), `${url} ${ctx}`);
    }
  }
});

test("only known tabs and tabless requests escape the lockdown", () => {
  const rules = buildRules({ containers: [{ id: "c1", tabIds: [1], cookies: jarFrom([["a=1", "https://x.com/"]]) }], knownTabIds: [1, 2], now });
  const allow = rules.find((r) => r.action.type === "allow")!;
  assert.deepEqual(allow.condition.tabIds, [-1, 1, 2]);
  assert.ok(allow.priority! > LOCKDOWN_RULE.priority!, "allow beats the lockdown");
  for (const r of rules.filter((r) => r.action.type === "modifyHeaders")) {
    assert.ok(r.priority! > allow.priority!, `allow must not suppress modifyHeaders rule ${r.id}`);
  }
});
