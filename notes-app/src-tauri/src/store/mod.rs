//! On-disk canonical store for Stage 2 (plan.6 steps 16–18): one
//! Markdown-with-frontmatter file per item is the git-mergeable source of truth,
//! and the per-project SQLite DB is demoted to a rebuildable, git-ignored index.
//! `itemfile` owns the canonical serialize/parse/scan; `db::sqlite` mirrors each
//! write into a file and rebuilds the index from files on load.

pub mod itemfile;
