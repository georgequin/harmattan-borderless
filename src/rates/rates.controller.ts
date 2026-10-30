import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SUPPORTED_CURRENCIES } from '../common/currency';
import { applyRate, formatAmount, formatRate, parseAmount } from '../common/money';
import { QuoteQueryDto, QuoteResponseDto, RatesResponseDto } from './rates.dto';
import { quoteFromTable, RatesService } from './rates.service';

@ApiTags('rates')
@Controller('rates')
export class RatesController {
  constructor(private readonly rates: RatesService) {}

  @Get()
  @ApiOperation({ summary: 'Current conversion rates between all supported stablecoins' })
  @ApiOkResponse({ type: RatesResponseDto })
  async list(): Promise<RatesResponseDto> {
    const table = await this.rates.getRateTable();
    const rates = SUPPORTED_CURRENCIES.flatMap((from) =>
      SUPPORTED_CURRENCIES.filter((to) => to !== from).map((to) => {
        const quote = quoteFromTable(table, from, to);
        return {
          from,
          to,
          rate: formatRate(quote.rate),
          lastRefreshedAt: quote.asOf.toISOString(),
        };
      }),
    );
    return { source: table.source, currencies: [...SUPPORTED_CURRENCIES], rates };
  }

  @Get('quote')
  @ApiOperation({ summary: 'Quote a single pair, optionally converting an amount (read-only)' })
  @ApiOkResponse({ type: QuoteResponseDto })
  async quote(@Query() query: QuoteQueryDto): Promise<QuoteResponseDto> {
    const quote = await this.rates.quote(query.from, query.to);
    const response: QuoteResponseDto = {
      from: quote.from,
      to: quote.to,
      rate: formatRate(quote.rate),
      source: quote.source,
      lastRefreshedAt: quote.asOf.toISOString(),
    };
    if (query.amount !== undefined) {
      const amount = parseAmount(query.amount);
      response.amount = formatAmount(amount);
      response.convertedAmount = formatAmount(applyRate(amount, quote.rate));
    }
    return response;
  }
}
