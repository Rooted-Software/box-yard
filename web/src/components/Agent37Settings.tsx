// Settings › Box providers › Agent37 boxes: the workspace key, and which cloud new pool boxes come from (docs/agent37.md).
import { Check } from "lucide-react"
import { useSetup } from "../lib/queries"
import { AGENT37_DOCS, AGENT37_SHAPES, BOX_POOLS, BOX_POOL_LABEL } from "../../../shared/agent37"
import { BOX_SIZE_ORDER } from "../../../shared/boxSizes"
import { CREDENTIAL_INFO } from "../../../shared/setup"
import { Panel, Row } from "./SettingsBlocks"
import { CredentialField, CredentialHelp } from "./Setup"
import type { PlainSettings } from "./RunnerSettings"
import { Loading } from "./Loading"
import { NewTabLink, cx } from "./ui"

export function Agent37Panel({ fid, settings }: { fid: (k: string) => string; settings: PlainSettings | null }) {
  const { data: s } = useSetup()
  const pool = settings?.s.boxPool ?? "upstash"
  return (
    <Panel section="agent37">
      {!s ? (
        <Loading count={1} label="Loading the Agent37 key" />
      ) : (
        <Row id={fid("cred-agent37ApiKey")} label={CREDENTIAL_INFO.agent37ApiKey.label} help={<>A workspace key (sk_live_…). Box Yard uses it only on the server, to make, run commands in and delete this install's instances. <CredentialHelp k="agent37ApiKey" /></>}>
          <CredentialField k="agent37ApiKey" section="agent37" status={s.credentials.agent37ApiKey ?? { state: "unset", source: null }} id={fid("cred-agent37ApiKey")} />
        </Row>
      )}
      {!settings ? (
        <Loading count={1} label="Loading where pool boxes come from" />
      ) : (
        <Row
          id={fid("box-pool")}
          wide
          label="New pool boxes come from"
          help="Projects that run on boxes (Runs on: Upstash box) get new boxes from this cloud. Boxes already made stay where they are until they're deleted, so a switch drains over time. BOX_PROVIDER in the server's env wins over this."
          {...settings.row("boxPool")}
        >
          <div role="radiogroup" aria-label="New pool boxes come from" className="@container grid gap-2 @lg:grid-cols-2">
            {BOX_POOLS.map((p, i) => {
              const on = p === pool
              const note = p === "agent37" ? (s?.credentials.agent37ApiKey?.state === "set" ? "Key configured" : "API key missing") : s?.credentials.upstashBoxApiKey?.state === "set" ? "Key configured" : "API key missing"
              return (
                <button
                  key={p}
                  id={i === 0 ? fid("box-pool") : undefined}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  data-box-pool={p}
                  onClick={() => settings.set("boxPool", p)}
                  className={cx("flex min-h-11 flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left transition focus-visible:ring-2 focus-visible:ring-yard-400 focus-visible:outline-none", on ? "border-yard-500/60 bg-yard-500/10" : "border-zinc-800 bg-zinc-900 hover:border-zinc-700")}
                >
                  <span className="flex w-full items-center gap-1.5 text-sm font-medium text-zinc-100">
                    <span className="min-w-0 flex-1">{BOX_POOL_LABEL[p]}</span>
                    {on && <Check className="h-3.5 w-3.5 shrink-0 text-yard-300" aria-hidden="true" />}
                  </span>
                  <span className="text-[11px] text-zinc-500">{s ? note : "…"}</span>
                </button>
              )
            })}
          </div>
          {pool === "agent37" && s?.credentials.agent37ApiKey?.state !== "set" && (
            <p className="mt-2 text-xs leading-relaxed text-amber-300" data-testid="agent37-no-key">
              Add the Agent37 API key above: until then new boxes don't come from Agent37.
            </p>
          )}
          <table className="mt-3 w-full text-left text-xs" data-testid="agent37-shapes">
            <caption className="pb-1 text-left text-zinc-400">What each box size asks Agent37 for (default type, us region)</caption>
            <thead className="text-zinc-500">
              <tr>
                <th className="py-1 font-normal">Size</th>
                <th className="py-1 font-normal">vCPU · RAM · disk</th>
                <th className="py-1 font-normal">List price, always on</th>
              </tr>
            </thead>
            <tbody className="text-zinc-300">
              {BOX_SIZE_ORDER.map((z) => {
                const shape = AGENT37_SHAPES[z]
                return (
                  <tr key={z} className="border-t border-zinc-900">
                    <td className="py-1 capitalize">{z}</td>
                    <td className="py-1">{shape.cpu} vCPU · {shape.memory} GB · {shape.disk} GB</td>
                    <td className="py-1">${shape.monthlyUsd.toFixed(2)}/month</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <p className="mt-2 text-xs leading-relaxed text-zinc-500">
            Billed by the minute while running; an idle box sleeps and bills only its disk. Box Yard's cost figures come from Agent37's own usage report, up to an hour behind. <NewTabLink href={AGENT37_DOCS}>Agent37's docs</NewTabLink>
          </p>
        </Row>
      )}
    </Panel>
  )
}
