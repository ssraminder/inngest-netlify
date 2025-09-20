// lib/calc.ts

import type { CompletePricingPolicy } from "./policy";

/**
 * Round a floating page count to quarter-pages with a threshold.
 * Example: if roundingThreshold = 0.5, 1.49 -> 1.25, 1.50 -> 1.5, etc.
 * We clamp to min 1 quarter page (0.25) if value > 0.
 */
export function quarterPage(value: number, roundingThreshold: number): number {
  if (!isFinite(value) || value <= 0) return 0;
  // Convert to quarters
  const quarters = value * 4;
  // Split integer + fractional quarters
  const whole = Math.floor(quarters);
  const frac = quarters - whole;
  // If the fractional part is at or above threshold, round up to next quarter
  const bump = frac >= roundingThreshold ? 1 : 0;
  const q = whole + bump;
  return q / 4;
}

/**
 * Round up to the next multiple of 5 (used for labor rounding to neat prices).
 */
export function ceilTo5(n: number): number {
  if (!isFinite(n)) return 0;
  return Math.ceil(n / 5) * 5;
}

/**
 * Compute a language multiplier from policy + requested + detected languages.
 * - languageTierMap maps languages to tier keys ("A" | "B" | "C" | "D" | "default")
 * - tiers maps tier keys to numeric multipliers (e.g., A: 1.3, default: 1)
 * - extraLanguagePct applies once per extra language beyond the first.
 */
export function pickTierMultiplier(
  policy: CompletePricingPolicy,
  requested: string[] = [],
  detected: string[] = []
): number {
  const uniq = Array.from(new Set([...(requested || []), ...(detected || [])]))
    .map((l) => (l || "").trim())
    .filter(Boolean);

  const tierMap = policy.languageTierMap || {};
  const tiers = policy.tiers || {};

  const DEFAULT_KEY = "default";
  const baseTierKey = (tierMap as any)[DEFAULT_KEY] ? (tierMap as any)[DEFAULT_KEY] : DEFAULT_KEY;
  const defaultMult =
    (tiers as any)[baseTierKey] ?? (tiers as any)[DEFAULT_KEY] ?? 1;

  // Pick the **max** multiplier across languages to stay conservative
  let maxMult = defaultMult;
  for (const lang of uniq) {
    const key = (tierMap as any)[lang] ?? DEFAULT_KEY;
    const mult = (tiers as any)[key] ?? (tiers as any)[DEFAULT_KEY] ?? 1;
    if (mult > maxMult) maxMult = mult;
  }

  // Extra language percentage uplift beyond the first language
  const extraCount = Math.max(uniq.length - 1, 0);
  const extraPct = policy.extraLanguagePct ?? 0; // % per extra language
  const extraFactor = extraCount > 0 ? 1 + (extraPct * extraCount) / 100 : 1;

  return maxMult * extraFactor;
}

/**
 * Rush markup calculator.
 * Inputs:
 * - policy.rush[tier] may define:
 *   - enabled: boolean
 *   - percent: number (e.g., 20 for +20%)
 *   - docTypeOverrides: Record<docType, percent>
 *   - countryOverrides: Record<countryCodeOrName, percent>
 *   - minSubtotal: number (ensure at least this subtotal before applying percent)
 *
 * Returns subtotal (laborRounded + fees, then rush applied if enabled) and the
 * applied rush info or null when not applied.
 */
export type RushTier = "rush_1bd" | "same_day";

export type RushApplied =
  | { tier: RushTier; percent: number }
  | null;

export function rushMarkup(args: {
  policy: CompletePricingPolicy;
  tier: RushTier | null | undefined;
  laborRounded: number;
  certFee: number;
  shipFee: number;
  docType?: string | null;
  countryOfIssue?: string | null;
}): { subtotal: number; applied: RushApplied } {
  const {
    policy,
    tier,
    laborRounded,
    certFee,
    shipFee,
    docType,
    countryOfIssue,
  } = args;

  const baseSubtotal = (laborRounded || 0) + (certFee || 0) + (shipFee || 0);

  if (!tier) {
    return { subtotal: baseSubtotal, applied: null };
  }

  const rushCfg = (policy as any).rush?.[tier];
  if (!rushCfg || !rushCfg.enabled) {
    return { subtotal: baseSubtotal, applied: null };
  }

  // Determine percent with precedence: docType override -> country override -> default percent
  const docPct =
    docType && rushCfg.docTypeOverrides
      ? rushCfg.docTypeOverrides[docType]
      : undefined;

  const cntryKey = (countryOfIssue || "").trim();
  const countryPct =
    cntryKey && rushCfg.countryOverrides
      ? rushCfg.countryOverrides[cntryKey]
      : undefined;

  const percent =
    (isFinite(docPct as number) ? (docPct as number) :
     isFinite(countryPct as number) ? (countryPct as number) :
     (rushCfg.percent ?? 0)) || 0;

  // Optional floor before applying rush percent
  const preSubtotal =
    typeof rushCfg.minSubtotal === "number" && rushCfg.minSubtotal > baseSubtotal
      ? rushCfg.minSubtotal
      : baseSubtotal;

  const subtotal = Math.round(preSubtotal * (1 + percent / 100) * 100) / 100;

  const applied: RushApplied = { tier, percent };
  return { subtotal, applied };
}