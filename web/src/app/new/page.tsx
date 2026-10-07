import type { Metadata } from "next";
import Link from "next/link";
import { NewRunForm } from "@/components/new-run-form";
import { liveRunsEnabled, runnerKind } from "@/lib/runner";
import { MAX_EXPERIMENTS_PUBLIC } from "@/lib/upload";

export const metadata: Metadata = { title: "New run" };
export const dynamic = "force-dynamic";

export default function NewRunPage() {
  const enabled = liveRunsEnabled();
  return (
    <main className="mx-auto grid max-w-[1100px] grid-cols-[minmax(0,1fr)] gap-12 px-4 pt-12 pb-20 sm:px-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div>
        <h1 className="font-display text-[clamp(2.4rem,5vw,3.5rem)] leading-none tracking-tight">Evolve a pipeline for your table</h1>
        <p className="mt-3 max-w-[58ch] text-ink-2">
          Upload a CSV, pick the column to predict, and watch the agent work. Small public runs are capped at {MAX_EXPERIMENTS_PUBLIC} experiments.
        </p>
        {enabled ? (
          <NewRunForm maxExperiments={MAX_EXPERIMENTS_PUBLIC} serverKey={!!process.env.AUTOTINKER_SERVER_ANTHROPIC_KEY} />
        ) : (
          <p className="mt-8 rounded-md border border-rule bg-paper-2 p-4 text-sm text-ink-2">
            Live runs are switched off on this deployment.{" "}
            <Link href="/replays" className="underline underline-offset-4">
              Watch a replay
            </Link>{" "}
            or run AutoTinker locally.
          </p>
        )}
      </div>
      <aside className="space-y-6 text-sm leading-relaxed text-ink-2 lg:pt-24">
        <div>
          <h2 className="font-display text-xl text-ink">What happens to your data</h2>
          <p className="mt-1">
            The file is sent to a {runnerKind() === "vercel-sandbox" ? "fresh, isolated sandbox VM" : "local engine process"} for this run only. The agent
            sees a statistical profile and at most five sample rows, never the full table. Uploads are deleted when the run ends; run records
            expire after 24 hours.
          </p>
        </div>
        <div>
          <h2 className="font-display text-xl text-ink">Heuristic or LLM?</h2>
          <p className="mt-1">
            The offline heuristic proposer walks a fixed playbook of sensible ideas — free, no key, good for seeing the loop. The Anthropic proposer
            reads the profile and the experiment ledger and invents its own ideas.
          </p>
        </div>
      </aside>
    </main>
  );
}
