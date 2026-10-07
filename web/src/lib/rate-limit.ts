/**
 * Fixed-window, in-memory rate limit for starting live runs. Per server instance only: on Vercel each
 * function instance has its own memory, so this is a speed bump, not a guarantee — swap for a Redis
 * counter (INCR + EXPIRE on the Upstash store) before relying on it in production.
 */
export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterS: number;
}

export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  check(key: string): RateLimitResult {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return { ok: false, remaining: 0, retryAfterS: Math.ceil((this.windowMs - (t - recent[0])) / 1000) };
    }
    recent.push(t);
    this.hits.set(key, recent);
    return { ok: true, remaining: this.limit - recent.length, retryAfterS: 0 };
  }
}

const g = globalThis as unknown as { __autotinkerRunLimiter?: RateLimiter };
export function runLimiter(): RateLimiter {
  g.__autotinkerRunLimiter ??= new RateLimiter(
    Number(process.env.AUTOTINKER_RUNS_PER_IP_PER_HOUR ?? 3),
    60 * 60 * 1000,
  );
  return g.__autotinkerRunLimiter;
}

const gp = globalThis as unknown as { __autotinkerPreviewLimiter?: RateLimiter };
/** Link previews: cheap-ish (≤ 2 MB fetch + maybe one small LLM call), so a per-minute budget. */
export function previewLimiter(): RateLimiter {
  gp.__autotinkerPreviewLimiter ??= new RateLimiter(Number(process.env.AUTOTINKER_PREVIEWS_PER_IP_PER_MIN ?? 20), 60 * 1000);
  return gp.__autotinkerPreviewLimiter;
}

export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "local";
}
