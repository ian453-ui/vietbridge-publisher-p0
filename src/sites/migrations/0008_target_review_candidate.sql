-- Candidate only: apply through the official deployment migration workflow.
-- Target decisions remain in the existing account-bound approval event ledger.
CREATE TABLE sites_review_derivations (
 review_id TEXT PRIMARY KEY REFERENCES sites_reviews(id),
 lineage_json TEXT NOT NULL
);
CREATE TABLE sites_review_derivation_commands (
 command_id TEXT PRIMARY KEY,
 command_hash TEXT NOT NULL,
 review_id TEXT NOT NULL REFERENCES sites_review_derivations(review_id)
);
CREATE TRIGGER sites_review_derivations_no_update BEFORE UPDATE ON sites_review_derivations BEGIN SELECT RAISE(ABORT,'IMMUTABLE_REVIEW_LINEAGE'); END;
CREATE TRIGGER sites_review_derivations_no_delete BEFORE DELETE ON sites_review_derivations BEGIN SELECT RAISE(ABORT,'IMMUTABLE_REVIEW_LINEAGE'); END;
CREATE TRIGGER sites_review_derivation_commands_no_update BEFORE UPDATE ON sites_review_derivation_commands BEGIN SELECT RAISE(ABORT,'IMMUTABLE_REVIEW_COMMAND'); END;
CREATE TRIGGER sites_review_derivation_commands_no_delete BEFORE DELETE ON sites_review_derivation_commands BEGIN SELECT RAISE(ABORT,'IMMUTABLE_REVIEW_COMMAND'); END;
