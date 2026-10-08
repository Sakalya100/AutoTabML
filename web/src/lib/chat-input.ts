/**
 * What a message typed into the session composer means. Shared by the browser (instant feedback) and the server
 * (authoritative): during a run, "stop" (and close variants) is a control action, anything else steers the agents;
 * with no run in flight it's plain chat.
 */
export type MessageIntent = { kind: "control"; command: "stop" } | { kind: "steer"; text: string } | { kind: "chat"; text: string };

export const MAX_STEER_CHARS = 300;
export const MAX_MESSAGE_CHARS = 2000;

const STOP_PHRASES = new Set([
  "stop",
  "stop now",
  "stop it",
  "stop the run",
  "stop here",
  "please stop",
  "stop please",
  "halt",
  "enough",
  "thats enough",
  "that is enough",
  "wrap up",
  "wrap it up",
  "finish now",
  "end the run",
]);

/** Lowercase, drop punctuation/quotes, collapse spaces: "Stop!!" -> "stop", "That's enough." -> "thats enough". */
export function normalizeCommand(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isStopCommand(text: string): boolean {
  return STOP_PHRASES.has(normalizeCommand(text));
}

export function classifyMessage(text: string, opts: { runActive: boolean }): MessageIntent {
  const t = text.replace(/\s+/g, " ").trim();
  if (!opts.runActive) return { kind: "chat", text: t.slice(0, MAX_MESSAGE_CHARS) };
  if (isStopCommand(t)) return { kind: "control", command: "stop" };
  return { kind: "steer", text: t.slice(0, MAX_STEER_CHARS) };
}

/** The first http(s) link in a message, and the rest of the text (the optional "what to predict" sentence). */
export function splitLink(text: string): { url: string | null; rest: string } {
  const m = /https?:\/\/[^\s<>"']+/i.exec(text);
  if (!m) return { url: null, rest: text.trim() };
  const url = m[0].replace(/[),.;]+$/, "");
  const rest = (text.slice(0, m.index) + " " + text.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim();
  return { url, rest };
}

/** "predict churn" -> "Predicting churn"; otherwise "Predicting <target>" (a session's default title). */
export function sessionTitle(o: { goal?: string | null; target: string; fileName?: string | null }): string {
  const goal = (o.goal ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?]+$/, "");
  const m = /^(?:i want to |we want to |please )?(predict|forecast|estimate|classify|detect)\s+(.{2,60})$/i.exec(goal);
  if (m) return `Predicting ${m[2]}`.slice(0, 80);
  if (goal && goal.length <= 48 && !/^https?:/i.test(goal)) return goal[0].toUpperCase() + goal.slice(1);
  const target = o.target.replace(/[_-]+/g, " ").trim() || o.target;
  return `Predicting ${target}`.slice(0, 80);
}
