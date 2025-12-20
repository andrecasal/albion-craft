// material-buy-opportunities.ts
// Analyzes material prices vs 30-day average to identify buying opportunities
// Focused on finding materials priced below their historical average
// Uses pre-fetched data from option 1 (Refresh market data)

import * as fs from 'fs';
import * as path from 'path';
import { City } from '../types';

// ============================================================================
// CONFIGURATION
// ============================================================================


// ============================================================================
// TYPES
// ============================================================================

export type PriceSignal = '🟢 BUY' | '🟡 FAIR' | '🔴 HIGH';

// Categories for display (excluding craftable items and quest items)
export type MaterialCategory = 'raw' | 'refined' | 'artifact' | 'alchemy';

export interface MaterialPriceAnalysis {
  materialId: string;
  materialName: string;
  category: MaterialCategory;
  bestCity: City;
  currentPrice: number;
  price30dAvg: number;
  pctFromAvg: number;
  signal: PriceSignal;
  dataAgeHours: number;
  allCityPrices: Map<City, { price: number; avg: number; pct: number }>;
}

// Raw data structure from saved JSON
interface SavedMaterialAnalysis {
  materialId: string;
  materialName: string;
  category: string;
  bestCity: City;
  currentPrice: number;
  price30dAvg: number;
  pctFromAvg: number;
  signal: PriceSignal;
  dataAgeHours: number;
  allCityPrices: Record<string, { price: number; avg: number; pct: number }>;
}

// ============================================================================
// MATERIAL CATEGORIZATION
// ============================================================================

/**
 * Check if a material is a raw resource (ore, wood, rock, hide, fiber)
 * Includes enchanted versions (_LEVEL1@1, _LEVEL2@2, _LEVEL3@3)
 */
function isRawMaterial(id: string): boolean {
  const baseId = id.replace(/_LEVEL[1-3]@[1-3]$/, '');
  return /^T\d_ORE$/.test(baseId) ||
    /^T\d_WOOD$/.test(baseId) ||
    /^T\d_ROCK$/.test(baseId) ||
    /^T\d_HIDE$/.test(baseId) ||
    /^T\d_FIBER$/.test(baseId);
}

/**
 * Check if a material is a refined resource (cloth, leather, metalbar, planks, stoneblock)
 * Includes enchanted versions (@1, @2, @3, @4)
 */
function isRefinedMaterial(id: string): boolean {
  const baseId = id.replace(/@[1-4]$/, '');
  return /_CLOTH$/.test(baseId) ||
    /_LEATHER$/.test(baseId) ||
    /_METALBAR$/.test(baseId) ||
    /_PLANKS$/.test(baseId) ||
    /_STONEBLOCK$/.test(baseId) ||
    /^T\d_CLOTH$/.test(baseId) ||
    /^T\d_LEATHER$/.test(baseId) ||
    /^T\d_METALBAR$/.test(baseId) ||
    /^T\d_PLANKS$/.test(baseId) ||
    /^T\d_STONEBLOCK$/.test(baseId);
}

/**
 * Categorize a material ID into its type
 * Returns null for materials that should be excluded (craftable items, quest items)
 */
function categorizeMaterial(id: string): MaterialCategory | null {
  if (isRawMaterial(id)) return 'raw';
  if (isRefinedMaterial(id)) return 'refined';
  if (id.includes('ARTEFACT_')) return 'artifact';
  if (id.includes('ALCHEMY_RARE_')) return 'alchemy';
  // Exclude craftable items (armor, shoes, heads) and quest items
  return null;
}

/**
 * Get a human-readable category name
 */
function getCategoryDisplayName(category: MaterialCategory): string {
  switch (category) {
    case 'raw': return 'RAW MATERIALS';
    case 'refined': return 'REFINED MATERIALS';
    case 'artifact': return 'ARTIFACTS';
    case 'alchemy': return 'ALCHEMY DROPS';
  }
}

function formatPrice(price: number): string {
  if (price >= 1000000) {
    return (price / 1000000).toFixed(1) + 'M';
  }
  if (price >= 1000) {
    return (price / 1000).toFixed(1) + 'K';
  }
  return price.toString();
}

