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
 * Display a countdown timer to the user
 * Shows countdown in place, then clears when done
 * @param seconds - Number of seconds to count down
 * @param prefix - Text to show before the countdown (e.g., "Fetching prices... 50%")
 */
export async function displayCountdown(seconds: number, prefix?: string): Promise<void> {
  for (let remaining = seconds; remaining > 0; remaining--) {
    if (prefix) {
      process.stdout.write(`\r   ${prefix} - rate limited, waiting ${remaining}s...`);
    } else {
      process.stdout.write(`\r   Rate limited, waiting ${remaining}s...`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  // Clear the line so the next progress update can take over
  process.stdout.write(`\r\x1b[2K`);
}

/**
 * Default fallback wait time when headers are missing (in seconds)
 */
export const DEFAULT_RATE_LIMIT_WAIT = 10;
