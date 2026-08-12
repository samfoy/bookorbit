import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { PhysicalLoanService } from './physical-loan.service';

@Injectable()
export class PhysicalDueSoonJob {
  private readonly logger = new Logger(PhysicalDueSoonJob.name);

  constructor(private readonly loanService: PhysicalLoanService) {}

  /**
   * Hourly rather than daily: readers span timezones, and a milestone is only reached once the
   * reader's own day rolls over. The sweep is idempotent per (book, milestone), so the extra runs
   * find nothing to do.
   */
  @Cron('35 * * * *')
  async runHourlySweep() {
    try {
      await this.loanService.runDueSoonSweep();
    } catch (error) {
      // Already logged with full context by the service; a throw here would crash the scheduler.
      this.logger.warn(`Due soon sweep failed: ${error instanceof Error ? error.name : 'unknown error'}`);
    }
  }
}