function formatPct(pct: number): string {
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

// ============================================================================
// MAIN FUNCTION
// ============================================================================

export async function trackMaterialPrices(): Promise<MaterialPriceAnalysis[]> {
  console.log(`\n📊 Material Buy Opportunities`);
  console.log(`   Analyzing materials for buy opportunities (prices below 30-day average)\n`);

  // Load pre-fetched data
  const dataPath = path.join(process.cwd(), 'src', 'db', 'material-price-analysis.json');

  if (!fs.existsSync(dataPath)) {
    console.log('   ❌ No material price data found.');
    console.log('   Please run "Refresh market data" (option 1) first.\n');
    return [];
  }

  const savedData: SavedMaterialAnalysis[] = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

  // Filter to only include relevant categories and convert to proper structure
  const analyses: MaterialPriceAnalysis[] = [];

  for (const saved of savedData) {
    const category = categorizeMaterial(saved.materialId);
    if (category === null) continue; // Skip craftable items and quest items

    analyses.push({
      materialId: saved.materialId,
      materialName: saved.materialName,
      category,
      bestCity: saved.bestCity,
      currentPrice: saved.currentPrice,
      price30dAvg: saved.price30dAvg,
      pctFromAvg: saved.pctFromAvg,
      signal: saved.signal,
      dataAgeHours: saved.dataAgeHours,
      allCityPrices: new Map(Object.entries(saved.allCityPrices) as [City, { price: number; avg: number; pct: number }][]),
    });
  }

  if (analyses.length === 0) {
    console.log('   ❌ No material data available after filtering.');
    console.log('   Please run "Refresh market data" (option 1) first.\n');
    return [];
  }

  // Check data freshness
  const statsPath = path.join(process.cwd(), 'src', 'db', 'material-price-analysis.json');
  const stats = fs.statSync(statsPath);
  const ageHours = Math.round((Date.now() - stats.mtimeMs) / (1000 * 60 * 60));

  if (ageHours > 6) {
    console.log(`   ⚠️  Data is ${ageHours} hours old. Consider refreshing.\n`);
  } else {
    console.log(`   ✓ Data is ${ageHours} hours old.\n`);
  }

  // Display results by category
  displayCategorizedTables(analyses);

  return analyses;
}

function displayTable(analyses: MaterialPriceAnalysis[], title: string): void {
  if (analyses.length === 0) {
    return;
  }

  const buySignals = analyses.filter((a) => a.signal === '🟢 BUY').length;
  const fairSignals = analyses.filter((a) => a.signal === '🟡 FAIR').length;
  const highSignals = analyses.filter((a) => a.signal === '🔴 HIGH').length;

  console.log(`\n=== ${title} (${analyses.length} items) ===`);
  console.log(`    ${buySignals} 🟢 BUY | ${fairSignals} 🟡 FAIR | ${highSignals} 🔴 HIGH\n`);

  console.log('┌─────────────────────────────────┬──────────────┬───────────┬───────────────┬──────────┐');
  console.log('│ Material                        │ Best City    │ Price     │ vs 30d Avg    │ Signal   │');
  console.log('├─────────────────────────────────┼──────────────┼───────────┼───────────────┼──────────┤');

  // Sort by best opportunities first (lowest pctFromAvg = furthest below average)
  const sorted = [...analyses].sort((a, b) => a.pctFromAvg - b.pctFromAvg);

  for (const analysis of sorted) {
    const name = analysis.materialName.substring(0, 31).padEnd(31);
    const city = analysis.bestCity.substring(0, 12).padEnd(12);
    const price = formatPrice(analysis.currentPrice).padStart(9);
    const pct = formatPct(analysis.pctFromAvg).padStart(13);
    const signal = analysis.signal.padEnd(8);

    console.log(`│ ${name} │ ${city} │ ${price} │ ${pct} │ ${signal} │`);
  }

  console.log('└─────────────────────────────────┴──────────────┴───────────┴───────────────┴──────────┘');
}

function displayCategorizedTables(analyses: MaterialPriceAnalysis[]): void {
  // Define the order of categories to display
  const categoryOrder: MaterialCategory[] = ['raw', 'refined', 'artifact', 'alchemy'];

  // Group analyses by category
  const byCategory = new Map<MaterialCategory, MaterialPriceAnalysis[]>();
  for (const category of categoryOrder) {
    byCategory.set(category, []);
  }

  for (const analysis of analyses) {
    const list = byCategory.get(analysis.category);
    if (list) {
      list.push(analysis);
    }
  }

  // Display each category
  for (const category of categoryOrder) {
    const categoryAnalyses = byCategory.get(category) || [];
    if (categoryAnalyses.length > 0) {
      displayTable(categoryAnalyses, getCategoryDisplayName(category));
    }
  }

  // Overall summary
  const totalBuy = analyses.filter((a) => a.signal === '🟢 BUY').length;
  const totalFair = analyses.filter((a) => a.signal === '🟡 FAIR').length;
  const totalHigh = analyses.filter((a) => a.signal === '🔴 HIGH').length;

  console.log('\n════════════════════════════════════════════════════════════════════════════════════════');
  console.log(`OVERALL SUMMARY: ${analyses.length} materials analyzed`);
  console.log(`    ${totalBuy} 🟢 BUY opportunities | ${totalFair} 🟡 FAIR | ${totalHigh} 🔴 HIGH`);
  console.log('════════════════════════════════════════════════════════════════════════════════════════\n');
}
