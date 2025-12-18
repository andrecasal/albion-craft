// Report Generation Service

import * as fs from 'fs';
import * as path from 'path';
import { ProfitabilityResult, OpportunityReport, City } from '../types';

export class ReportGenerator {
  private outputDir: string;

  constructor(outputDir: string = './reports') {
    this.outputDir = outputDir;

    // Create output directory if it doesn't exist
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
  }

  /**
   * Generate CSV report from profitability results
   */
  generateCSV(results: ProfitabilityResult[], filename: string): string {
    const headers = [
      'Item_ID',
      'City',
      'Net_Profit',
      'ROI_%',
      'Profit_Rank',
      'Daily_Demand',
      'Supply_Signal',
      'Sell_Price',
      'Material_Cost',
      'Effective_Cost',
      'Crafting_Fee',
      'Total_Cost',
      'Gross_Revenue',
      'Return_Rate_%',
      'Material_1',
      'Mat_1_Qty',
      'Material_2',
      'Mat_2_Qty',
      'Material_3',
      'Mat_3_Qty',
      'Material_4',
      'Mat_4_Qty',
    ];

    const rows = results.map((r) => [
      r.itemId,
      r.city,
      r.netProfit.toFixed(0),
      r.roiPercent.toFixed(2),
      r.profitRank.toFixed(0),
      r.marketData.dailyDemand.toFixed(0),
      r.marketData.supplySignal,
      r.marketData.lowestSellPrice.toFixed(0),
      r.craftingCost.totalMaterialCost.toFixed(0),
      r.craftingCost.effectiveCost.toFixed(0),
      r.craftingCost.craftingFee.toFixed(0),
      r.craftingCost.totalCost.toFixed(0),
      r.grossRevenue.toFixed(0),
      (r.returnRate * 100).toFixed(2),
      r.recipe.material1 || '',
      r.recipe.mat1Qty || 0,
      r.recipe.material2 || '',
      r.recipe.mat2Qty || 0,
      r.recipe.material3 || '',
      r.recipe.mat3Qty || 0,
      r.recipe.material4 || '',
      r.recipe.mat4Qty || 0,
    ]);

    const csv = [headers.join(','), ...rows.map((row) => row.join(','))].join('\n');

    const filepath = path.join(this.outputDir, filename);
    fs.writeFileSync(filepath, csv);

    return filepath;
  }

  /**
   * Generate JSON report from profitability results
   */
  generateJSON(results: ProfitabilityResult[], filename: string): string {
    const filepath = path.join(this.outputDir, filename);
    fs.writeFileSync(filepath, JSON.stringify(results, null, 2));
    return filepath;
  }

  /**
   * Generate opportunity report by city
   */
  generateOpportunityReport(
    results: ProfitabilityResult[],
    city: City
  ): OpportunityReport {
    const cityResults = results.filter((r) => r.city === city);

    const avgROI =
      cityResults.reduce((sum, r) => sum + r.roiPercent, 0) / cityResults.length || 0;

    const topResult = cityResults.reduce((top, r) =>
      r.profitRank > (top?.profitRank || 0) ? r : top
    , cityResults[0]);

    return {
      city,
      opportunities: cityResults,
      totalOpportunities: cityResults.length,
      avgROI,
      topItem: topResult?.itemId || 'N/A',
      generatedAt: new Date(),
    };
  }

  /**
   * Generate separate reports for each city
   */
  generateCityReports(results: ProfitabilityResult[]): void {
    const cities: City[] = [
      'Caerleon',
      'Bridgewatch',
      'Fort Sterling',
      'Lymhurst',
      'Martlock',
      'Thetford',
      'Brecilien',
    ];

    cities.forEach((city) => {
      const cityResults = results.filter((r) => r.city === city);

      if (cityResults.length === 0) {
        console.log(`  ⚠️  No opportunities found for ${city}`);
        return;
      }

      // Sort by profit rank
      cityResults.sort((a, b) => b.profitRank - a.profitRank);

      const csvPath = this.generateCSV(
        cityResults,
        `${city.toLowerCase().replace(' ', '-')}-opportunities.csv`
      );

      console.log(
        `  ✓ ${city}: ${cityResults.length} opportunities → ${path.basename(csvPath)}`
      );
    });
  }

  /**
   * Generate summary report with top opportunities across all cities
   */
  generateSummaryReport(results: ProfitabilityResult[], topN: number = 100): void {
    // Top by profit rank
    const topByRank = [...results]
      .sort((a, b) => b.profitRank - a.profitRank)
      .slice(0, topN);

    const rankPath = this.generateCSV(topByRank, 'top-opportunities-by-rank.csv');
    console.log(`  ✓ Top ${topN} by profit rank → ${path.basename(rankPath)}`);

    // Top by ROI
    const topByROI = [...results]
      .sort((a, b) => b.roiPercent - a.roiPercent)
      .slice(0, topN);

    const roiPath = this.generateCSV(topByROI, 'top-opportunities-by-roi.csv');
    console.log(`  ✓ Top ${topN} by ROI → ${path.basename(roiPath)}`);

    // All opportunities
    const allPath = this.generateCSV(
      results.sort((a, b) => b.profitRank - a.profitRank),
      'all-opportunities.csv'
    );
    console.log(`  ✓ All opportunities (${results.length}) → ${path.basename(allPath)}`);
  }

  /**
   * Print summary statistics to console
   */
  printSummary(results: ProfitabilityResult[]): void {
    const totalOpportunities = results.length;
    const avgProfit = results.reduce((sum, r) => sum + r.netProfit, 0) / totalOpportunities;
    const avgROI = results.reduce((sum, r) => sum + r.roiPercent, 0) / totalOpportunities;

    const topResult = results.reduce((top, r) =>
      r.profitRank > (top?.profitRank || 0) ? r : top
    , results[0]);

    console.log('\n========================================');
    console.log('PROFITABILITY ANALYSIS SUMMARY');
    console.log('========================================');
    console.log(`Total opportunities: ${totalOpportunities}`);
    console.log(`Average profit: ${avgProfit.toFixed(0)} silver`);
    console.log(`Average ROI: ${avgROI.toFixed(2)}%`);
    console.log(`\nTop opportunity: ${topResult?.itemId} in ${topResult?.city}`);
    console.log(`  Profit: ${topResult?.netProfit.toFixed(0)} silver`);
    console.log(`  ROI: ${topResult?.roiPercent.toFixed(2)}%`);
    console.log(`  Profit Rank: ${topResult?.profitRank.toFixed(0)}`);
    console.log('');
  }
}
