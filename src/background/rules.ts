// Turns per-container cookie jars into declarativeNetRequest session rules.
//
// One "set Cookie" rule exists per (scope, path, scheme, site-context) that has
// cookies. DNR applies only the highest-priority modifyHeaders rule to a given
// header, so priority encodes specificity: exact host > deeper domain >
// shallower domain, then longer path, then Lax-navigation over cross-site.
// Because a more specific scope's cookie set always contains the matching
// cookies of every less specific scope, skipping empty sets is safe: the
// request falls through to the per-container "remove Cookie" fallback.

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

export function buildRules({ containers, knownTabIds, now = Date.now() }: RuleBuildInput): Rule[] {
  const rules: Rule[] = [];
  let id = 1;
  const allContainerTabs = containers.flatMap((c) => c.tabIds);

  // Quarantine: a tab the worker has not classified yet (e.g. a popup opened
  // by a container tab a few ms ago) gets every request blocked; the worker
  // re-navigates it once it knows which container it belongs to.
  rules.push({
    id: id++,
    priority: 1_000_000_000,
    action: { type: "block" as chrome.declarativeNetRequest.RuleActionType },
    condition: { excludedTabIds: [-1, ...knownTabIds], resourceTypes: ALL_TYPES },
  });

  if (allContainerTabs.length) {
    // Never let the real cookie store leak into, or be written by, a container tab.
    rules.push({
      id: id++,
      priority: 1,
      action: {
        type: "modifyHeaders" as chrome.declarativeNetRequest.RuleActionType,
        requestHeaders: [{ header: "cookie", operation: "remove" as chrome.declarativeNetRequest.HeaderOperation }],
        responseHeaders: [{ header: "set-cookie", operation: "remove" as chrome.declarativeNetRequest.HeaderOperation }],
      },
      condition: { tabIds: allContainerTabs, resourceTypes: ALL_TYPES },
    });
  }

  for (const container of containers) {
    if (!container.tabIds.length) continue;

    rules.push({
      id: id++,
      priority: 1,
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
              priority: 10 + specificity * 100_000 + Math.min(path.length, 9_999) * 10 + bonus,
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
