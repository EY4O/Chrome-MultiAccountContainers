import assert from "node:assert/strict";
import { test } from "node:test";
import { applyCookie, cookiesForUrl, parseSetCookie, serialize } from "../../src/shared/cookie.ts";

const now = 1_700_000_000_000;
const at = (s: string) => new URL(s);

test("parses attributes and defaults", () => {
  const c = parseSetCookie("sid=abc; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=60", at("https://a.example.com/x/y"), { now })!;
  assert.equal(c.domain, "a.example.com");
  assert.equal(c.hostOnly, true);
  assert.equal(c.sameSite, "strict");
  assert.equal(c.expires, now + 60_000);
  assert.equal(parseSetCookie("k=v", at("https://h.com/x/y"), { now })!.path, "/x");
});

test("rejects what Chrome rejects", () => {
  const u = at("http://example.com/");
  assert.equal(parseSetCookie("a=1; Secure", u), null);
  assert.equal(parseSetCookie("a=1; SameSite=None", at("https://example.com/")), null);
  assert.equal(parseSetCookie("a=1; Domain=other.com", u), null);
  assert.equal(parseSetCookie("a=1; Domain=com", u), null);
  assert.equal(parseSetCookie("__Host-a=1; Secure; Path=/; Domain=example.com", at("https://example.com/")), null);
  assert.equal(parseSetCookie("a=1; HttpOnly", u, { fromScript: true }), null);
  assert.ok(parseSetCookie("a=1; Secure", at("http://a.localhost/")), "localhost is a secure context");
});

test("jar replace, delete, and HttpOnly protection", () => {
  const u = at("https://example.com/");
  let jar = applyCookie([], parseSetCookie("a=1; HttpOnly", u, { now })!, { now })!;
  assert.equal(applyCookie(jar, parseSetCookie("a=2", u, { now })!, { now, fromScript: true }), null);
  jar = applyCookie(jar, parseSetCookie("a=2", u, { now: now + 5 })!, { now })!;
  assert.equal(jar[0].value, "2");
  assert.equal(jar[0].created, now, "replacement keeps creation time");
  assert.deepEqual(applyCookie(jar, parseSetCookie("a=; Max-Age=0", u, { now })!, { now }), []);
});

test("request matching: domain, path, secure, SameSite", () => {
  const set = (s: string, url: string) => parseSetCookie(s, at(url), { now })!;
  const jar = [
    set("host=1", "https://a.example.com/"),
    set("dom=1; Domain=example.com", "https://a.example.com/"),
    set("deep=1; Path=/app", "https://a.example.com/"),
    set("sec=1; Secure", "https://a.example.com/"),
    set("strict=1; SameSite=Strict", "https://a.example.com/"),
    set("none=1; SameSite=None; Secure", "https://a.example.com/"),
  ];
  const names = (url: string, ctx: Parameters<typeof cookiesForUrl>[2] = "same-site") =>
    cookiesForUrl(jar, at(url), ctx, now).map((c) => c.name).sort();
  assert.deepEqual(names("https://b.example.com/"), ["dom"]);
  assert.deepEqual(names("https://a.example.com/apple"), ["dom", "host", "none", "sec", "strict"]);
  assert.deepEqual(names("https://a.example.com/app/x"), ["deep", "dom", "host", "none", "sec", "strict"]);
  assert.deepEqual(names("http://a.example.com/"), ["dom", "host", "strict"]);
  assert.deepEqual(names("https://a.example.com/", "cross-site-navigation"), ["dom", "host", "none", "sec"]);
  assert.deepEqual(names("https://a.example.com/", "cross-site"), ["none"]);
  assert.equal(serialize(cookiesForUrl(jar, at("https://a.example.com/app"), "same-site", now)).split("; ")[0], "deep=1");
});
