// Turns per-container cookie jars into declarativeNetRequest session rules.
//
// One "set Cookie" rule exists per (scope, path, scheme, site-context) that has
// cookies. DNR applies only the highest-priority modifyHeaders rule to a given
// header, so priority encodes specificity: exact host > deeper domain >
// shallower domain, then longer path, then Lax-navigation over cross-site.
// Because a more specific scope's cookie set always contains the matching
// cookies of every less specific scope, skipping empty sets is safe: the
// request falls through to the per-container "remove Cookie" fallback.
//
// Budget: Chrome allows 5,000 session rules but only 1,000 regex rules. Root
// paths (nearly every cookie) use plain URL patterns; only cookies scoped to a
// deeper path need a regex. Site contexts whose cookie sets are identical are
// merged into one rule.
//
// Unclassified tabs are handled by two rules working together: a persistent
// dynamic LOCKDOWN rule blocks everything, and a session rule allows the tabs
// the worker knows about. Session rules vanish on browser restart and on
// extension reload, so until the worker has re-assigned the restored tabs,
// nothing they send can carry the wrong identity.

import {
  type Cookie,
  type SiteContext,
  domainMatch,
  isExpired,
  isLocalhost,
  pathMatch,
  sameSiteAllows,
  serialize,
} from "../shared/cookie.ts";
import { MARKER, NO_SW, SNAPSHOT } from "../shared/messages.ts";

type Rule = chrome.declarativeNetRequest.Rule;

export interface ContainerRuleInput {
  id: string;
  /** Prefix the page shim uses for this container's site storage. */
  storageId?: string;
  tabIds: number[];
  cookies: Cookie[];
}

export interface RuleBuildInput {
  containers: ContainerRuleInput[];
  /** Every tab the worker has classified (container or default). */
  knownTabIds: number[];
  /** Hosts whose normal-tab pages must not register service workers. */
  noServiceWorkerHosts?: string[];
  now?: number;
}

const ALL_TYPES = [
  "main_frame", "sub_frame", "stylesheet", "script", "image", "font", "object",
  "xmlhttprequest", "ping", "csp_report", "media", "websocket", "webtransport",
  "webbundle", "other",
] as chrome.declarativeNetRequest.ResourceType[];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function pathRe(path: string): string {
  if (path === "/") return "/";
  return escapeRe(path) + (path.endsWith("/") ? "" : "([/?]|$)");
}

const SECURE_SCHEMES = ["https", "wss"];
const INSECURE_SCHEMES = ["http", "ws"];

/**
 * Conditions matching requests to `scope` under `path` over `schemes`. Several
 * conditions mean several rules with the same action.
 */
function matchConditions(
  scope: Scope,
  path: string,
  schemes: string[],
): Partial<chrome.declarativeNetRequest.RuleCondition>[] {
  const allSchemes = schemes.length === SECURE_SCHEMES.length + INSECURE_SCHEMES.length;
  if (path !== "/") {
    const hostRe = scope.exact ? escapeRe(scope.host) : `([^/:?#]*\\.)?${escapeRe(scope.host)}`;
    return [{ regexFilter: `^(${schemes.join("|")})://${hostRe}(:[0-9]+)?${pathRe(path)}`, isUrlFilterCaseSensitive: true }];
  }
  if (scope.exact) {
    // "^" after the host matches "/" or ":", so this is exactly this host, any port.
    return schemes.map((scheme) => ({ urlFilter: `|${scheme}://${scope.host}^` }));
  }
  // requestDomains matches the domain and every subdomain, as domain cookies do.
  if (allSchemes) return [{ requestDomains: [scope.host] }];
  return schemes.map((scheme) => ({ requestDomains: [scope.host], urlFilter: `|${scheme}://` }));
}

const sameSet = (a: Cookie[], b: Cookie[]) => a.length === b.length && a.every((c) => b.includes(c));

/**
 * Hosts whose normal-tab pages must not register service workers: those some
 * container opened as a page, plus those it holds cookies for. A host already
 * covered by a parent domain in the list is dropped (requestDomains matches
 * subdomains).
 */
export function serviceWorkerHosts(pageOrigins: string[], jars: Cookie[][], now = Date.now()): string[] {
  const hosts = new Set(pageOrigins.filter((o) => /^https?:/.test(o)).map((o) => new URL(o).hostname));
  for (const jar of jars) for (const c of jar) if (!isExpired(c, now)) hosts.add(c.domain);
  const covered = (h: string) => [...hosts].some((d) => d !== h && h.endsWith("." + d));
  return [...hosts].filter((h) => !covered(h)).sort();
}

