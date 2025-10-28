-- Complete migration for purchases table
-- Adds all missing columns needed for refund tracking

-- Add refund_tx_hash if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'purchases' AND column_name = 'refund_tx_hash'
    ) THEN
        ALTER TABLE purchases ADD COLUMN refund_tx_hash TEXT;
    END IF;
END $$;

-- Add payment_tx_hash if it doesn't exist (already applied but safe)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'purchases' AND column_name = 'payment_tx_hash'
    ) THEN
        ALTER TABLE purchases ADD COLUMN payment_tx_hash TEXT;
    END IF;
END $$;

-- Add payment_block_number if it doesn't exist (already applied but safe)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'purchases' AND column_name = 'payment_block_number'
    ) THEN
        ALTER TABLE purchases ADD COLUMN payment_block_number BIGINT;
    END IF;
END $$;

-- Create indexes if they don't exist
CREATE INDEX IF NOT EXISTS idx_purchases_payment_tx_hash ON purchases(payment_tx_hash);
CREATE INDEX IF NOT EXISTS idx_purchases_payment_block_number ON purchases(payment_block_number);
CREATE INDEX IF NOT EXISTS idx_purchases_refund_tx_hash ON purchases(refund_tx_hash);

-- Add comments
COMMENT ON COLUMN purchases.payment_tx_hash IS 'Transaction hash where USDC ERC-3009 AuthorizationUsed event occurred';
COMMENT ON COLUMN purchases.payment_block_number IS 'Block number where USDC payment was confirmed on-chain';
COMMENT ON COLUMN purchases.refund_tx_hash IS 'Transaction hash of the refund transaction';
