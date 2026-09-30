// Single source of truth for the brand's display name and known spelling
// variants. Used by the brand-keyword-group seeding (merge duplicate
// trackers) and by the relevance check's cheap string-containment
// pre-filter (skip asking the AI about relevance when one of these is
// literally present in the text).
export const BRAND_GROUP_NAME = "EB1A Experts";

export const BRAND_NAME_VARIANTS = [
  "EB1A Experts",
  "EB-1A Experts",
  "eb1aexperts.com",
  "eb1aexperts",
];
