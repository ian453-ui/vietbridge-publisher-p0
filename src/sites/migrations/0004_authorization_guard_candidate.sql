-- Unapplied candidate; no grants or member changes. Used only inside write batches.
CREATE TABLE sites_authorization_assertions(
 authorized INTEGER NOT NULL CONSTRAINT SITES_AUTHORIZATION_CHANGED CHECK(authorized=1)
);
