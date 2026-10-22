-- Unapplied candidate. Text edits preserve source identity and immutable media
-- lineage, never manufacture a new inspection receipt or inherit an approval.
CREATE TABLE sites_content_edits (
 content_id TEXT PRIMARY KEY REFERENCES sites_contents(id),
 parent_content_id TEXT NOT NULL REFERENCES sites_contents(id),
 platform TEXT NOT NULL,
 source_plan_id TEXT REFERENCES sites_upload_plans(id),
 source_json TEXT NOT NULL
);
CREATE TABLE sites_review_edit_invalidations (
 review_id TEXT PRIMARY KEY REFERENCES sites_reviews(id),
 content_id TEXT NOT NULL REFERENCES sites_content_edits(content_id),
 platform TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE TRIGGER sites_content_edits_no_update BEFORE UPDATE ON sites_content_edits BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CONTENT_EDIT'); END;
CREATE TRIGGER sites_content_edits_no_delete BEFORE DELETE ON sites_content_edits BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CONTENT_EDIT'); END;
CREATE TRIGGER sites_review_edit_invalidations_no_update BEFORE UPDATE ON sites_review_edit_invalidations BEGIN SELECT RAISE(ABORT,'IMMUTABLE_REVIEW_EDIT_INVALIDATION'); END;
CREATE TRIGGER sites_review_edit_invalidations_no_delete BEFORE DELETE ON sites_review_edit_invalidations BEGIN SELECT RAISE(ABORT,'IMMUTABLE_REVIEW_EDIT_INVALIDATION'); END;
