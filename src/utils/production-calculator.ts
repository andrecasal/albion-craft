// Production Bonus and Resource Return Rate Calculator
// Based on Albion Online Wiki formulas

/**
 * Calculate Resource Return Rate (RRR) from Production Bonus
 * Formula: RRR = 1 - 1/(1 + (ProductionBonus/100))
 *
 * @param productionBonus - Total production bonus percentage (e.g., 18, 77, 92)
 * @returns Resource return rate as decimal (e.g., 0.1525 for 15.25%)
 *
 * @example
 * // Royal city base (18% production bonus)
 * calculateRRR(18) // returns 0.152542 (15.25% RRR)
 *
 * @example
 * // Royal city with focus (18% + 59%)
 * calculateRRR(77) // returns 0.434782 (43.48% RRR)
 */
export function calculateRRR(productionBonus: number): number {
  return 1 - 1 / (1 + productionBonus / 100);
}

/**
 * Calculate effective material cost after resource returns
 *
 * @param rawCost - Raw material cost before returns
 * @param rrr - Resource return rate as decimal (0-1)
 * @returns Effective cost after accounting for returned materials
 *
 * @example
 * // If materials cost 10,000 silver and you get 15.25% back
 * calculateEffectiveCost(10000, 0.1525) // returns 8475
 */
export function calculateEffectiveCost(rawCost: number, rrr: number): number {
  return rawCost * (1 - rrr);
}

/**
 * Calculate total production bonus from various sources
 *
 * @param params - Object containing bonus sources
 * @returns Total production bonus percentage
 *
 * @example
 * // Royal city with specialization and focus
 * calculateTotalProductionBonus({
 *   baseBonus: 18,
 *   cityBonus: 15,
 *   useFocus: true,
 *   focusBonus: 59
 * }) // returns 92
 */
export function calculateTotalProductionBonus(params: {
  baseBonus: number;
  cityBonus?: number;
  useFocus?: boolean;
  focusBonus?: number;
}): number {
  const {
    baseBonus,
    cityBonus = 0,
    useFocus = false,
    focusBonus = 59,
  } = params;

  const focus = useFocus ? focusBonus : 0;
  return baseBonus + cityBonus + focus;
}

/**
 * Helper to generate common RRR values
 * Run: npm run calc:rrr
 */
export function generateCommonRRRValues() {
  const scenarios = [
    { name: 'Base (no focus)', bonus: 18 },
    { name: 'Base + Focus', bonus: 77 },
    { name: 'Base + Crafting Spec (15%)', bonus: 33 },
    { name: 'Base + Crafting Spec + Focus', bonus: 92 },
    { name: 'Base + Refining Spec (40%)', bonus: 58 },
    { name: 'Base + Refining Spec + Focus', bonus: 117 },
  ];

  console.log('\n=== Resource Return Rates (RRR) ===\n');
  scenarios.forEach(({ name, bonus }) => {
    const rrr = calculateRRR(bonus);
    console.log(`${name}:`);
    console.log(`  Production Bonus: ${bonus}%`);
    console.log(`  RRR: ${(rrr * 100).toFixed(2)}%`);
    console.log(`  Effective Cost: ${((1 - rrr) * 100).toFixed(2)}% of materials\n`);
  });
}

// Run this to generate values for game-constants.json
if (require.main === module) {
  generateCommonRRRValues();
}
