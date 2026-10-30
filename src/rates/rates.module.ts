import { Module } from '@nestjs/common';
import { OpenErApiRateProvider, RATE_PROVIDER } from './rate-provider';
import { RatesController } from './rates.controller';
import { RatesService } from './rates.service';

@Module({
  controllers: [RatesController],
  providers: [RatesService, { provide: RATE_PROVIDER, useClass: OpenErApiRateProvider }],
  exports: [RatesService],
})
export class RatesModule {}
