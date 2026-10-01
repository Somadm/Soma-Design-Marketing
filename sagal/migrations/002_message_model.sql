-- Which Claude model wrote each of Sagal's replies, and why (shown under the reply).
ALTER TABLE sagal.messages ADD COLUMN IF NOT EXISTS model TEXT;
ALTER TABLE sagal.messages ADD COLUMN IF NOT EXISTS model_reason TEXT;
