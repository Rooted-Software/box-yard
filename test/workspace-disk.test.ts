import { describe, expect, it } from "vitest"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import {
  WORKSPACE_WINDOW_MS,
  expectedWorkspaceBytes,
  footprintLabel,
  parseWorkspaceDu,
  workspaceDuCommand,
  workspaceFootprint,
  workspaceGrowth,
  workspacesThatFit,
} from "../shared/workspaceDisk.js"
import { tmpDir } from "./helpers.js"

const GB = 1024 ** 3
const MB = 1024 ** 2

describe("workspace footprint", () => {
  const now = 10 * WORKSPACE_WINDOW_MS
  const size = (taskId: string, peakBytes: number, at = now) => ({ taskId, boxId: "b1", at, bytes: peakBytes, peakBytes })

  it("is the biggest task folder of the last 14 days, and null when none was measured", () => {
    expect(workspaceFootprint([], now)).toBeNull()
    expect(workspaceFootprint([size("t1", 2 * GB), size("t2", 7 * GB), size("t3", 30 * GB, now - WORKSPACE_WINDOW_MS - 1)], now)).toEqual({ peakBytes: 7 * GB, tasks: 2 })
  })

  it("expects a new workspace to take the peak with 25% headroom", () => {
    expect(expectedWorkspaceBytes(null)).toBeNull()
    expect(expectedWorkspaceBytes({ peakBytes: 8 * GB, tasks: 3 })).toBe(10 * GB)
  })

  it("counts what a folder has yet to grow by, never less than nothing", () => {
    expect(workspaceGrowth(null, 0)).toBe(0)
    expect(workspaceGrowth(10 * GB, null)).toBe(10 * GB)
    expect(workspaceGrowth(10 * GB, 4 * GB)).toBe(6 * GB)
    expect(workspaceGrowth(10 * GB, 12 * GB)).toBe(0)
  })

  it("fits as many folders as the work disk holds with the floor left, at least one", () => {
    // The hodos case: ~7 GB folders (8.75 GB expected) on a 30 GB disk with a 1 GB floor: 3, not large's default 18.
    expect(workspacesThatFit(30 * GB, 1 * GB, expectedWorkspaceBytes({ peakBytes: 7 * GB, tasks: 4 }))).toBe(3)
    expect(workspacesThatFit(5 * GB, 1 * GB, 20 * GB)).toBe(1)
    expect(workspacesThatFit(30 * GB, 1 * GB, null)).toBeNull()
  })

  it("labels it for list_projects", () => {
    expect(footprintLabel({ peakBytes: 7 * GB, tasks: 4 })).toBe("7.0 GB per workspace (peak of 4 tasks in 14 days)")
    expect(footprintLabel({ peakBytes: 300 * MB, tasks: 1 })).toBe("300 MB per workspace (peak of 1 task in 14 days)")
  })

  it("reads du's KB, quoting the folder", () => {
    expect(workspaceDuCommand("/w/tasks/it's")).toBe(`du -skx '/w/tasks/it'\\''s' 2>/dev/null | tail -n 1 | cut -f1`)
    expect(parseWorkspaceDu("7340032\n")).toBe(7 * GB)
    expect(parseWorkspaceDu("")).toBeNull()
    expect(parseWorkspaceDu("du: cannot access")).toBeNull()
  })
})

describe("workspace_sizes", () => {
  it("keeps each folder's peak on its box, starts over on another box, and serves a project's readings", () => {
    const store = new Store(openDb(tmpDir(), ":memory:"))
    const p = store.createProject({ name: "hodos" })
    const other = store.createProject({ name: "other" })
    store.recordWorkspaceSize({ taskId: "task_a", projectId: p.id, boxId: "b1", bytes: 6 * GB })
    store.recordWorkspaceSize({ taskId: "task_a", projectId: p.id, boxId: "b1", bytes: 2 * GB })
    store.recordWorkspaceSize({ taskId: "task_b", projectId: other.id, boxId: "b1", bytes: 1 * GB })
    expect(store.workspaceSizes(p.id).map(({ taskId, bytes, peakBytes }) => ({ taskId, bytes, peakBytes }))).toEqual([{ taskId: "task_a", bytes: 2 * GB, peakBytes: 6 * GB }])
    expect(store.workspaceSizeOn("task_a", "b1")).toBe(2 * GB)
    expect(store.workspaceSizeOn("task_a", "b2")).toBeNull()
    store.recordWorkspaceSize({ taskId: "task_a", projectId: p.id, boxId: "b2", bytes: 3 * GB })
    expect(store.workspaceSizes(p.id)[0]).toMatchObject({ boxId: "b2", bytes: 3 * GB, peakBytes: 3 * GB })
    // Old readings drop out of the window.
    store.recordWorkspaceSize({ taskId: "task_c", projectId: p.id, boxId: "b1", bytes: 9 * GB, at: Date.now() - WORKSPACE_WINDOW_MS - 1000 })
    expect(store.workspaceSizes(p.id).map((s) => s.taskId)).toEqual(["task_a"])
  })
})
