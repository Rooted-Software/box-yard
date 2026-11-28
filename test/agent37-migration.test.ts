import { describe, expect, it } from "vitest"
import Database from "better-sqlite3"
import { MIGRATIONS, migrate } from "../server/db.js"

// tasks.environment_type (taskEnvironment.ts) had a CHECK without 'agent37', so a task's first turn on an Agent37 box
// failed to record its environment. The migration that adds it keeps every stored value and the immutability trigger.

describe("environment_type allows agent37", () => {
  it("keeps stored values, takes agent37, and stays immutable", () => {
    const db = new Database(":memory:")
    migrate(db, MIGRATIONS.findIndex((m) => m.includes("environment_type_v2")))
    db.prepare("INSERT INTO projects (id, name, description, repo, base_branch, env_json, created_at, updated_at) VALUES ('p', 'p', '', NULL, 'main', '{}', 0, 0)").run()
    const add = (id: string) => db.prepare("INSERT INTO tasks (id, project_id, title, prompt, status, session_id, created_at, updated_at, last_active_at) VALUES (?, 'p', 't', 'x', 'idle', ?, 0, 0, 0)").run(id, `s-${id}`)
    add("old")
    db.prepare("UPDATE tasks SET environment_type = 'upstash' WHERE id = 'old'").run()
    add("fresh")
    expect(() => db.prepare("UPDATE tasks SET environment_type = 'agent37' WHERE id = 'fresh'").run()).toThrow(/CHECK constraint/)

    migrate(db)
    const type = (id: string) => (db.prepare("SELECT environment_type AS t FROM tasks WHERE id = ?").get(id) as { t: string | null }).t
    expect(type("old")).toBe("upstash")
    db.prepare("UPDATE tasks SET environment_type = 'agent37' WHERE id = 'fresh'").run()
    expect(type("fresh")).toBe("agent37")
    expect(() => db.prepare("UPDATE tasks SET environment_type = 'local' WHERE id = 'old'").run()).toThrow(/immutable/)
    expect(() => db.prepare("UPDATE tasks SET environment_type = 'nowhere' WHERE id = 'fresh'").run()).toThrow()
    expect((db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe("ok")
  })
})
