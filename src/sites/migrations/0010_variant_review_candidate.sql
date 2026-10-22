-- Candidate only. An edited version gets its own inspection and empty decisions.
CREATE TABLE sites_variant_reviews (
 review_id TEXT PRIMARY KEY REFERENCES sites_reviews(id),
 content_id TEXT NOT NULL UNIQUE REFERENCES sites_content_edits(content_id),
 lineage_json TEXT NOT NULL
);
CREATE TABLE sites_variant_review_commands (
 command_id TEXT PRIMARY KEY,
 command_hash TEXT NOT NULL,
 review_id TEXT NOT NULL REFERENCES sites_variant_reviews(review_id)
);
CREATE TRIGGER sites_variant_reviews_no_update BEFORE UPDATE ON sites_variant_reviews BEGIN SELECT RAISE(ABORT,'IMMUTABLE_VARIANT_REVIEW'); END;
CREATE TRIGGER sites_variant_reviews_no_delete BEFORE DELETE ON sites_variant_reviews BEGIN SELECT RAISE(ABORT,'IMMUTABLE_VARIANT_REVIEW'); END;
CREATE TRIGGER sites_variant_review_commands_no_update BEFORE UPDATE ON sites_variant_review_commands BEGIN SELECT RAISE(ABORT,'IMMUTABLE_VARIANT_REVIEW_COMMAND'); END;
CREATE TRIGGER sites_variant_review_commands_no_delete BEFORE DELETE ON sites_variant_review_commands BEGIN SELECT RAISE(ABORT,'IMMUTABLE_VARIANT_REVIEW_COMMAND'); END;
