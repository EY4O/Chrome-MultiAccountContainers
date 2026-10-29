import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRules } from "../../src/background/rules.ts";
import { type Cookie, type SiteContext, cookiesForUrl, parseSetCookie, serialize } from "../../src/shared/cookie.ts";

const now = 1_700_000_000_000;
type Rule = ReturnType<typeof buildRules>[number];

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

test("quarantine excludes known tabs and requests without a tab", () => {
  const [quarantine] = buildRules({ containers: [], knownTabIds: [1, 2], now });
  assert.equal(quarantine.action.type, "block");
  assert.deepEqual(quarantine.condition.excludedTabIds, [-1, 1, 2]);
});