/** Rules and regex rules a rule list uses, for checking against Chrome's limits. */
export function ruleUsage(rules: Rule[]): { total: number; regex: number } {
  return { total: rules.length, regex: rules.filter((r) => r.condition.regexFilter).length };
}

interface Scope {
  host: string;
  exact: boolean;
}

function scopeCookies(scope: Scope, cookies: Cookie[]): Cookie[] {
  if (scope.exact) return cookies.filter((c) => domainMatch(scope.host, c));
  return cookies.filter(
    (c) => !c.hostOnly && (scope.host === c.domain || scope.host.endsWith("." + c.domain)),
  );
}

const CONTEXTS: { ctx: SiteContext; bonus: number; condition: Partial<chrome.declarativeNetRequest.RuleCondition> }[] = [
  { ctx: "same-site", bonus: 0, condition: { domainType: "firstParty" as chrome.declarativeNetRequest.DomainType } },
  {
    ctx: "cross-site-navigation",
    bonus: 1,
    condition: {
      domainType: "thirdParty" as chrome.declarativeNetRequest.DomainType,
      resourceTypes: ["main_frame"] as chrome.declarativeNetRequest.ResourceType[],
      requestMethods: ["get", "head"] as chrome.declarativeNetRequest.RequestMethod[],
    },
  },
  { ctx: "cross-site", bonus: 0, condition: { domainType: "thirdParty" as chrome.declarativeNetRequest.DomainType } },
];

/** Value the MAIN-world shim decodes from the navigation's Server-Timing. */
export function encodeSnapshot(cookies: Cookie[]): string {
  const visible = cookies.filter((c) => !c.httpOnly);
  return encodeURIComponent(JSON.stringify(visible.map((c) => [c.name, c.value, c.expires ?? 0])));
}

/** Priorities: lockdown < allow-known-tabs < every modifyHeaders rule. An allow
 * rule suppresses lower-priority modifyHeaders rules, so it sits below them. */
const P_LOCKDOWN = 1;
const P_ALLOW = 2;
const P_FALLBACK = 3;

/**
 * Headers through which a site hands an identity to the browser itself, or the
 * browser hands the device's identity to a site (Windows/Entra ID single
 * sign-on adds the device's refresh token to login.microsoftonline.com).
 */
export const BROWSER_IDENTITY_REQUEST_HEADERS = [
  "x-chrome-id-consistency-request",
  "x-chrome-connected",
  "x-ms-refreshtokencredential",
  "x-ms-devicecredential",
];
export const BROWSER_IDENTITY_RESPONSE_HEADERS = [
  "x-chrome-id-consistency-response",
  "x-chrome-manage-accounts",
  "google-accounts-signin",
  "google-accounts-signout",
  "google-accounts-remove-local-account",
  "sec-session-registration",
  "sec-session-challenge",
];

export const LOCKDOWN_RULE: Rule = {
  id: 1,
  priority: P_LOCKDOWN,
  action: { type: "block" as chrome.declarativeNetRequest.RuleActionType },
  condition: { resourceTypes: ALL_TYPES },
};

