// rate-limiter.ts
// Shared rate limiter for AODP API across all fetchers

import * as fs from 'fs';
import * as path from 'path';

// AODP Rate Limits
export const RATE_LIMITS = {
  perMinute: 180,
  perFiveMinutes: 300,
} as const;

export interface RateLimiterStats {
  last1min: number;
  last5min: number;
  limit1min: number;
  limit5min: number;
  pct1min: string;
  pct5min: string;
}

interface RateLimiterState {
  requestTimes: number[];
  lastUpdated: string;
}

export class RateLimiter {
  private requestTimes: number[];
  private readonly stateFile: string;

  constructor() {
    const dbDir = path.join(process.cwd(), 'src', 'db');
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    this.stateFile = path.join(dbDir, 'rate-limiter-state.json');
    this.requestTimes = this.loadState();
  }

  /**
   * Load persisted state from file (to share across processes)
   */
  private loadState(): number[] {
    try {
      if (fs.existsSync(this.stateFile)) {
        const data = JSON.parse(
          fs.readFileSync(this.stateFile, 'utf8')
        ) as RateLimiterState;
        const now = Date.now();
        const fiveMinutesAgo = now - 5 * 60 * 1000;

        // Only keep requests from last 5 minutes
        return data.requestTimes.filter((time) => time > fiveMinutesAgo);
      }
    } catch (e) {
      const error = e as Error;
      console.warn(`⚠️  Could not load rate limiter state: ${error.message}`);
    }
    return [];
  }

  /**
   * Save state to file (to share across processes)
   */
  private saveState(): void {
    try {
      const state: RateLimiterState = {
        requestTimes: this.requestTimes,
        lastUpdated: new Date().toISOString(),
      };
      fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
    } catch (e) {
      const error = e as Error;
      console.warn(`⚠️  Could not save rate limiter state: ${error.message}`);
    }
  }

  /**
   * Record a new API request
   */
  recordRequest(): void {
    const now = Date.now();
    this.requestTimes.push(now);

    // Clean up old requests (older than 5 minutes)
    const fiveMinutesAgo = now - 5 * 60 * 1000;
    this.requestTimes = this.requestTimes.filter((time) => time > fiveMinutesAgo);

    // Persist to file
    this.saveState();
  }

  /**
   * Get current rate limit statistics
   */
  getStats(): RateLimiterStats {
    // Reload state to get latest from other processes
    this.requestTimes = this.loadState();

    const now = Date.now();
    const oneMinuteAgo = now - 60 * 1000;
    const fiveMinutesAgo = now - 5 * 60 * 1000;

    const last1min = this.requestTimes.filter((time) => time > oneMinuteAgo).length;
    const last5min = this.requestTimes.filter((time) => time > fiveMinutesAgo).length;

    return {
      last1min,
      last5min,
      limit1min: RATE_LIMITS.perMinute,
      limit5min: RATE_LIMITS.perFiveMinutes,
      pct1min: ((last1min / RATE_LIMITS.perMinute) * 100).toFixed(0),
      pct5min: ((last5min / RATE_LIMITS.perFiveMinutes) * 100).toFixed(0),
    };
  }

  /**
   * Check if we need to wait before making next request
   * Returns wait time in milliseconds (0 if no wait needed)
   */
  async waitIfNeeded(): Promise<number> {
    const stats = this.getStats();

    // If we're at 90% of either limit, wait
    if (stats.last1min >= RATE_LIMITS.perMinute * 0.9) {
      return 60000; // Wait 1 minute
    }

    if (stats.last5min >= RATE_LIMITS.perFiveMinutes * 0.9) {
      return 60000; // Wait 1 minute
    }

    return 0;
  }

  /**
   * Clean up state file (call when all fetchers are done)
   */
  cleanup(): void {
    try {
      if (fs.existsSync(this.stateFile)) {
        fs.unlinkSync(this.stateFile);
      }
    } catch (e) {
      // Ignore cleanup errors
    }
  }
}
