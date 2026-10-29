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
import { MARKER, SNAPSHOT } from "../shared/messages.ts";

type Rule = chrome.declarativeNetRequest.Rule;

export interface ContainerRuleInput {
  id: string;
  tabIds: number[];
  cookies: Cookie[];
}

export interface RuleBuildInput {
  containers: ContainerRuleInput[];
  /** Every tab the worker has classified (container or default). */
  knownTabIds: number[];
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

export function buildRules({ containers, knownTabIds, now = Date.now() }: RuleBuildInput): Rule[] {
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
          value: `${MARKER};desc="${encodeURIComponent(container.id)}"`,
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
      const hostRe = scope.exact ? escapeRe(scope.host) : `([^/:?#]*\\.)?${escapeRe(scope.host)}`;
      const paths = new Set(["/", ...applicable.map((c) => c.path)]);
      const localhost = isLocalhost(scope.host);

      for (const path of paths) {
        const pathCookies = applicable.filter((c) => pathMatch(path, c.path));
        const anySecure = pathCookies.some((c) => c.secure) && !localhost;
        const schemes = anySecure ? ["https", "http"] : ["https?"];

        for (const scheme of schemes) {
          const schemeCookies = scheme === "http" ? pathCookies.filter((c) => !c.secure) : pathCookies;

          for (const { ctx, bonus, condition } of CONTEXTS) {
            const cookies = schemeCookies.filter((c) => sameSiteAllows(c, ctx));
            if (!cookies.length) continue;
            const snapshot = encodeSnapshot(cookies);
            rules.push({
              id: id++,
              priority: P_FALLBACK + 10 + specificity * 100_000 + Math.min(path.length, 9_999) * 10 + bonus,
              action: {
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
              },
              condition: {
                regexFilter: `^${scheme}://${hostRe}(:[0-9]+)?${pathRe(path)}`,
                isUrlFilterCaseSensitive: true,
                tabIds: container.tabIds,
                resourceTypes: ALL_TYPES,
                ...condition,
              },
            });
          }
        }
      }
    }
  }

  return rules;
}
