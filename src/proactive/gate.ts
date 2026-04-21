import { getLastProactiveSentAt } from "../memory/facts.js";
import { config } from "../config.js";

const MIN_GAP_HOURS = 3;

export function shouldSendProactive(content: string): boolean {
  if (!content.trim()) return false;

  const now = new Date();
  const cfg = config();
  const hour = now.getHours();
  if (hour < cfg.QUIET_HOURS_END || hour >= cfg.QUIET_HOURS_START) return false;

  const lastSent = getLastProactiveSentAt();
  if (lastSent) {
    const gapHours = (now.getTime() - lastSent.getTime()) / (1000 * 60 * 60);
    if (gapHours < MIN_GAP_HOURS) return false;
  }

  return true;
}
