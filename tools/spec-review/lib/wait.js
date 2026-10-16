// Waiting without polling: the long-poll loop behind GET /api/specs/wait and
// GET /api/task/<id>/wait, and the client loop behind wait.js / labels.js wait.
//
// The server checks cheap file stats every half second and answers as soon as the
// condition holds, or with status "timeout" when its per-request budget runs out.
// A client that wants to wait for hours chains requests, passing back `etag` so a
// change between two requests is never missed.

import crypto from "node:crypto";

export const MAX_REQUEST_TIMEOUT_S = 900;
export const DEFAULT_REQUEST_TIMEOUT_S = 60;

export const SPEC_CONDITIONS = "all-decided | no-open | decided>=N | change";
export const LABEL_CONDITIONS = "wave-ready | round-done | labeled>=N | done | change";

// "3h", "90m", "1h30m", "45s", "2d" or plain seconds -> seconds (null if bad).
export function parseDuration(v) {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const re = /(\d+(?:\.\d+)?)\s*(d|h|m|s)/g;
  let total = 0, used = "", m;
  while ((m = re.exec(s))) { total += Number(m[1]) * { d: 86400, h: 3600, m: 60, s: 1 }[m[2]]; used += m[0]; }
  return used.replace(/\s/g, "") === s.replace(/\s/g, "") && used ? total : null;
}

// Parse an `until` value for one mode. Returns {kind, n?} or {error}.
export function parseUntil(until, mode) {
  const u = String(until || "").trim();
  // `labeled>=20` needs quoting in a shell; `labeled:20` is the shell-safe spelling.
  const ge = u.match(/^(decided|labeled)\s*(?:>=|:|=)\s*(\d+)$/);
  if (ge) {
    if ((mode === "spec") !== (ge[1] === "decided")) return { error: `'${u}' is not a ${mode}-mode condition (want ${mode === "spec" ? SPEC_CONDITIONS : LABEL_CONDITIONS})` };
    return { kind: `${ge[1]}>=`, n: Number(ge[2]) };
  }
  const simple = mode === "spec" ? ["all-decided", "no-open", "change"] : ["wave-ready", "round-done", "done", "change"];
  if (simple.includes(u)) return { kind: u };
  return { error: `unknown until '${u}' (want ${mode === "spec" ? SPEC_CONDITIONS : LABEL_CONDITIONS})` };
}

export const etagOf = (s) => crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 16);

export function requestTimeout(v) {
  if (v == null || v === "") return DEFAULT_REQUEST_TIMEOUT_S;
  const s = parseDuration(v);
  if (s == null || s < 0) return null;
  return Math.min(MAX_REQUEST_TIMEOUT_S, s);
}

// Hold the response until `check()` returns {done: true, body}, or the timeout.
// `check` may return {error, code} to end the wait with an HTTP error.
export function longPoll(req, res, json, { timeoutS, check, intervalMs = 500 }) {
  const started = Date.now();
  return new Promise((resolve) => {
    let timer = null;
    let finished = false;
    const finish = (code, body) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (!res.writableEnded && !res.destroyed) json(res, code, body);
      resolve();
    };
    req.on("close", () => { if (!res.writableEnded) { finished = true; clearTimeout(timer); resolve(); } });
    const tick = () => {
      if (finished) return;
      let r;
      try { r = check(); } catch (e) { return finish(Number.isInteger(e.code) && e.code >= 400 && e.code < 600 ? e.code : 500, { error: e.message }); }
      const waited = Math.round((Date.now() - started) / 100) / 10;
      if (r.error) return finish(r.code || 400, { error: r.error });
      if (r.done) return finish(200, { status: "satisfied", waited_s: waited, ...r.body });
      if (Date.now() - started >= timeoutS * 1000) return finish(200, { status: "timeout", waited_s: waited, ...r.body });
      timer = setTimeout(tick, Math.min(intervalMs, Math.max(0, timeoutS * 1000 - (Date.now() - started))));
    };
    tick();
  });
}

// Client side: chain long-poll requests until satisfied, a hard error, or the
// overall deadline. `buildUrl({since, timeout, extra})` returns the next URL.
// Resolves {code, body, message}: 0 satisfied, 2 timed out, 1 error/unreachable.
export async function waitLoop({ buildUrl, totalS, perRequestS = 300, fetchImpl = fetch, onProgress }) {
  const deadline = Date.now() + totalS * 1000;
  let since = null, extra = {}, last = null;
  for (;;) {
    const left = (deadline - Date.now()) / 1000;
    const t = Math.max(0, Math.min(perRequestS, Math.ceil(left)));
    let res, body;
    try {
      res = await fetchImpl(buildUrl({ since, timeout: t, extra }));
      body = await res.json().catch(() => null);
    } catch (e) {
      return { code: 1, body: last, message: `server unreachable: ${e.cause?.code || e.message}` };
    }
    if (!res.ok || !body) return { code: 1, body: last, message: `server error ${res.status}: ${(body && body.error) || res.statusText}` };
    last = body;
    if (body.status === "satisfied") return { code: 0, body };
    if (body.status !== "timeout") return { code: 1, body, message: `unexpected response status '${body.status}'` };
    since = body.etag || since;
    extra = body.baseline || extra;
    if (onProgress) onProgress(body);
    if (Date.now() >= deadline) return { code: 2, body, message: "timed out" };
  }
}
