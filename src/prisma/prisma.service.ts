import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

/** Prisma connects lazily on first query, so building the app needs no database. */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

export type PrismaTx = Prisma.TransactionClient;

export function isUniqueViolation(error: unknown, field?: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  if (!field) return true;
  const target = (error.meta?.target ?? []) as string[] | string;
  return Array.isArray(target) ? target.includes(field) : target.includes(field);
}
