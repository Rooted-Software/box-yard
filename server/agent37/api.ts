// A small client for Agent37's Sandbox API (https://www.agent37.com/docs/agents-api/instances.md): make, read, list,
// start, resize, fork, stop and delete this workspace's instances, sign one port's preview URL, read the spend, and run
// commands in an instance (exec). Never the account-wide calls (keys, members, billing top-ups, domains, webhooks,
// templates): the workspace key in Settings › Box providers › Agent37 (AGENT37_API_KEY) is only ever sent to these.
//
// Two planes, one key: api.agent37.com takes `Authorization: Bearer`, the instance plane (sandbox.agent37.app, where
// exec answers fastest) takes `X-Agent37-Key`. The key never goes into a URL, an instance's env, or an error message.

import http from "node:http"
import https from "node:https"

export const AGENT37_API = "https://api.agent37.com"
/** Exec on the machine the instance runs on (docs: "new code should use sandbox.agent37.app"). */
export const AGENT37_EXEC = "https://sandbox.agent37.app"

/** An instance as GET /v1/instances/{id} returns it (https://www.agent37.com/docs/agents-api/instances/object.md). */
export interface Agent37Instance {
  id: string
  status?: string
  status_reason?: { code?: string; message?: string } | null
  template?: string
  type?: string
  region?: string
  mount_path?: string
  resources?: { cpu?: number; memory?: number; disk?: number }
  url?: string
  name?: string | null
  metadata?: Record<string, string> | null
  auto_sleep?: boolean
  idle_timeout_seconds?: number
  past_due?: boolean
  /** Epoch seconds. */
  created?: number
}

export interface Agent37ExecResult {
  exit_code: number
  stdout: string
  stderr: string
  truncated?: boolean
}

/** One instance's row in GET /v1/usage (`instances`): what it spent in the window, in USD millionths. */
export interface Agent37InstanceUsage {
  id: string
  total_micros?: number
  compute_micros?: number
  awake_minutes?: number
}

export interface Agent37Request {
  method: string
  url: string
  headers: Record<string, string>
  body?: string
  timeoutMs: number
}
export interface Agent37Response {
  status: number
  text: string
}
/** How a request reaches Agent37: node:https in production, a fake in tests (never the real API). */
export type Agent37Transport = (req: Agent37Request) => Promise<Agent37Response>

/** An error Agent37 returned: its HTTP status (0: no answer) and its stable `error.code`. */
export class Agent37Error extends Error {
  constructor(
    message: string,
    /** `statusCode`, as Upstash's errors have it, so isNotFound and isTransient read it. */
    readonly statusCode: number,
    readonly code: string | null = null,
  ) {
    super(message)
  }
}

/** Codes Agent37 says are safe to send again: the call wasn't acted on, or a resend with the same exec `name` rejoins it. */
const RETRY_CODES = new Set(["try_again", "rate_limited", "wake_failed", "wake_timeout", "container_unreachable", "upstream_unreachable", "host_mesh_not_ready", "instance_saturated", "upstream_timeout"])

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * node:https with TCP keepalive and no 300-second ceiling: a long exec sends nothing until it ends, and Agent37's docs
 * measured Node's fetch dropping such a call (reset at 108 s without keepalive; fetch can't wait past 300 s).
 */
export const httpsTransport: Agent37Transport = (req) =>
  new Promise((resolve, reject) => {
    const url = new URL(req.url)
    const lib = url.protocol === "http:" ? http : https
    const r = lib.request(url, { method: req.method, headers: { ...req.headers, ...(req.body === undefined ? {} : { "Content-Length": Buffer.byteLength(req.body) }) } }, (res) => {
      const chunks: Buffer[] = []
      res.on("data", (c: Buffer) => chunks.push(c))
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }))
      res.on("error", reject)
    })
    r.on("socket", (s) => s.setKeepAlive(true, 15_000))
    r.setTimeout(req.timeoutMs, () => r.destroy(Object.assign(new Error(`timed out after ${Math.round(req.timeoutMs / 1000)} s`), { name: "TimeoutError" })))
    r.on("error", reject)
    if (req.body !== undefined) r.write(req.body)
    r.end()
  })

