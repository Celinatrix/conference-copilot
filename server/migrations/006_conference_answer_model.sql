-- Per-conference choice of the model that drafts suggested answers. NULL = the server default (ANSWER_FAST_MODEL).
-- Additive: a nullable column; existing conferences keep the default.
ALTER TABLE conferences ADD COLUMN answer_model text;
