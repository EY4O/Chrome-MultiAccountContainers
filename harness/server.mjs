// Multi-site test server. Chrome resolves every *.localhost name to loopback,
// so one port gives us as many "sites" as we like:
//   a.localhost, b.localhost, x.site.localhost, y.site.localhost, ...
//
//   GET /set?c=<Set-Cookie value>&c=...   sets cookies via response headers
//   GET /echo, /app/echo                  JSON of the Cookie header received
//   GET /page                             HTML that records document.cookie,
//                                         storage and IndexedDB from its very
//                                         first inline script (window.__early)
//   GET /child                            HTML embedding the Cookie header it got
//   GET /frame?src=<url>                  HTML with one iframe
//   GET /redirect?to=<url>&c=<cookie>     302 that also sets a cookie
//   GET /identity                         JSON, with the response headers Chrome
//                                         uses to sign the browser in to Google
//   GET /login -> 302 /home               classic login: the 302 sets session=auth;
//                                         /home hands out session=anon to anyone
//                                         arriving without a session

import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
};

const html = (res, body, headers = {}) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(`<!doctype html><html><head><meta charset="utf-8">${body}</html>`);
};

const esc = (s) => JSON.stringify(s).replace(/</g, "\\u003c");

function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const cookie = req.headers.cookie ?? "";
  const setCookies = url.searchParams.getAll("c");
  const cookieHeaders = setCookies.length ? { "set-cookie": setCookies } : {};

  switch (url.pathname) {
    case "/set":
      return json(res, 200, { ok: true }, cookieHeaders);

    case "/echo":
    case "/app/echo":
      return json(res, 200, { host: url.hostname, path: url.pathname, cookie }, cookieHeaders);

    case "/page":
      return html(res, `<script>
  // Runs before anything else on the page: proves the shim is in place in time.
  window.__early = {
    cookie: document.cookie,
    ls: localStorage.getItem("who"),
    lsKeys: Object.keys(localStorage),
    serverTiming: performance.getEntriesByType("navigation")[0].serverTiming.map((t) => t.name),
  };
  window.__serverCookie = ${esc(cookie)};
  // Inside a frame, report to the parent (test tools can't always reach OOPIFs).
  if (window.parent !== window) {
    parent.postMessage({ type: "frame-report", early: window.__early, server: window.__serverCookie }, "*");
  }
</script></head><body><h1>${url.hostname}</h1>
<a id="blank" href="/child" target="_blank">child</a></body>`, cookieHeaders);

    case "/child":
      return html(res, `<script>window.__serverCookie = ${esc(cookie)};</script></head><body>child</body>`);

    case "/frame":
      return html(res, `<script>
  addEventListener("message", (e) => { if (e.data?.type === "frame-report") window.__frameReport = e.data; });
</script></head><body><iframe id="f" src="${url.searchParams.get("src") ?? "about:blank"}"></iframe></body>`);

    case "/redirect":
      res.writeHead(302, { location: url.searchParams.get("to") ?? "/echo", "cache-control": "no-store", ...cookieHeaders });
      return res.end();

    case "/identity":
      return json(res, 200, { ok: true }, {
        "x-chrome-id-consistency-response": "action=SIGNIN,authuser=0,authorization_code=test",
        "sec-session-registration": '(ES256);path="/refresh";challenge="test"',
        "access-control-expose-headers": "*",
      });

    case "/sw.js":
      res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
      return res.end("self.addEventListener('fetch', () => {});");

    case "/login":
      res.writeHead(302, { location: "/home", "cache-control": "no-store", "set-cookie": "session=auth; Path=/; HttpOnly" });
      return res.end();

    case "/home": {
      const anon = /(^|;\s*)session=/.test(cookie) ? {} : { "set-cookie": "session=anon; Path=/; HttpOnly" };
      return html(res, `<script>window.__serverCookie = ${esc(cookie)};</script></head><body>home</body>`, anon);
    }

    default:
      res.writeHead(404);
      return res.end("not found");
  }
}

export function start(port = 8787) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 8787);
  await start(port);
  console.log(`harness listening on http://a.localhost:${port}/page (any *.localhost host works)`);
}
