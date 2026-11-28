import { BOX_POOL_LABEL, type BoxPool } from "../shared/agent37.js"
import type { Config } from "./config.js"
import type { ActivePool } from "./providers/auto.js"

type PoolConfig = Pick<Config, "mock" | "provider" | "boxProvider">
type CloudConfig = Pick<Config, "boxProvider">
type HasKey = (k: "upstashBoxApiKey" | "agent37ApiKey") => boolean

/** Where new pool boxes come from right now, and the env pin that decides it (null: Settings and the keys do). */
export interface PoolSource {
  pool: ActivePool
  /** What BOX_PROVIDER in the server's env fixes the default to, so Settings' pick doesn't count (null: no pin). */
  pin: ActivePool | null
}

const PIN_PLACE: Record<ActivePool, string> = { upstash: BOX_POOL_LABEL.upstash, agent37: BOX_POOL_LABEL.agent37, local: "folders on this machine" }

/**
 * Where new pool boxes come from (makeProvider's `active()`, Settings › Box providers, pool_status). BOX_PROVIDER=local
 * (or mock mode) keeps every box on this machine. BOX_PROVIDER=upstash or agent37 pins the default cloud, but a task
 * or project asking for the other cloud still gets it once that cloud has a key. Without a pin: Settings' pick
 * (`picked`) once its cloud has a key; with UPSTASH_BOX_API_KEY in the env, Upstash until Agent37 has one.
 */
export function poolSource(c: PoolConfig, has: HasKey, picked: BoxPool): PoolSource {
  if (c.mock) return { pool: "local", pin: null }
  if (c.boxProvider === "local") return { pool: "local", pin: "local" }
  if (c.boxProvider === "upstash") return { pool: "upstash", pin: "upstash" }
  const onAgent37 = (): ActivePool => (has("agent37ApiKey") ? "agent37" : "local")
  if (c.provider === "agent37") return { pool: onAgent37(), pin: "agent37" }
  if (picked === "agent37") return { pool: c.provider === "upstash" && !has("agent37ApiKey") ? "upstash" : onAgent37(), pin: null }
  return { pool: c.provider === "upstash" || has("upstashBoxApiKey") ? "upstash" : "local", pin: null }
}

/** "BOX_PROVIDER=upstash pins this yard's new pool boxes to Upstash Box", for Settings and pool_status. */
export function pinNote(s: PoolSource): string | null {
  return s.pin && `BOX_PROVIDER=${s.pin} in the server's env pins this yard's new pool boxes to ${PIN_PLACE[s.pin]}`
}

/**
 * Why a task or project bound to `cloud` can't get a box of it here, in plain words, or null when it can: the env
 * pin when that's what blocks it (BOX_PROVIDER=local), else the missing key.
 */
export function cloudProblem(c: CloudConfig, has: HasKey, cloud: BoxPool): string | null {
  const label = BOX_POOL_LABEL[cloud]
  if (c.boxProvider === "local") return `BOX_PROVIDER=local pins this yard's boxes to folders on this machine, so it can't make ${label} boxes (unset BOX_PROVIDER in the server's env and restart Box Yard)`
  if (cloud === "agent37") return has("agent37ApiKey") ? null : "Agent37 boxes aren't set up: add an Agent37 API key in Settings › Box providers › Agent37 boxes"
  return has("upstashBoxApiKey") ? null : "Upstash boxes aren't set up: add an Upstash Box API key in Settings › Box providers › Upstash boxes"
}
