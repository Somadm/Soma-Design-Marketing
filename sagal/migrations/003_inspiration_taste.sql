-- Inspiration becomes Sabah's taste board: links (Pinterest, Instagram, any page), how much
-- she likes each one and why. Sagal reads it every turn to learn her style.
ALTER TABLE sagal.inspiration
  ADD COLUMN url           TEXT,
  ADD COLUMN reaction      TEXT NOT NULL DEFAULT 'like' CHECK (reaction IN ('love', 'like', 'not_for_us')),
  ADD COLUMN why           TEXT NOT NULL DEFAULT '',
  ADD COLUMN site          TEXT NOT NULL DEFAULT '',
  ADD COLUMN preview_text  TEXT NOT NULL DEFAULT '',
  ADD COLUMN updated_at    TIMESTAMPTZ NOT NULL DEFAULT now();
