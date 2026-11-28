/**
 * Smoke test the Agent37 provider against the real API, with AGENT37_API_KEY from the env or .env (docs/agent37.md).
 * Spends a little money: one small instance (2 vCPU / 4 GB, about $0.0075/hr) and, for the snapshot check, a fork of
 * it and a box made from that fork, for about fifteen minutes. Everything it makes is deleted at the end, also when a
 * check fails. Only run it with Cody's OK. It touches only instances it made: others in the workspace are left alone.
 *
 *   npx tsx scripts/smoke-agent37.ts            # make a box, check everything, delete it
 *   npx tsx scripts/smoke-agent37.ts --keep     # leave the box up and print its id
 *   npx tsx scripts/smoke-agent37.ts --no-snapshot   # skip the fork-snapshot checks
 *
 * Checks: the key lists instances; a small box starts and Box Yard's worker setup (git, Claude Code, credential
 * helper) runs as root; bash, GNU tools, HOME, the instance env, node and claude; a 1 MB file written and read back
 * byte for byte, a 5 MB upload; streamed output over several pieces with the exit code; a command over 128 KB; a
 * command longer than two minutes; a background process outliving the call that started it; hold ending with its
 * command and stopping it on abort; a server on a port reached through its signed preview URL; stop and wake; usage;
 * a snapshot (stopped fork) and a box made from it with the files; the sweep finding the box by its label.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash, randomBytes } from "node:crypto"
import { config } from "../server/config.js"
import { Agent37Api } from "../server/agent37/api.js"
import { Agent37Provider, instanceId } from "../server/providers/agent37.js"
import { stageBaseScript } from "../server/gitFirst.js"

const keep = process.argv.includes("--keep")
const snapshots = !process.argv.includes("--no-snapshot")
const key = config.agent37ApiKey
if (!key) throw new Error("AGENT37_API_KEY is not set")
const api = new Agent37Api(() => key)
const p = new Agent37Provider({ get: () => key }, { api, workerSize: () => "small", template: config.agent37Template, idleSleepSeconds: 300 })
const LABEL = `smoke-${randomBytes(3).toString("hex")}`
const made = new Set<string>()
const results: { name: string; ok: boolean; ms: number; detail: string }[] = []

async function check(name: string, fn: () => Promise<string | void>) {
  const t = Date.now()
  try {
    const detail = (await fn()) ?? ""
    results.push({ name, ok: true, ms: Date.now() - t, detail })
    console.log(`✓ ${name} (${((Date.now() - t) / 1000).toFixed(1)} s)${detail ? `: ${detail}` : ""}`)
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - t, detail: (err as Error)?.message ?? String(err) })
    console.log(`✗ ${name} (${((Date.now() - t) / 1000).toFixed(1)} s): ${(err as Error)?.message ?? String(err)}`)
  }
}

function must(cond: unknown, why: string): asserts cond {
  if (!cond) throw new Error(why)
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex").slice(0, 16)

let box = ""
try {
  await check("key lists instances", async () => {
    const all = await api.listInstances()
    return `${all.length} instance(s) in the workspace`
  })

  await check("create a small box and run the worker setup", async () => {
    box = await p.create({ labels: ["boxyard", LABEL], size: "small" })
    made.add(box)
    const inst = await api.getInstance(instanceId(box))
    return `${box}: ${inst.status}, ${JSON.stringify(inst.resources)}, template ${inst.template}, mount ${inst.mount_path}`
  })
  must(box, "no box: nothing else can run")

  await check("shell, user, HOME, env and tools", async () => {
    const r = await p.exec(box, 'echo "bash $BASH_VERSION"; id -un; echo "HOME=$HOME"; echo "IS_SANDBOX=${IS_SANDBOX:-unset} DISABLE_AUTOUPDATER=${DISABLE_AUTOUPDATER:-unset}"; base64 --version | head -1; dd --version | head -1; node --version; claude --version; git --version; df -h / | tail -1; nproc; free -g | sed -n 2p')
    must(r.exitCode === 0, `exit ${r.exitCode}: ${r.stderr}`)
    return r.stdout.trim().replace(/\n/g, " | ")
  })

  await check("git credential helper and root folder", async () => {
    const r = await p.exec(box, `git config --global --get-all credential.helper | tail -1; ls -ld ${p.root()} ${p.root()}/tasks`)
    must(r.exitCode === 0, r.stderr)
    return r.stdout.trim().replace(/\n/g, " | ")
  })

  await check("write and read a 1 MB file byte for byte", async () => {
    const data = randomBytes(1024 * 1024)
    const file = `${p.root()}/tasks/smoke/blob.bin`
    const t = Date.now()
    await p.writeFile(box, file, data)
    const w = Date.now() - t
    const back = await p.readFile(box, file)
    must(back.equals(data), `read back ${back.length} bytes, sha ${sha(back)} != ${sha(data)}`)
    return `write ${(w / 1000).toFixed(1)} s, read ${((Date.now() - t - w) / 1000).toFixed(1)} s`
  })

  await check("upload a 5 MB file", async () => {
    const local = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "a37-smoke-")), "up.bin")
    const data = randomBytes(5 * 1024 * 1024)
    fs.writeFileSync(local, data)
    const dest = `${p.root()}/tasks/smoke/up.bin`
    const t = Date.now()
    await p.uploadFile(box, local, dest)
    const secs = (Date.now() - t) / 1000
    const r = await p.exec(box, `sha256sum ${dest} | cut -c1-16`)
    must(r.stdout.trim() === sha(data), `remote ${r.stdout.trim()} != ${sha(data)}`)
    fs.rmSync(path.dirname(local), { recursive: true, force: true })
    return `${((5 * 1024 * 1024 * 8) / 1e6 / secs).toFixed(1)} Mbit/s`
  })

  await check("archives stage on the disk, not in the tmpfs /tmp", async () => {
    const r = await p.exec(box, `${stageBaseScript(p.root())}\necho "$bybase $(stat -f -c %T /tmp)"`)
    must(r.stdout.trim() === `${p.root()}/.boxyard/tmp tmpfs`, `got ${r.stdout.trim()} ${r.stderr}`)
  })

  await check("stream 1.5 MB of output with stderr merged and the exit code", async () => {
    let out = ""
    let chunks = 0
    const { exitCode } = await p.execStream(box, "head -c 1500000 /dev/zero | tr '\\0' z; echo é >&2; sleep 2; printf end; exit 7", (c) => {
      out += c
      chunks++
    })
    must(exitCode === 7, `exit ${exitCode}`)
    must(out.length === 1500000 + 2 + 3 && out.endsWith("end") && out.includes("é"), `got ${out.length} chars`)
    return `${chunks} chunks`
  })

  await check("a command over 128 KB", async () => {
    const r = await p.exec(box, `x=${"a".repeat(200_000)}; echo \${#x}`)
    must(r.stdout.trim() === "200000", `${r.exitCode} ${r.stdout.slice(0, 80)} ${r.stderr.slice(0, 200)}`)
  })

  await check("a command longer than two minutes", async () => {
    const r = await p.exec(box, "sleep 130; echo slept")
    must(r.exitCode === 0 && r.stdout.trim() === "slept", `${r.exitCode} ${r.stderr}`)
  })

  await check("hold ends with its command, and abort stops it", async () => {
    const t = Date.now()
    await p.hold(box, "sleep 3", new AbortController().signal)
    const first = Date.now() - t
    const ctrl = new AbortController()
    const held = p.hold(box, "while true; do date +%s > /tmp/smoke-hold; sleep 1; done", ctrl.signal)
    await new Promise((r) => setTimeout(r, 8_000))
    ctrl.abort()
    await held
    const a = (await p.exec(box, "cat /tmp/smoke-hold")).stdout.trim()
    await new Promise((r) => setTimeout(r, 4_000))
    const b = (await p.exec(box, "cat /tmp/smoke-hold")).stdout.trim()
    must(a && a === b, `the held loop still writes after abort (${a} → ${b})`)
    return `first hold returned after ${(first / 1000).toFixed(1)} s`
  })

  await check("a background process outlives its call", async () => {
    await p.exec(box, "nohup sh -c 'sleep 600' > /dev/null 2>&1 & echo started")
    await new Promise((r) => setTimeout(r, 3_000))
    const r = await p.exec(box, "pgrep -f 'sleep 600' >/dev/null && echo alive || echo gone")
    must(r.stdout.trim() === "alive", r.stdout)
  })

  await check("a server on a port answers through its signed preview URL", async () => {
    await p.exec(box, `mkdir -p /tmp/www && echo smoke-ok > /tmp/www/index.html && cd /tmp/www && (nohup python3 -m http.server 8080 > /tmp/www.log 2>&1 &) ; sleep 1; curl -s localhost:8080/ | head -1`)
    const url = await p.publicUrl(box, 8080)
    must(!url.includes(key), "the signed URL carries the key")
    const res = await fetch(url, { redirect: "follow" })
    const body = await res.text()
    must(res.ok && body.includes("smoke-ok"), `HTTP ${res.status}: ${body.slice(0, 200)}`)
    const again = await p.publicUrl(box, 8080)
    must(again === url, "the signed URL wasn't kept")
    return `HTTP ${res.status} on ${new URL(url).host}`
  })

  await check("usage", async () => JSON.stringify(await p.usage(box)))

  await check("stop, then wake", async () => {
    await api.stop(instanceId(box))
    const h = await p.health(box)
    must(h === "paused", `health ${h} after stop`)
    await p.wake(box)
    // The disk is kept; /tmp is a tmpfs, emptied by the restart.
    const r = await p.exec(box, `ls ${p.root()}/tasks/smoke; git config --global --get-all credential.helper | wc -l; test -e /tmp/www/index.html && echo tmp-kept || echo tmp-emptied`)
    must(r.exitCode === 0 && r.stdout.includes("up.bin"), `${r.exitCode} ${r.stdout} ${r.stderr}`)
    return `health after wake: ${await p.health(box)}; ${r.stdout.trim().split("\n").pop()}`
  })

  await check("the sweep finds the box by its label, and reconcile lists it", async () => {
    const ids = await p.listIds(LABEL)
    must(ids.length === 1 && ids[0] === box, `listIds: ${ids.join(",")}`)
    must((await p.liveIds()).includes(box), "liveIds misses the box")
  })

  if (snapshots) {
    let snap = ""
    await check("snapshot: a stopped fork", async () => {
      const info = await p.snapshot(box, `smoke ${LABEL}`)
      snap = info.id
      made.add(snap)
      const inst = await api.getInstance(instanceId(snap))
      must(inst.status === "stopped", `fork is ${inst.status}`)
      must((await p.listIds(LABEL)).length === 1, "the snapshot showed up in the sweep")
      return `${snap}: ${inst.status}, ${JSON.stringify(inst.resources)}`
    })
    if (snap) {
      await check("a box from the snapshot has the files", async () => {
        const second = await p.create({ labels: ["boxyard", LABEL], size: "small", snapshotId: snap })
        made.add(second)
        const r = await p.exec(second, `sha256sum ${p.root()}/tasks/smoke/up.bin | cut -c1-16; claude --version`)
        must(r.exitCode === 0, r.stderr)
        await p.destroy(second)
        made.delete(second)
        return r.stdout.trim().replace(/\n/g, " | ")
      })
      await check("delete the snapshot, and refuse a box", async () => {
        let refused = false
        await p.deleteSnapshot(box).catch(() => (refused = true))
        must(refused, "deleteSnapshot deleted a box")
        await p.deleteSnapshot(snap)
        made.delete(snap)
        must((await p.health(snap)) === "gone", "snapshot still there")
      })
    }
  }
} finally {
  if (keep && box) {
    made.delete(box)
    console.log(`kept ${box}`)
  }
  for (const id of made) {
    await p.destroy(id).then(
      () => console.log(`deleted ${id}`),
      (err) => console.log(`couldn't delete ${id}: ${(err as Error)?.message}`),
    )
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; failed: ${failed.map((f) => f.name).join("; ")}` : ""}`)
  process.exitCode = failed.length ? 1 : 0
}