export function buildRules({ containers, knownTabIds, noServiceWorkerHosts = [], now = Date.now() }: RuleBuildInput): Rule[] {
  const rules: Rule[] = [];
  let id = 1;
  const allContainerTabs = containers.flatMap((c) => c.tabIds);

  // Lifts LOCKDOWN_RULE for classified tabs and for requests with no tab. A tab
  // the worker hasn't classified yet (a popup a container tab opened a few ms
  // ago, or a tab restored at startup) stays blocked; the worker replays its
  // load once it knows the tab's container.
  rules.push({
    id: id++,
    priority: P_ALLOW,
    action: { type: "allow" as chrome.declarativeNetRequest.RuleActionType },
    condition: { tabIds: [-1, ...knownTabIds], resourceTypes: ALL_TYPES },
  });

  if (allContainerTabs.length) {
    // Never let the real cookie store leak into, or be written by, a container
    // tab. That includes the browser's own identity channels: Chrome sign-in
    // (account consistency) and device-bound session headers let Google hand
    // the *browser* an account or a cookie-refresh session, which Chrome then
    // turns into real-jar cookies on its own, e.g. at the next startup.
    const remove = (header: string) => ({ header, operation: "remove" as chrome.declarativeNetRequest.HeaderOperation });
    rules.push({
      id: id++,
      priority: P_FALLBACK,
      action: {
        type: "modifyHeaders" as chrome.declarativeNetRequest.RuleActionType,
        requestHeaders: [...BROWSER_IDENTITY_REQUEST_HEADERS, "cookie"].map(remove),
        responseHeaders: [...BROWSER_IDENTITY_RESPONSE_HEADERS, "set-cookie"].map(remove),
      },
      condition: { tabIds: allContainerTabs, resourceTypes: ALL_TYPES },
    });
  }

  // A service worker's fetches carry no tab id, so DNR can't give them a
  // container's cookies: a worker registered from a normal tab would answer for
  // container tabs with the normal identity. Normal-tab pages of sites used in
  // containers are told (via Server-Timing, read by the page shim) not to
  // register one; existing ones are removed by the worker.
  if (noServiceWorkerHosts.length) {
    rules.push({
      id: id++,
      priority: P_FALLBACK,
      action: {
        type: "modifyHeaders" as chrome.declarativeNetRequest.RuleActionType,
        responseHeaders: [{
          header: "server-timing",
          operation: "append" as chrome.declarativeNetRequest.HeaderOperation,
          value: `${NO_SW};desc="1"`,
        }],
      },
      condition: {
        requestDomains: noServiceWorkerHosts,
        ...(allContainerTabs.length && { excludedTabIds: allContainerTabs }),
        resourceTypes: ["main_frame", "sub_frame"] as chrome.declarativeNetRequest.ResourceType[],
      },
    });
  }

  for (const container of containers) {
    if (!container.tabIds.length) continue;

    rules.push({
      id: id++,
      priority: P_FALLBACK,
      action: {
        type: "modifyHeaders" as chrome.declarativeNetRequest.RuleActionType,
        responseHeaders: [{
          header: "server-timing",
          operation: "append" as chrome.declarativeNetRequest.HeaderOperation,
          value: `${MARKER};desc="${encodeURIComponent(container.storageId ?? container.id)}"`,
        }],
      },
      condition: {
        tabIds: container.tabIds,
        resourceTypes: ["main_frame", "sub_frame"] as chrome.declarativeNetRequest.ResourceType[],
      },
    });

    const live = container.cookies.filter((c) => !isExpired(c, now));
    const scopes = new Map<string, Scope>();
    for (const c of live) {
      const scope = { host: c.domain, exact: c.hostOnly };
      scopes.set(`${scope.exact ? "=" : "."}${scope.host}`, scope);
    }

    for (const scope of scopes.values()) {
      const applicable = scopeCookies(scope, live);
      const specificity = scope.host.split(".").length * 2 + (scope.exact ? 1 : 0);
      const paths = new Set(["/", ...applicable.map((c) => c.path)]);
      const localhost = isLocalhost(scope.host);

      for (const path of paths) {
        const pathCookies = applicable.filter((c) => pathMatch(path, c.path));
        // Secure cookies stay off http:// and ws:// (except on localhost, as in Chrome).
        const variants = pathCookies.some((c) => c.secure) && !localhost
          ? [
            { schemes: SECURE_SCHEMES, cookies: pathCookies },
            { schemes: INSECURE_SCHEMES, cookies: pathCookies.filter((c) => !c.secure) },
          ]
          : [{ schemes: [...SECURE_SCHEMES, ...INSECURE_SCHEMES], cookies: pathCookies }];

        for (const { schemes, cookies: schemeCookies } of variants) {
          const [same, laxNav, cross] = CONTEXTS.map((t) => ({
            ...t,
            cookies: schemeCookies.filter((c) => sameSiteAllows(c, t.ctx)),
          }));
          // cross ⊆ laxNav ⊆ same. Equal sets need no site-context split.
          const tiers = sameSet(same.cookies, cross.cookies)
            ? [{ ...same, condition: {} }]
            : sameSet(laxNav.cookies, cross.cookies) ? [same, cross] : [same, laxNav, cross];

          for (const { cookies, bonus, condition } of tiers) {
            if (!cookies.length) continue;
            const snapshot = encodeSnapshot(cookies);
            const action: chrome.declarativeNetRequest.RuleAction = {
              type: "modifyHeaders" as chrome.declarativeNetRequest.RuleActionType,
              requestHeaders: [{
                header: "cookie",
                operation: "set" as chrome.declarativeNetRequest.HeaderOperation,
                value: serialize(cookies),
              }],
              ...(snapshot !== encodeURIComponent("[]") && {
                responseHeaders: [{
                  header: "server-timing",
                  operation: "append" as chrome.declarativeNetRequest.HeaderOperation,
                  value: `${SNAPSHOT};desc="${snapshot}"`,
                }],
              }),
            };
            for (const match of matchConditions(scope, path, schemes)) {
              rules.push({
                id: id++,
                priority: P_FALLBACK + 10 + specificity * 100_000 + Math.min(path.length, 9_999) * 10 + bonus,
                action,
                condition: { tabIds: container.tabIds, resourceTypes: ALL_TYPES, ...match, ...condition },
              });
            }
          }
        }
      }
    }
  }

  return rules;
}