export interface Agent37ApiOptions {
  transport?: Agent37Transport
  api?: string
  exec?: string
  /** Waits between resends of a transient answer; shortened in tests. */
  retryMs?: number[]
}

export class Agent37Api {
  private readonly transport: Agent37Transport
  private readonly api: string
  private readonly execBase: string
  private readonly retryMs: number[]

  constructor(
    private readonly key: () => string,
    opts: Agent37ApiOptions = {},
  ) {
    this.transport = opts.transport ?? httpsTransport
    this.api = (opts.api ?? AGENT37_API).replace(/\/$/, "")
    this.execBase = (opts.exec ?? AGENT37_EXEC).replace(/\/$/, "")
    this.retryMs = opts.retryMs ?? [1_000, 3_000, 8_000, 15_000]
  }

  private auth(plane: "api" | "instance"): Record<string, string> {
    const key = this.key()
    if (!key) throw new Agent37Error("No Agent37 API key: add one in Settings › Box providers › Agent37 boxes (AGENT37_API_KEY).", 401, "invalid_api_key")
    return plane === "api" ? { Authorization: `Bearer ${key}` } : { "X-Agent37-Key": key }
  }

  /**
   * One call. `retry` resends transient answers (network, 5xx, `try_again` and the other codes Agent37 calls safe):
   * only for reads and for calls that are safe twice (exec with a `name`, start, stop, delete).
   */
  private async send<T>(method: string, url: string, o: { body?: unknown; plane?: "api" | "instance"; timeoutMs?: number; retry?: boolean } = {}): Promise<T> {
    const plane = o.plane ?? "api"
    const what = `${method} ${new URL(url).pathname}`
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = { ...this.auth(plane), Accept: "application/json", "User-Agent": "box-yard" }
      if (o.body !== undefined) headers["Content-Type"] = "application/json"
      let res: Agent37Response
      try {
        res = await this.transport({ method, url, headers, ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }), timeoutMs: o.timeoutMs ?? 60_000 })
      } catch (err) {
        // Never the key or the host in a message: the path and what went wrong.
        const e = new Agent37Error(`Agent37 ${what}: ${(err as Error)?.message ?? String(err)}`, 0, null)
        if (o.retry && attempt < this.retryMs.length) {
          await sleep(this.retryMs[attempt]!)
          continue
        }
        throw e
      }
      if (res.status >= 200 && res.status < 300) {
        try {
          return (res.text ? JSON.parse(res.text) : null) as T
        } catch {
          throw new Agent37Error(`Agent37 ${what}: the answer wasn't JSON`, res.status, null)
        }
      }
      const { code, message } = errorOf(res.text)
      const transient = res.status === 429 || res.status >= 500 || (code !== null && RETRY_CODES.has(code))
      if (o.retry && transient && attempt < this.retryMs.length) {
        await sleep(this.retryMs[attempt]!)
        continue
      }
      throw new Agent37Error(`Agent37 ${what}: ${res.status}${code ? ` ${code}` : ""}${message ? `: ${message}` : ""}`, res.status, code)
    }
  }

  private path(p: string) {
    return `${this.api}${p}`
  }

  /** POST /v1/instances: answers once the instance is `running` (or 202 while a big one is still provisioning). */
  createInstance(body: Record<string, unknown>): Promise<Agent37Instance> {
    // Not retried: a second create would make a second instance.
    return this.send("POST", this.path("/v1/instances"), { body, timeoutMs: 10 * 60_000 })
  }

  getInstance(id: string): Promise<Agent37Instance> {
    return this.send("GET", this.path(`/v1/instances/${enc(id)}`), { retry: true })
  }

  async listInstances(): Promise<Agent37Instance[]> {
    const res = await this.send<{ data?: Agent37Instance[] }>("GET", this.path("/v1/instances"), { retry: true })
    return Array.isArray(res?.data) ? res.data : []
  }

  /** DELETE /v1/instances/{id}. Acts once: a repeat answers 404, which callers count as done. */
  async deleteInstance(id: string): Promise<void> {
    await this.send("DELETE", this.path(`/v1/instances/${enc(id)}`), { retry: true })
  }

  async start(id: string): Promise<{ id: string; status?: string }> {
    return this.send("POST", this.path(`/v1/instances/${enc(id)}/start`), { retry: true, timeoutMs: 10 * 60_000 })
  }

  async stop(id: string): Promise<{ id: string; status?: string }> {
    return this.send("POST", this.path(`/v1/instances/${enc(id)}/stop`), { retry: true, timeoutMs: 5 * 60_000 })
  }

  /** POST /v1/instances/{id}/resize: cpu/memory either way, disk only up. 202 while a move to another host finishes. */
  resize(id: string, body: { cpu?: number; memory?: number; disk?: number }): Promise<{ id: string; status?: string; resources?: Agent37Instance["resources"] }> {
    return this.send("POST", this.path(`/v1/instances/${enc(id)}/resize`), { body, timeoutMs: 15 * 60_000 })
  }

  /** POST /v1/instances/{id}/fork: a second instance with the same files. Not retried (a second fork is a second instance). */
  fork(id: string, body: Record<string, unknown>): Promise<Agent37Instance> {
    return this.send("POST", this.path(`/v1/instances/${enc(id)}/fork`), { body, timeoutMs: 15 * 60_000 })
  }

  /** PATCH /v1/instances/{id}: name, metadata, auto-sleep. */
  edit(id: string, body: Record<string, unknown>): Promise<Agent37Instance> {
    return this.send("PATCH", this.path(`/v1/instances/${enc(id)}`), { body, retry: true })
  }

  /** A browser link to one port, lapsing after `ttlSeconds` (60 s to 7 days). It can't be revoked before then. */
  signedUrl(id: string, port: number, ttlSeconds: number): Promise<{ url: string; expires_at?: number }> {
    return this.send("POST", this.path(`/v1/instances/${enc(id)}/signed-url`), { body: { port, ttl_seconds: ttlSeconds }, retry: true })
  }

  /** GET /v1/usage: the workspace's spend by instance for a window of up to 90 days (settled hourly). */
  async usage(from: string, to: string): Promise<Agent37InstanceUsage[]> {
    const res = await this.send<{ instances?: Agent37InstanceUsage[] }>("GET", this.path(`/v1/usage?from=${enc(from)}&to=${enc(to)}`), { retry: true })
    return Array.isArray(res?.instances) ? res.instances : []
  }

  /**
   * Run a command as root (`sh -c`). With `name`, a resend after a dropped connection or a 504 rejoins the same run
   * instead of starting a second one, so it's retried; Agent37 remembers a name while its command runs and for 5
   * minutes after. The instance plane waits up to 15 minutes for one call.
   */
  exec(id: string, body: { command: string; name?: string }): Promise<Agent37ExecResult> {
    return this.send("POST", `${this.execBase}/v1/instances/${enc(id)}/exec`, { body: { ...body, user: "root" }, plane: "instance", retry: Boolean(body.name), timeoutMs: 16 * 60_000 })
  }

  /** Start a command as root and answer at once with its process id; it keeps running with no time limit. */
  execBackground(id: string, body: { command: string; name?: string }): Promise<{ pid: number }> {
    return this.send("POST", `${this.execBase}/v1/instances/${enc(id)}/exec`, { body: { ...body, user: "root", background: true }, plane: "instance", retry: Boolean(body.name) })
  }
}

const enc = encodeURIComponent

/** `{ "error": { "code", "message" } }` on both API catalogs, or a flat `{ "error": "<code>" }` on transport errors. */
function errorOf(text: string): { code: string | null; message: string } {
  try {
    const j = JSON.parse(text) as { error?: string | { code?: string; message?: string } }
    if (typeof j?.error === "string") return { code: j.error, message: "" }
    if (j?.error && typeof j.error === "object") return { code: j.error.code ?? null, message: String(j.error.message ?? "").slice(0, 300) }
  } catch {}
  return { code: null, message: text.slice(0, 200) }
}
