// rate-limiter.ts
// Reactive rate limiter for AODP API - goes fast until we hit a 429, then waits

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  resetTimestamp: number; // Unix timestamp in seconds
}

export interface RateLimitResult {
  isRateLimited: boolean;
  waitSeconds: number;
  rateLimitInfo?: RateLimitInfo;
}

/**
 * Parse rate limit headers from a 429 response
 */
export function parseRateLimitHeaders(headers: Record<string, string | string[] | undefined>): RateLimitInfo | null {
  const limit = headers['ratelimit-limit'];
  const remaining = headers['ratelimit-remaining'];
  const reset = headers['ratelimit-reset'];

  if (limit === undefined || remaining === undefined || reset === undefined) {
    return null;
  }

  return {
    limit: parseInt(String(limit), 10),
    remaining: parseInt(String(remaining), 10),
    resetTimestamp: parseInt(String(reset), 10),
  };
}

/**
 * Calculate how many seconds to wait based on rate limit info
 */
export function calculateWaitTime(rateLimitInfo: RateLimitInfo): number {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const waitSeconds = rateLimitInfo.resetTimestamp - nowSeconds;
  // Add 1 second buffer to be safe, minimum 1 second wait
  return Math.max(1, waitSeconds + 1);
}

/**
 * Wait for the specified number of seconds (silent - dashboard shows status)
 * @param seconds - Number of seconds to wait
 */
export async function displayCountdown(seconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

/**
 * Default fallback wait time when headers are missing (in seconds)
 */
export const DEFAULT_RATE_LIMIT_WAIT = 10;
