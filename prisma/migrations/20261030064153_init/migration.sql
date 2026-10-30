-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('cNGN', 'cGHS', 'cXAF', 'USDx', 'EURx');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('DEPOSIT', 'SWAP', 'TRANSFER');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('COMPLETED');

-- CreateEnum
CREATE TYPE "RateSource" AS ENUM ('LIVE', 'CACHED', 'FALLBACK', 'IDENTITY');

-- CreateTable
CREATE TABLE "wallets" (
    "id" UUID NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "balances" (
    "wallet_id" UUID NOT NULL,
    "currency" "Currency" NOT NULL,
    "amount" DECIMAL(38,0) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "balances_pkey" PRIMARY KEY ("wallet_id","currency")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" UUID NOT NULL,
    "type" "TransactionType" NOT NULL,
    "status" "TransactionStatus" NOT NULL DEFAULT 'COMPLETED',
    "source_wallet_id" UUID,
    "destination_wallet_id" UUID NOT NULL,
    "source_currency" "Currency" NOT NULL,
    "source_amount" DECIMAL(38,0) NOT NULL,
    "destination_currency" "Currency" NOT NULL,
    "destination_amount" DECIMAL(38,0) NOT NULL,
    "rate" DECIMAL(30,12) NOT NULL,
    "rate_source" "RateSource" NOT NULL,
    "rate_as_of" TIMESTAMP(3) NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "currency" "Currency" NOT NULL,
    "amount" DECIMAL(38,0) NOT NULL,
    "balance_after" DECIMAL(38,0) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fx_rate_snapshots" (
    "currency" "Currency" NOT NULL,
    "rate_per_usd" DECIMAL(30,12) NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fx_rate_snapshots_pkey" PRIMARY KEY ("currency")
);

-- CreateIndex
CREATE UNIQUE INDEX "wallets_email_key" ON "wallets"("email");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_phone_key" ON "wallets"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_idempotency_key_key" ON "transactions"("idempotency_key");

-- CreateIndex
CREATE INDEX "transactions_source_wallet_id_created_at_idx" ON "transactions"("source_wallet_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "transactions_destination_wallet_id_created_at_idx" ON "transactions"("destination_wallet_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ledger_entries_wallet_id_currency_idx" ON "ledger_entries"("wallet_id", "currency");

-- CreateIndex
CREATE INDEX "ledger_entries_transaction_id_idx" ON "ledger_entries"("transaction_id");

-- AddForeignKey
ALTER TABLE "balances" ADD CONSTRAINT "balances_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_source_wallet_id_fkey" FOREIGN KEY ("source_wallet_id") REFERENCES "wallets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_destination_wallet_id_fkey" FOREIGN KEY ("destination_wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written invariants. The application already enforces these; the
-- database enforces them again so a bug can never persist bad money state.
-- ---------------------------------------------------------------------------

-- A wallet must be identified by an email or a phone number.
ALTER TABLE "wallets"
  ADD CONSTRAINT "wallets_identity_present" CHECK ("email" IS NOT NULL OR "phone" IS NOT NULL);

-- Balances can never go negative.
ALTER TABLE "balances"
  ADD CONSTRAINT "balances_amount_non_negative" CHECK ("amount" >= 0);

-- Money moved by a transaction is always strictly positive and the rate is sane.
ALTER TABLE "transactions"
  ADD CONSTRAINT "transactions_amounts_positive" CHECK ("source_amount" > 0 AND "destination_amount" > 0),
  ADD CONSTRAINT "transactions_rate_positive" CHECK ("rate" > 0),
  ADD CONSTRAINT "transactions_wallets_by_type" CHECK (
    ("type" = 'DEPOSIT'  AND "source_wallet_id" IS NULL) OR
    ("type" = 'SWAP'     AND "source_wallet_id" = "destination_wallet_id" AND "source_currency" <> "destination_currency") OR
    ("type" = 'TRANSFER' AND "source_wallet_id" IS NOT NULL AND "source_wallet_id" <> "destination_wallet_id")
  );

ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_entries_amount_non_zero" CHECK ("amount" <> 0),
  ADD CONSTRAINT "ledger_entries_balance_after_non_negative" CHECK ("balance_after" >= 0);

-- The ledger is append-only.
CREATE FUNCTION forbid_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();
