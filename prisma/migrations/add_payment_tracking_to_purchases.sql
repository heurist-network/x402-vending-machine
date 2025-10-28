-- Migration: Add payment tracking fields to purchases table
-- This helps track the full lifecycle: payment -> purchase -> refund

-- Add payment transaction hash (from USDC ERC-3009 AuthorizationUsed event)
ALTER TABLE purchases
ADD COLUMN payment_tx_hash TEXT;

-- Add payment block number (when the USDC payment was confirmed on-chain)
ALTER TABLE purchases
ADD COLUMN payment_block_number BIGINT;

-- Add index for efficient lookups by payment transaction
CREATE INDEX idx_purchases_payment_tx_hash ON purchases(payment_tx_hash);

-- Add index for block number range queries
CREATE INDEX idx_purchases_payment_block_number ON purchases(payment_block_number);

-- Add comment to document these fields
COMMENT ON COLUMN purchases.payment_tx_hash IS 'Transaction hash where USDC ERC-3009 AuthorizationUsed event occurred';
COMMENT ON COLUMN purchases.payment_block_number IS 'Block number where USDC payment was confirmed on-chain';
