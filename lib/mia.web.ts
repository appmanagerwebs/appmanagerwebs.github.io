export const WEB_VERSION = 3;

type Conf = { gateway: string; site: string; key: string };
type Opt = { waitMs?: number; signal?: AbortSignal };

let conf: Conf | null = null;
let pending: Promise<Conf> | null = null;
let base = "";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const trail = (s: string) => (s.endsWith("/") ? s : s + "/");
const abs = (s: string) => (/^https?:/.test(s) ? s : new URL(s, location.href).href);
const err = (message: string, status: number, retryAfter = 0, job = "") => Object.assign(new Error(message), { status, retryAfter, job });

function guessBase() {
  return typeof document !== "undefined" ? document.baseURI : "/";
}

function init(b?: string) {
  if (b !== undefined) base = trail(b);
}

function configure(c: Conf) {
  conf = { gateway: String(c.gateway).replace(/\/+$/, ""), site: String(c.site), key: String(c.key) };
}

async function load(): Promise<Conf> {
  if (conf) return conf;
  if (!pending) {
    pending = (async () => {
      let r: Response;
      try { r = await fetch(new URL("mia.site.json", abs(base || guessBase())).href, { cache: "no-cache" }); } catch (e: any) { throw err("Could not read mia.site.json: " + String(e?.message || e), 0); }
      const j: any = await r.json().catch(() => ({}));
      if (!r.ok || !j.gateway || !j.site || !j.key) throw err("This site is not connected to the gateway yet. Publish it from the hub first.", 0);
      configure(j);
      return conf as Conf;
    })().finally(() => { pending = null; });
  }
  return pending;
}

async function send(method: string, path: string, body?: any, signal?: AbortSignal) {
  const c = await load();
  const headers: Record<string, string> = { "x-mia-site": c.key };
  if (body !== undefined) headers["content-type"] = "application/json";
  let r: Response;
  try { r = await fetch(c.gateway + "/v1/" + c.site + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal, credentials: "omit", cache: "no-store" }); } catch (e: any) { throw err("Could not reach the gateway: " + String(e?.message || e), 0); }
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw err(String(j.error || "HTTP " + r.status), r.status, Number(r.headers.get("retry-after")) || 0);
  return j;
}

async function result(job: string, signal?: AbortSignal) {
  return send("GET", "/result/" + encodeURIComponent(job), undefined, signal);
}

async function wait(job: string, waitMs: number, signal?: AbortSignal) {
  const end = Date.now() + waitMs;
  let down = 0;
  for (;;) {
    const t = Date.now();
    let j: any;
    try { j = await send("GET", "/result/" + encodeURIComponent(job) + "?wait=25", undefined, signal); } catch (e: any) {
      if (e.status === 0 && !signal?.aborted && ++down < 3) { await sleep(1000 * down); continue; }
      throw e;
    }
    down = 0;
    if (j.state === "done") return j.result;
    if (j.state === "error") throw err(String(j.error || "The job failed."), 500, 0, job);
    if (Date.now() >= end) throw err("Still running. Read it later with mia.result(\"" + job + "\").", 202, 0, job);
    if (Date.now() - t < 800) await sleep(1000);
  }
}

async function fn(name: string, data: any = {}, o: Opt = {}) {
  const j = await send("POST", "/" + encodeURIComponent(name), data, o.signal);
  if (j && typeof j.job === "string" && (j.state === "queued" || j.state === "running")) return wait(j.job, o.waitMs ?? 30000, o.signal);
  return j;
}

export const mia = {
  version: WEB_VERSION,
  init,
  configure,
  fn,
  result,
  kv: {
    get: async (key: string, o: Opt = {}) => (await fn("kv.get", { key }, o)).value,
    set: async (key: string, value: any, o: Opt = {}) => { await fn("kv.set", { key, value }, o); },
  },
  form: async (name: string, fields: Record<string, string | number | boolean>, o: Opt = {}) => { await fn("form.send", { form: name, fields }, o); },
  hit: async (name: string, o: Opt = {}) => Number((await fn("count.hit", { name }, o)).count),
};
