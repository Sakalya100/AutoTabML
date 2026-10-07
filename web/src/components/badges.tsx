import type { ExpStatus } from "@/lib/run-state";
import { CATEGORY_LABEL } from "@/lib/format";

const STATUS_STYLE: Record<ExpStatus, string> = {
  keep: "text-keep border-keep/40 bg-keep/10",
  discard: "text-ink-3 border-rule-strong bg-transparent",
  crash: "text-crash border-crash/40 bg-crash/10",
  running: "text-best border-best/40 bg-best-soft",
};

export function StatusBadge({ status }: { status: ExpStatus }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-px text-[11px] font-medium uppercase tracking-[0.06em] ${STATUS_STYLE[status]}`}>
      {status === "running" && <span className="size-1.5 animate-pulse rounded-full bg-best" aria-hidden />}
      {status}
    </span>
  );
}

export function CategoryChip({ category }: { category: string }) {
  return <span className="text-[11px] tracking-wide text-ink-3">{CATEGORY_LABEL[category] ?? category}</span>;
}

export function RadicalBadge() {
  return (
    <span
      title="A different model family or approach. The stop rule counts these: a run cannot call a ceiling until several radical attempts have failed."
      className="rounded-sm bg-ink px-1.5 py-px text-[10px] font-semibold uppercase tracking-[0.08em] text-paper"
    >
      radical
    </span>
  );
}

