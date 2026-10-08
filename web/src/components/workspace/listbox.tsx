"use client";

/**
 * A custom single-select dropdown (the native <select> popup can't be styled). Button + listbox popover with the
 * ARIA listbox pattern: arrows / Home / End move, Enter or Space picks, Escape closes, typing jumps to a match,
 * clicking outside closes. Each option can carry a hint (a column's kind, a metric's direction) and a badge.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

export interface ListOption<T extends string> {
  value: T;
  label: string;
  hint?: string;
  badge?: string;
}

export function Listbox<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  mono,
}: {
  /** Accessible name, e.g. "Column to predict". */
  label: string;
  value: T;
  options: readonly ListOption<T>[];
  onChange: (v: T) => void;
  disabled?: boolean;
  mono?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const id = useId();
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    list.current?.focus();
    list.current
      ?.querySelector<HTMLElement>(`[data-i="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const openAt = () => {
    setActive(
      Math.max(
        0,
        options.findIndex((o) => o.value === value),
      ),
    );
    setOpen(true);
  };
  const pick = (i: number) => {
    const o = options[i];
    if (o) onChange(o.value);
    setOpen(false);
    button.current?.focus();
  };
  const onListKey = (e: KeyboardEvent) => {
    const last = options.length - 1;
    const moves: Record<string, () => number> = {
      ArrowDown: () => Math.min(last, active + 1),
      ArrowUp: () => Math.max(0, active - 1),
      Home: () => 0,
      End: () => last,
      PageDown: () => Math.min(last, active + 8),
      PageUp: () => Math.max(0, active - 8),
    };
    if (moves[e.key]) {
      e.preventDefault();
      setActive(moves[e.key]());
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(active);
    } else if (e.key === "Escape" || e.key === "Tab") {
      if (e.key === "Escape") e.preventDefault();
      setOpen(false);
      button.current?.focus();
    } else if (e.key.length === 1 && /\S/.test(e.key)) {
      const now = e.timeStamp;
      typed.current = {
        text:
          (now - typed.current.at < 700 ? typed.current.text : "") +
          e.key.toLowerCase(),
        at: now,
      };
      const hit = options.findIndex((o) =>
        o.label.toLowerCase().startsWith(typed.current.text),
      );
      if (hit >= 0) setActive(hit);
    }
  };

  return (
    <div ref={root} className="lb" data-open={open || undefined}>
      <button
        ref={button}
        type="button"
        className={`lb-button ${mono ? "font-mono tabular-nums" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        aria-label={`${label}: ${current?.label ?? value}`}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openAt())}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            openAt();
          }
        }}
      >
        <span className="lb-value">{current?.label ?? value}</span>
        {current?.badge && <span className="lb-badge">{current.badge}</span>}
        <svg viewBox="0 0 12 12" className="lb-chev" aria-hidden>
          <path
            d="M3 4.5 6 7.5 9 4.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <ul
          ref={list}
          id={`${id}-list`}
          role="listbox"
          aria-label={label}
          tabIndex={-1}
          className="lb-list"
          // Long hints (a metric's meaning) go under the label; short ones (a column's kind) sit at the right.
          data-stacked={
            options.some((o) => (o.hint?.length ?? 0) > 12) || undefined
          }
          aria-activedescendant={`${id}-o${active}`}
          onKeyDown={onListKey}
        >
          {options.map((o, i) => (
            <li
              key={o.value}
              id={`${id}-o${i}`}
              data-i={i}
              role="option"
              aria-selected={o.value === value}
              data-active={i === active || undefined}
              className="lb-option"
              onPointerMove={() => setActive(i)}
              onClick={() => pick(i)}
            >
              <span
                className={`lb-option-label ${mono ? "font-mono tabular-nums" : ""}`}
              >
                {o.label}
              </span>
              {o.badge && <span className="lb-badge">{o.badge}</span>}
              {o.hint && <span className="lb-hint">{o.hint}</span>}
              {o.value === value && (
                <svg viewBox="0 0 12 12" className="lb-check" aria-hidden>
                  <path
                    d="M2.5 6.2 5 8.6 9.5 3.6"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
