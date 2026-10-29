// Cookie model and RFC 6265bis-ish parsing/matching, shared by the service
// worker (Set-Cookie headers) and the MAIN-world shim (document.cookie writes).

export type SameSite = "strict" | "lax" | "none";

export interface Cookie {
  name: string;
  value: string;
  /** Lowercase, no leading dot. */
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: SameSite;
  /** Epoch ms; null for a session cookie. */
  expires: number | null;
  created: number;
}

export interface ParseOptions {
  /** document.cookie writes may not set HttpOnly cookies. */
  fromScript?: boolean;
  now?: number;
}

/** Hosts Chrome treats as potentially trustworthy even over http. */
export function isLocalhost(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]";
}

export function defaultPath(pathname: string): string {
  if (!pathname.startsWith("/")) return "/";
  const last = pathname.lastIndexOf("/");
  return last <= 0 ? "/" : pathname.slice(0, last);
}

export function domainMatch(host: string, cookie: Pick<Cookie, "domain" | "hostOnly">): boolean {
  if (cookie.hostOnly) return host === cookie.domain;
  return host === cookie.domain || host.endsWith("." + cookie.domain);
}

export function pathMatch(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

export function isExpired(cookie: Cookie, now = Date.now()): boolean {
  return cookie.expires !== null && cookie.expires <= now;
}

/**
 * Parses one Set-Cookie header value (or document.cookie assignment) in the
 * context of `url`. Returns null when the browser would reject the cookie.
 * An already-expired result is returned as-is: it means "delete".
 */
export function parseSetCookie(header: string, url: URL, opts: ParseOptions = {}): Cookie | null {
  const now = opts.now ?? Date.now();
  const host = url.hostname.toLowerCase();
  const secureContext = url.protocol === "https:" || isLocalhost(host);

  const [pair, ...attrs] = header.split(";");
  const eq = pair.indexOf("=");
  const name = (eq === -1 ? "" : pair.slice(0, eq)).trim();
  const value = (eq === -1 ? pair : pair.slice(eq + 1)).trim();
  if (!name && !value) return null;

  let domainAttr: string | null = null;
  let path: string | null = null;
  let secure = false;
  let httpOnly = false;
  let sameSite: SameSite = "lax";
  let expires: number | null = null;
  let maxAge: number | null = null;

  for (const attr of attrs) {
    const i = attr.indexOf("=");
    const key = (i === -1 ? attr : attr.slice(0, i)).trim().toLowerCase();
    const val = i === -1 ? "" : attr.slice(i + 1).trim();
    switch (key) {
      case "domain":
        domainAttr = val.replace(/^\./, "").toLowerCase() || null;
        break;
      case "path":
        path = val.startsWith("/") ? val : null;
        break;
      case "secure":
        secure = true;
        break;
      case "httponly":
        httpOnly = true;
        break;
      case "samesite": {
        const s = val.toLowerCase();
        if (s === "strict" || s === "lax" || s === "none") sameSite = s;
        break;
      }
      case "expires": {
        const t = Date.parse(val);
        if (!Number.isNaN(t)) expires = t;
        break;
      }
      case "max-age": {
        if (/^-?\d+$/.test(val)) maxAge = Number(val);
        break;
      }
    }
  }

  if (httpOnly && opts.fromScript) return null;
  if (secure && !secureContext) return null;
  if (sameSite === "none" && !secure) return null;
  if (domainAttr !== null && !domainMatch(host, { domain: domainAttr, hostOnly: false })) return null;
  // Crude public-suffix guard: a bare TLD is never a valid cookie domain.
  if (domainAttr !== null && !domainAttr.includes(".") && domainAttr !== "localhost") return null;

  if (name.startsWith("__Secure-") && !secure) return null;
  if (name.startsWith("__Host-") && (!secure || domainAttr !== null || path !== "/")) return null;

  if (maxAge !== null) expires = maxAge <= 0 ? 0 : now + maxAge * 1000;

  return {
    name,
    value,
    domain: domainAttr ?? host,
    hostOnly: domainAttr === null,
    path: path ?? defaultPath(url.pathname),
    secure,
    httpOnly,
    sameSite,
    expires,
    created: now,
  };
}

export function sameCookie(a: Cookie, b: Cookie): boolean {
  return a.name === b.name && a.domain === b.domain && a.path === b.path;
}

/**
 * Applies a parsed cookie to a jar, returning the new jar, or null when nothing
 * changed. Mirrors the browser's rules: an expired cookie deletes, script may
 * not overwrite an HttpOnly cookie, and replacement keeps the creation time.
 */
export function applyCookie(jar: Cookie[], cookie: Cookie, opts: ParseOptions = {}): Cookie[] | null {
  const now = opts.now ?? Date.now();
  const i = jar.findIndex((c) => sameCookie(c, cookie));
  const existing = i === -1 ? null : jar[i];

  if (existing && existing.httpOnly && opts.fromScript) return null;

  if (isExpired(cookie, now)) {
    if (!existing) return null;
    return jar.filter((_, j) => j !== i);
  }

  const next = { ...cookie, created: existing?.created ?? cookie.created };
  if (existing && JSON.stringify(existing) === JSON.stringify(next)) return null;
  const out = jar.slice();
  if (i === -1) out.push(next);
  else out[i] = next;
  return out;
}

/** Cookie header order: longer paths first, then oldest first. */
export function sortForHeader(cookies: Cookie[]): Cookie[] {
  return cookies.slice().sort((a, b) => b.path.length - a.path.length || a.created - b.created);
}

export function serialize(cookies: Cookie[]): string {
  return sortForHeader(cookies)
    .map((c) => (c.name ? `${c.name}=${c.value}` : c.value))
    .join("; ");
}

export type SiteContext = "same-site" | "cross-site-navigation" | "cross-site";

export function sameSiteAllows(cookie: Cookie, ctx: SiteContext): boolean {
  if (ctx === "same-site") return true;
  if (ctx === "cross-site-navigation") return cookie.sameSite !== "strict";
  return cookie.sameSite === "none";
}

/** Cookies a request to `url` would carry, as the browser would compute them. */
export function cookiesForUrl(jar: Cookie[], url: URL, ctx: SiteContext, now = Date.now()): Cookie[] {
  const host = url.hostname.toLowerCase();
  const secureOk = url.protocol === "https:" || isLocalhost(host);
  return jar.filter(
    (c) =>
      !isExpired(c, now) &&
      domainMatch(host, c) &&
      pathMatch(url.pathname || "/", c.path) &&
      (!c.secure || secureOk) &&
      sameSiteAllows(c, ctx),
  );
}

/** Rough registrable domain: last two labels. Good enough for a spike. */
export function siteOf(host: string): string {
  const labels = host.toLowerCase().split(".");
  return labels.slice(-2).join(".");
}
