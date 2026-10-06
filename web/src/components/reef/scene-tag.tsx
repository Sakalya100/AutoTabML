import { REEF } from "@/lib/scene/contract";

export function SceneTag({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "pearl" | "select" | "gap" | "gold" | "surface" }) {
  const color = {
    muted: "rgba(196,214,232,0.72)",
    pearl: "#f4f1ff",
    select: "#a9cfff",
    gap: "#d9ecff",
    gold: REEF.best,
    surface: REEF.surfaceLight,
  }[tone];
  return (
    <span
      className="block whitespace-nowrap rounded-full px-2 py-0.5 font-mono text-[10px] leading-4 tracking-wide select-none"
      style={{ color, background: "rgba(3,8,16,0.62)", border: "1px solid rgba(160,200,230,0.18)", backdropFilter: "blur(4px)" }}
    >
      {children}
    </span>
  );
}
