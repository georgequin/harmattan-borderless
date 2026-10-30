import { Module } from '@nestjs/common';
import { RatesModule } from '../rates/rates.module';
import { WalletsModule } from '../wallets/wallets.module';
import { TransactionsController, WalletTransactionsController } from './transactions.controller';
import { TransactionsService } from './transactions.service';

@Module({
  imports: [RatesModule, WalletsModule],
  controllers: [WalletTransactionsController, TransactionsController],
  providers: [TransactionsService],
})
export class TransactionsModule {}
