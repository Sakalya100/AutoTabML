import type { Metadata } from "next";
import Link from "next/link";
import { NewRunForm } from "@/components/new-run-form";
import { liveRunsEnabled } from "@/lib/runner";
import { serverEnv } from "@/lib/server-env";
import { MAX_EXPERIMENTS_PUBLIC } from "@/lib/upload";
import "@/components/new-run.css";

export const metadata: Metadata = { title: "New run" };
export const dynamic = "force-dynamic";

export default function NewRunPage() {
  const enabled = liveRunsEnabled();
  const llmAvailable = !!(serverEnv("GROQ_API_KEY") || serverEnv("GEMINI_API_KEY"));
  return (
    <main data-terra className="nr-root">
      <div className="mx-auto max-w-[1040px] px-[var(--nr-gutter)] pt-[clamp(3rem,9vh,6.5rem)] pb-[clamp(4rem,12vh,8rem)]">
        <p className="font-mono text-[11px] tracking-[0.22em] text-[var(--lp-ink-3)] uppercase">New run</p>
        <h1 className="mt-4 font-display text-[clamp(2.6rem,6.4vw,4.9rem)] leading-[0.98] tracking-[-0.01em]">
          Paste a link.
          <br />
          Press <span className="text-[var(--lp-signal)] italic">Start.</span>
        </h1>
        <p className="mt-5 max-w-[52ch] text-[clamp(1rem,1.3vw,1.1rem)] leading-relaxed text-[var(--lp-ink-2)]">
          A team of agents plans, writes and tests models on your table, keeps only the gains that are real, and stops when the gains are noise.
        </p>
        {enabled ? (
          <NewRunForm maxExperiments={MAX_EXPERIMENTS_PUBLIC} llmAvailable={llmAvailable} />
        ) : (
          <p className="mt-10 text-[15px] text-[var(--lp-ink-2)]">
            Live runs are switched off on this deployment.{" "}
            <Link href="/replays" className="underline underline-offset-4">
              Watch a replay
            </Link>{" "}
            or run AutoTinker locally.
          </p>
        )}
      </div>
    </main>
  );
}
