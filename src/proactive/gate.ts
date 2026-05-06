import { getLastProactiveSentAt } from "../memory/facts.js";
import { config } from "../config.js";

const MIN_GAP_HOURS = 3;

export interface ProactiveGateResult {
  allowed: boolean;
  reason: string;
}

function isQuietHour(hour: number, quietStart: number, quietEnd: number): boolean {
  if (quietStart === quietEnd) return false;
  if (quietStart < quietEnd) return hour >= quietStart && hour < quietEnd;
  return hour >= quietStart || hour < quietEnd;
}

function getCurrentHourInTz(tz: string): number {
  return parseInt(
    new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: tz }).format(new Date()),
    10,
  );
}

export function evaluateProactiveGate(content: string): ProactiveGateResult {
  if (!content.trim()) return { allowed: false, reason: "empty_content" };

  const now = new Date();
  const cfg = config();
  const hour = getCurrentHourInTz(cfg.USER_TIMEZONE);
  if (isQuietHour(hour, cfg.QUIET_HOURS_START, cfg.QUIET_HOURS_END)) {
    return {
      allowed: false,
      reason: `quiet_hours:${cfg.QUIET_HOURS_START}-${cfg.QUIET_HOURS_END}`,
    };
  }

  const lastSent = getLastProactiveSentAt();
  if (lastSent) {
    const gapHours = (now.getTime() - lastSent.getTime()) / (1000 * 60 * 60);
    if (gapHours < MIN_GAP_HOURS) {
      return {
        allowed: false,
        reason: `min_gap:${gapHours.toFixed(2)}h<${MIN_GAP_HOURS}h`,
      };
    }
  }

  return { allowed: true, reason: "allowed" };
}

export function shouldSendProactive(content: string): boolean {
  return evaluateProactiveGate(content).allowed;
}
