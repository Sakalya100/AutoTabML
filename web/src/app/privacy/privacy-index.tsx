"use client";

/*
 * The privacy page's index: sticky beside the text on wide screens, a plain list above it on narrow ones. The section
 * being read is marked by a hairline marker that glides between entries, and a thin rule fills with reading progress
 * (both from ScrollTrigger, which Lenis keeps in step). Links are plain #anchors, so Lenis glides to them.
 */

import { useRef, useState } from "react";
import { ScrollTrigger, useGSAP } from "@/lib/motion/gsap";

export function PrivacyIndex({ items }: { items: { id: string; title: string }[] }) {
  const root = useRef<HTMLElement>(null);
  const [active, setActive] = useState(items[0]?.id ?? "");

  useGSAP(
    () => {
      const nav = root.current;
      if (!nav) return;
      const triggers = items.flatMap(({ id }) => {
        const sec = document.getElementById(id);
        if (!sec) return [];
        return [
          ScrollTrigger.create({
            trigger: sec,
            start: "top 45%",
            end: "bottom 45%",
            onToggle: (self) => self.isActive && setActive(id),
          }),
        ];
      });
      const body = document.querySelector(".pv-body");
      if (body)
        triggers.push(
          ScrollTrigger.create({
            trigger: body,
            start: "top 45%",
            end: "bottom 60%",
            onUpdate: (self) => nav.style.setProperty("--pv-p", self.progress.toFixed(4)),
          }),
        );
      return () => triggers.forEach((t) => t.kill());
    },
    { scope: root, dependencies: [items] },
  );

  const at = Math.max(
    0,
    items.findIndex((x) => x.id === active),
  );
  return (
    <nav ref={root} className="pv-index" aria-label="On this page" style={{ "--pv-at": at } as React.CSSProperties}>
      <p className="pv-index-k">On this page</p>
      <div className="pv-index-track">
        <span className="pv-index-progress" aria-hidden />
        <span className="pv-index-marker" aria-hidden />
        <ol>
          {items.map((x, i) => (
            <li key={x.id}>
              <a href={`#${x.id}`} aria-current={x.id === active ? "location" : undefined}>
                <span className="pv-index-n">{String(i + 1).padStart(2, "0")}</span>
                {x.title}
              </a>
            </li>
          ))}
        </ol>
      </div>
    </nav>
  );
}
