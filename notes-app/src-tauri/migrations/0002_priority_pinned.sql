-- Task priority (notes stay NULL) and pinning for both kinds.
ALTER TABLE items ADD COLUMN priority TEXT CHECK (priority IN ('low', 'normal', 'high'));
ALTER TABLE items ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;

-- Existing tasks pick up the default priority.
UPDATE items SET priority = 'normal' WHERE kind = 'task';

-- List order is pinned-first, then recency.
CREATE INDEX idx_items_list ON items (archived, pinned DESC, updated_at DESC);
