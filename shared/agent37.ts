// Agent37 (https://www.agent37.com/docs/agents-api/): the second cloud that pool boxes can come from, beside Upstash
// Box (docs/agent37.md). What a Box Yard size asks Agent37 for, and the names the UI and server share.

import type { WorkerSize } from "./types.js"

/** Where new pool boxes ("Runs on: Upstash box" projects) come from: Settings › Box providers › Agent37 boxes. */
export const BOX_POOLS = ["upstash", "agent37"] as const
export type BoxPool = (typeof BOX_POOLS)[number]
export const BOX_POOL_LABEL: Record<BoxPool, string> = { upstash: "Upstash Box", agent37: "Agent37" }

/** Box ids of Agent37 instances: `agent37-<instance id>` (Agent37's ids are 10 lowercase letters and digits). */
export const AGENT37_BOX_PREFIX = "agent37-"
export const isAgent37Box = (boxId: string) => boxId.startsWith(AGENT37_BOX_PREFIX)

/** The plain Linux template (Node, Python, git, build tools, no agent). AGENT37_TEMPLATE picks another. */
export const AGENT37_DEFAULT_TEMPLATE = "agent37-base"

export interface Agent37Shape {
  cpu: number
  /** GB */
  memory: number
  /** GB: the most the shape allows, since disk is cheap ($0.09/GB-month) and workspaces need room. */
  disk: number
  /** Agent37's list price for the shape on the `default` type, at this disk, in USD per month always-on. */
  monthlyUsd: number
}

/**
 * The Agent37 shape each Box Yard size asks for: the `default` instance type's shapes
 * (https://www.agent37.com/docs/agents-api/instance-sizing.md, checked 2026-11-28). Agent37 stops at 4 vCPU, so
 * large is 4 vCPU / 16 GB, not Upstash's 8 vCPU. Prices are the doc's at its default disk plus $0.09/GB-month for the
 * extra disk asked for here; they're shown for reference, and Box Yard's cost figures come from GET /v1/usage.
 */
export const AGENT37_SHAPES: Record<WorkerSize, Agent37Shape> = {
  small: { cpu: 2, memory: 4, disk: 12, monthlyUsd: 5.48 },
  medium: { cpu: 4, memory: 8, disk: 20, monthlyUsd: 10.6 },
  large: { cpu: 4, memory: 16, disk: 40, monthlyUsd: 18 },
}

/** The Box Yard size an Agent37 instance's resources match: the smallest whose shape it has at least. */
export function agent37Size(resources: { cpu?: unknown; memory?: unknown } | null | undefined): WorkerSize | null {
  const memory = typeof resources?.memory === "number" ? resources.memory : null
  if (memory === null) return null
  if (memory >= AGENT37_SHAPES.large.memory) return "large"
  if (memory >= AGENT37_SHAPES.medium.memory) return "medium"
  return "small"
}

export const AGENT37_DOCS = "https://www.agent37.com/docs/agents-api/"
export const AGENT37_KEYS_URL = "https://www.agent37.com/dashboard/cloud/api-keys"
