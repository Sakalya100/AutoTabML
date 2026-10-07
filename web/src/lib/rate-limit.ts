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

export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "local";
}
