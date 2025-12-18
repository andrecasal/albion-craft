// User Settings Service
// Manages user preferences and configuration

import * as fs from 'fs';
import * as path from 'path';

export interface UserSettings {
  // Market analysis preferences
  targetDaysOfSupply: number;        // 3, 5, 7 days
  marketAnalysisPreset: 'conservative' | 'balanced' | 'aggressive';
  minDailyDemand: number;
  minConfidence: number;
  excludeFallingSupply: boolean;

  // Crafting preferences
  premiumStatus: boolean;            // Affects sales tax (4% vs 8%)
  useFocus: boolean;                 // Use focus for crafting

  // Specialization levels (0-100)
  craftingSpecialization: number;    // For crafted items
  refiningSpecialization: number;    // For refined materials

  // Display preferences
  maxResultsPerCity: number;
  sortBy: 'profit' | 'roi' | 'demand';
}

const DEFAULT_SETTINGS: UserSettings = {
  targetDaysOfSupply: 5,
  marketAnalysisPreset: 'balanced',
  minDailyDemand: 5,
  minConfidence: 60,
  excludeFallingSupply: true,
  premiumStatus: false,
  useFocus: false,
  craftingSpecialization: 0,
  refiningSpecialization: 0,
  maxResultsPerCity: 50,
  sortBy: 'profit'
};

export class UserSettingsManager {
  private settings: UserSettings;
  private settingsPath: string;

  constructor(dataDir: string = process.cwd()) {
    this.settingsPath = path.join(dataDir, 'user-settings.json');
    this.settings = this.loadSettings();
  }

  /**
   * Get current user settings
   */
  getSettings(): UserSettings {
    return { ...this.settings };
  }

  /**
   * Update user settings
   */
  updateSettings(updates: Partial<UserSettings>): void {
    this.settings = { ...this.settings, ...updates };
    this.saveSettings();
  }

  /**
   * Reset to default settings
   */
  resetToDefaults(): void {
    this.settings = { ...DEFAULT_SETTINGS };
    this.saveSettings();
  }

  /**
   * Get a specific setting value
   */
  get<K extends keyof UserSettings>(key: K): UserSettings[K] {
    return this.settings[key];
  }

  /**
   * Set a specific setting value
   */
  set<K extends keyof UserSettings>(key: K, value: UserSettings[K]): void {
    this.settings[key] = value;
    this.saveSettings();
  }

  /**
   * Load settings from file
   */
  private loadSettings(): UserSettings {
    try {
      if (fs.existsSync(this.settingsPath)) {
        const data = JSON.parse(fs.readFileSync(this.settingsPath, 'utf8'));
        // Merge with defaults to handle new settings
        return { ...DEFAULT_SETTINGS, ...data };
      }
    } catch (e) {
      console.warn('Could not load user settings, using defaults');
    }

    return { ...DEFAULT_SETTINGS };
  }

  /**
   * Save settings to file
   */
  private saveSettings(): void {
    try {
      fs.writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2));
    } catch (e) {
      console.error('Failed to save user settings:', e);
    }
  }

  /**
   * Display current settings in a readable format
   */
  displaySettings(): string {
    const s = this.settings;
    return `
╔═══════════════════════════════════════════════════════════════╗
║                      USER SETTINGS                            ║
╠═══════════════════════════════════════════════════════════════╣
║                                                               ║
║  MARKET ANALYSIS                                              ║
║  ├─ Target Days of Supply: ${s.targetDaysOfSupply} days                           ║
║  ├─ Analysis Preset: ${s.marketAnalysisPreset.padEnd(20)}                 ║
║  ├─ Min Daily Demand: ${s.minDailyDemand} items                            ║
║  ├─ Min Confidence: ${s.minConfidence}%                                  ║
║  └─ Exclude Falling Supply: ${s.excludeFallingSupply ? 'Yes' : 'No '}                        ║
║                                                               ║
║  CRAFTING                                                     ║
║  ├─ Premium Status: ${s.premiumStatus ? 'Active' : 'Inactive'}                            ║
║  │   (Sales tax: ${s.premiumStatus ? '4%' : '8%'})                                   ║
║  ├─ Use Focus: ${s.useFocus ? 'Yes' : 'No '}                                      ║
║  ├─ Crafting Specialization: ${s.craftingSpecialization}%                       ║
║  └─ Refining Specialization: ${s.refiningSpecialization}%                       ║
║                                                               ║
║  DISPLAY                                                      ║
║  ├─ Max Results per City: ${s.maxResultsPerCity}                            ║
║  └─ Sort By: ${s.sortBy.padEnd(20)}                                ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
    `.trim();
  }

  /**
   * Get production bonus percentage for crafting
   */
  getCraftingProductionBonus(): number {
    // Base bonus is always 18%
    // Crafting specialization adds up to 15% (linearly)
    // Focus adds 59% if enabled
    const baseBonus = 18;
    const specBonus = (this.settings.craftingSpecialization / 100) * 15;
    const focusBonus = this.settings.useFocus ? 59 : 0;

    return baseBonus + specBonus + focusBonus;
  }

  /**
   * Get production bonus percentage for refining
   */
  getRefiningProductionBonus(): number {
    // Base bonus is always 18%
    // Refining specialization adds up to 40% (linearly)
    // Focus adds 59% if enabled
    const baseBonus = 18;
    const specBonus = (this.settings.refiningSpecialization / 100) * 40;
    const focusBonus = this.settings.useFocus ? 59 : 0;

    return baseBonus + specBonus + focusBonus;
  }

  /**
   * Get sales tax rate based on premium status
   */
  getSalesTaxRate(): number {
    return this.settings.premiumStatus ? 4.0 : 8.0;
  }
}

/**
 * Create a preset configuration for quick setup
 */
export function createPresetSettings(
  preset: 'beginner' | 'intermediate' | 'advanced'
): Partial<UserSettings> {
  const presets = {
    beginner: {
      targetDaysOfSupply: 3,
      marketAnalysisPreset: 'conservative' as const,
      minDailyDemand: 10,
      minConfidence: 80,
      excludeFallingSupply: true,
      premiumStatus: false,
      useFocus: false,
      craftingSpecialization: 0,
      refiningSpecialization: 0,
      maxResultsPerCity: 20,
      sortBy: 'profit' as const
    },
    intermediate: {
      targetDaysOfSupply: 5,
      marketAnalysisPreset: 'balanced' as const,
      minDailyDemand: 5,
      minConfidence: 60,
      excludeFallingSupply: true,
      premiumStatus: true,
      useFocus: true,
      craftingSpecialization: 50,
      refiningSpecialization: 50,
      maxResultsPerCity: 50,
      sortBy: 'roi' as const
    },
    advanced: {
      targetDaysOfSupply: 7,
      marketAnalysisPreset: 'aggressive' as const,
      minDailyDemand: 2,
      minConfidence: 40,
      excludeFallingSupply: false,
      premiumStatus: true,
      useFocus: true,
      craftingSpecialization: 100,
      refiningSpecialization: 100,
      maxResultsPerCity: 100,
      sortBy: 'demand' as const
    }
  };

  return presets[preset];
}
