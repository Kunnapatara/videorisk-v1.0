import { ScanMode } from '../../types';

export interface ICreditService {
  calculateRequiredCredits(durationSeconds: number, scanMode: ScanMode): number;
  formatMinutes(durationSeconds: number): number;
}

class CreditService implements ICreditService {
  /**
   * Calculates required credits based strictly on input duration in minutes.
   * Standard: 1 credit / input minute
   * Deep: 2 credits / input minute
   * Minimum 1 minute (rounded up to nearest whole minute)
   */
  public calculateRequiredCredits(durationSeconds: number, scanMode: ScanMode): number {
    const minutes = Math.max(1, Math.ceil(durationSeconds / 60));
    const ratePerMinute = scanMode === 'deep' ? 2 : 1;
    return minutes * ratePerMinute;
  }

  public formatMinutes(durationSeconds: number): number {
    return Math.max(1, Math.ceil(durationSeconds / 60));
  }
}

export const creditService = new CreditService();
