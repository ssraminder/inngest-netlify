// lib/calc.ts
import type { PricingPolicy } from "./policy";

interface DocTypeEntry {
  doc_type: string;
  countryOfIssue?: string;
  country_of_issue?: string;
  preset_base?: number;
}

export function quarterPage(raw: number, tol=0.20) {
  const base = Math.max(0, raw);
  const frac = base - Math.trunc(base);
  const nearest = Math.round(base / 0.25) * 0.25;
  const ceilNext = Math.ceil(base / 0.25) * 0.25;
  return frac <= tol ? (nearest || 0.25) : (ceilNext || 0.25);
}

export function ceilTo5(x:number) {
  return Math.ceil(x/5)*5;
}

export function pickTierMultiplier(policy: PricingPolicy, declaredLangs: string[], detectedLangs: string[]): number {
  const all = new Set<string>([...declaredLangs, ...detectedLangs]);
  const arr = Array.from(all);
  const tiers = arr.map(l => policy.languageTierMap[l] || "default");
  const maxTier = tiers.reduce((acc, t) => {
    const order = { default:0, D:1, C:2, A:3, B:4 }; // B considered “harder” than A here; adjust if needed
    return order[t] > order[acc] ? t : acc;
  }, "default" as keyof typeof policy.tiers);
  const mult = policy.tiers[maxTier];

  // extra languages beyond first
  const extraCount = Math.max(0, arr.length - 1);
  const extraMult = (1 + policy.extraLanguagePct) ** extraCount;

  return mult * extraMult;
}

export function rushMarkup({
  policy, tier, laborRounded, certFee, shipFee,
  docType, countryOfIssue
}: {
  policy: PricingPolicy;
  tier: "rush_1bd"|"same_day"|null|undefined;
  laborRounded: number;
  certFee: number;
  shipFee: number;
  docType?: string|null;
  countryOfIssue?: string|null;
}) {
  if (!tier) return { subtotal: laborRounded + certFee + shipFee, applied: null };

  const cfg = policy.rush[tier];
  if (!cfg?.enabled) return { subtotal: laborRounded + certFee + shipFee, applied: null };

  const subtotalBase = laborRounded + certFee + shipFee;
  const calculatedBase = cfg.apply_to === "labor" ? laborRounded : subtotalBase;

  let base = calculatedBase;
  if (cfg.basis === "preset" && tier === "same_day") {
    // eligibility check: doc type + country + (max_pages is enforced upstream)
    const entry = policy.rush.same_day.eligibility.find(e => e.doc_type === docType && e.country_of_issue === countryOfIssue) as DocTypeEntry | undefined;
    
    if (entry?.preset_base != null) {
      base = entry.preset_base;
    }
  }

  const subtotal = Math.round(base * (1 + cfg.percent) * 100) / 100;
  return { subtotal, applied: tier };
}
