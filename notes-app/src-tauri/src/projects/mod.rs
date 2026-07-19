//! Project management: the registry above the `ItemRepository` trait (Section 5).
//! `ProjectManager` owns the set of loaded per-project stores, routes item
//! writes to the right store, and fans reads (list / search / tags) out across
//! loaded stores, k-way-merging the results so a merged list equals what a
//! single DB would produce. A small `Catalog` (`catalog.db`) records every known
//! project and hosts the relocated app settings.

pub mod catalog;
pub mod legacy;
pub mod paths;

use std::cmp::Ordering;
use std::collections::{BTreeSet, HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

use crate::db::{ItemRepository, PromptRepository, SqliteRepository};
use crate::error::{AppError, Result};
use crate::models::{
    Item, Kind, ListFilter, NewItem, NewPrompt, Priority, ProjectInfo, Prompt, PromptListFilter,
    PromptVersion, Sort, Status, UpdateItem, UpdatePrompt,
};
use crate::store::itemfile;

use catalog::Catalog;
use paths::validate_project_dir;

/// The rebuildable SQLite index inside a project directory (Stage 2). The
/// canonical store is `items/*.md` beside it; this DB is git-ignored and rebuilt
/// from the files on every load, so it may be deleted at will.
const INDEX_DB_FILE: &str = "index.db";

/// The Stage-1 store filename. A directory carrying this and no `items/` is a
/// pre-Stage-2 store: on first load its rows are exported to `items/*.md`, a
/// fresh `index.db` is built and count-verified, and this file is preserved as a
/// `.bak` (never deleted) — the same count-verified discipline as the one-time
/// `notes.db` migration.
const LEGACY_DB_FILE: &str = "project.db";

/// The canonical item-file subdirectory. Its PRESENCE marks a project as
/// Stage-2-native (files are the source of truth); its ABSENCE is what triggers
/// the one-time export from the DB — so a store that has index rows but no files
/// is never "rebuilt" from an empty directory (which would erase it).
const ITEMS_DIR: &str = "items";

/// The canonical prompt-file subtree (plan.7), a sibling of `items/`. Unlike
/// `items/` it is NOT pre-created — the first prompt write makes it, and a scan
/// of a missing `prompts/` is empty. It is git-tracked (canonical), never listed
/// in `GITIGNORE`.
const PROMPTS_DIR: &str = "prompts";

/// The retired Stage-1 store, kept after an upgrade. Ignored by git, never
/// deleted by the upgrade (only by an explicit Delete-files).
const STAGE1_BACKUP: &str = "project.db.pre-stage2.bak";

/// The git-tracked project identity file (Stage 2). The `index.db` is
/// git-ignored, so a clone would carry NO identity if it lived only in the DB
/// meta — every clone would then mint a fresh UUID and, cloned twice on one
/// machine, collide item ids. This tiny committed file carries `{id, name}` so a
/// clone keeps the project's identity and the copy/duplicate guards still work.
/// NOT listed in `GITIGNORE` — it is meant to travel with the items.
const IDENTITY_FILE: &str = "project.json";

/// Staging directory for the one-time Stage-1→Stage-2 conversion. Files are
/// written here and the whole dir is renamed to `items/` in one atomic step, so
/// `items/` appears ONLY when the export is complete and verified — an
/// interrupted conversion leaves `items/` absent and the source DB untouched,
/// and the next load retries cleanly. Ignored by git.
const ITEMS_STAGING: &str = "items.tmp";

/// `.gitignore` written into a project dir: the `items/*.md` files and the
/// `project.json` identity are the canonical, git-tracked store; the rebuildable
/// SQLite index and its WAL sidecars (both the Stage-2 `index.db` and any Stage-1
/// `project.db` still in transition), the conversion staging dir, and the upgrade
/// backup are machine-local. Never clobbers a user's own `.gitignore`.
const GITIGNORE: &str = "# worknotes keeps the rebuildable SQLite index and its WAL sidecars machine-local;\n# the items/*.md files (and project.json) are the canonical, git-tracked store.\nindex.db\nindex.db-wal\nindex.db-shm\nitems.tmp/\nproject.db\nproject.db-wal\nproject.db-shm\nproject.db.pre-stage2.bak\n";

/// The exact Stage-1 `.gitignore` output, so an upgrade recognizes its own prior
/// file and rewrites it (and `delete_files` removes it) without ever touching a
/// `.gitignore` the user hand-wrote.
const LEGACY_GITIGNORE: &str = "# worknotes keeps the SQLite store and its WAL sidecars machine-local.\nproject.db\nproject.db-wal\nproject.db-shm\n";

/// A currently-loaded project: its catalog name and the open store. Keyed in the
/// manager by the project's UUID. The directory path is the catalog's authority,
/// not duplicated here.
///
/// `repo` and `prompts` are two trait views of the SAME `SqliteRepository`
/// instance (one pool, one `close()`): items go through `ItemRepository`, prompts
/// through `PromptRepository`. Closing either view closes the shared pool.
struct LoadedProject {
    name: String,
    repo: Arc<dyn ItemRepository>,
    prompts: Arc<dyn PromptRepository>,
}

pub struct ProjectManager {
    catalog: Catalog,
    /// UUID → loaded store. `std::sync::RwLock`: the guard is only ever held for
    /// synchronous map work (clone the `Arc`s out, then drop it) — never across
    /// an `.await` — so the async command futures stay `Send` without pulling in
    /// an async lock.
    loaded: RwLock<HashMap<String, LoadedProject>>,
    /// Non-fatal per-project failures gathered during `startup_load`, surfaced to
    /// the frontend so a moved/corrupt/newer project explains itself.
    startup_warnings: Mutex<Vec<String>>,
    /// Passed to `validate_project_dir` (kept out of `paths.rs` so that stays a
    /// pure function). Also anchors the default projects dir.
    app_data_dir: PathBuf,
}

impl ProjectManager {
    pub fn new(catalog: Catalog, app_data_dir: PathBuf) -> Self {
        Self {
            catalog,
            loaded: RwLock::new(HashMap::new()),
            startup_warnings: Mutex::new(Vec::new()),
            app_data_dir,
        }
    }

    // --- Startup ----------------------------------------------------------

    /// The single startup entry point: run the one-time legacy migration (a
    /// failure is a non-fatal warning, never an abort), then load every project
    /// the catalog marks loaded. Runs once from `lib.rs` setup.
    pub async fn run_startup(&self, legacy_db: &Path) {
        if let Err(e) = legacy::migrate_if_needed(&self.catalog, &self.app_data_dir, legacy_db).await {
            self.warn(format!("Couldn't migrate your existing notes: {e}"));
        }
        self.startup_load().await;
    }

    /// Attempt to load every project the catalog marks loaded. Each failure is a
    /// non-fatal per-project warning (moved file, newer version, corrupt) — never
    /// a startup abort.
    pub async fn startup_load(&self) {
        let rows = match self.catalog.list().await {
            Ok(rows) => rows,
            Err(e) => {
                self.warn(format!("Couldn't read the project catalog: {e}"));
                return;
            }
        };
        for row in rows {
            if !row.loaded {
                continue;
            }
            match self.load_from_catalog(&row.id).await {
                Ok((_info, warnings)) => {
                    for w in warnings {
                        self.warn(format!("\"{}\": {}", row.name, w));
                    }
                }
                Err(e) => self.warn(format!("Couldn't load \"{}\": {}", row.name, e)),
            }
        }
    }

    fn warn(&self, message: String) {
        self.startup_warnings.lock().unwrap().push(message);
    }

    /// Warnings gathered at startup (for a one-time frontend notice).
    pub fn startup_warnings(&self) -> Vec<String> {
        self.startup_warnings.lock().unwrap().clone()
    }

    // --- Lifecycle --------------------------------------------------------

    /// Create a new project at a user-chosen directory: validate the path, create
    /// the store (refusing to adopt an existing file), write a `.gitignore`, and
    /// record it in the catalog. Loaded on success.
    pub async fn create_project(&self, dir: &str, name: &str) -> Result<ProjectInfo> {
        let name = name.trim();
        if name.is_empty() {
            return Err(AppError::Invalid("project name must not be empty".into()));
        }
        let canonical = validate_project_dir(dir, &self.app_data_dir)?;
        if store_exists_in(&canonical) {
            return Err(AppError::Invalid("a project already exists in that folder".into()));
        }
        let index_path = canonical.join(INDEX_DB_FILE);
        let items_dir = canonical.join(ITEMS_DIR);
        let prompts_dir = canonical.join(PROMPTS_DIR);
        let project_id = uuid::Uuid::new_v4().to_string();
        let path_str = path_to_string(&canonical);

        // Create the empty index and the canonical items/ dir; the store is
        // file-backed from its first write. items/ starts empty, so no rebuild.
        // prompts/ is created lazily on the first prompt write.
        let repo = SqliteRepository::create_at(&index_path, &project_id, name).await?;
        if std::fs::create_dir_all(&items_dir).is_err() {
            repo.close().await;
            let _ = remove_store_files(&canonical);
            return Err(AppError::Invalid("couldn't prepare the project folder".into()));
        }
        let repo = repo.with_items_dir(items_dir).with_prompts_dir(prompts_dir);

        // Write the git-portable identity so a clone keeps this project's id, and
        // a `.gitignore` — never clobbering a user's own existing one.
        ensure_identity_file(&canonical, &project_id, name);
        let gitignore = canonical.join(".gitignore");
        if !gitignore.exists() {
            let _ = std::fs::write(&gitignore, GITIGNORE);
        }

        // The store exists now; a catalog name/path clash means rolling the files back.
        if let Err(e) = self.catalog.insert(&project_id, name, &path_str).await {
            repo.close().await;
            let _ = remove_store_files(&canonical);
            return Err(e);
        }

        self.loaded
            .write()
            .unwrap()
            .insert(project_id.clone(), loaded_project(name.to_string(), repo));
        self.project_info(&project_id).await
    }

    /// Open an existing project from a user-chosen directory. Validates the path,
    /// hardens and opens the store, reads its UUID from `meta`, and reconciles the
    /// catalog: a new UUID is recorded; a moved file updates the stored path; a
    /// COPY (same UUID, original still on disk) or an already-loaded project is
    /// refused.
    pub async fn open_project(&self, dir: &str) -> Result<ProjectInfo> {
        let canonical = validate_project_dir(dir, &self.app_data_dir)?;
        if !store_exists_in(&canonical) {
            return Err(AppError::Invalid("no project found in that folder".into()));
        }
        let path_str = path_to_string(&canonical);

        // If a DB is already present, read its identity WITHOUT mutating the
        // folder, so an already-loaded project or a copy is refused BEFORE the
        // one-time Stage-2 conversion (`open_store`) would touch anything. A
        // clone that brought only `items/*.md` (no DB) has no prior identity —
        // its `index.db` is minted fresh below and can never be a known copy.
        if let Some(pid) = peek_uuid(&canonical).await? {
            if self.is_loaded(&pid) {
                return Err(AppError::Invalid("that project is already loaded".into()));
            }
            if let Some(existing) = self.catalog.get(&pid).await? {
                if existing.path != path_str && store_exists_in(Path::new(&existing.path)) {
                    return Err(AppError::Invalid(
                        "a copy of this project is already known at another folder".into(),
                    ));
                }
            }
        }

        let name_hint = folder_name(&canonical);
        let (repo, pid, pname, _warnings) = open_store(&canonical, None, &name_hint).await?;

        // Identity is authoritative now; reconcile the catalog.
        if self.is_loaded(&pid) {
            repo.close().await;
            return Err(AppError::Invalid("that project is already loaded".into()));
        }
        match self.catalog.get(&pid).await? {
            None => {
                if let Err(e) = self.catalog.insert(&pid, &pname, &path_str).await {
                    repo.close().await;
                    return Err(e);
                }
            }
            Some(existing) if existing.path == path_str => { /* same folder, reload */ }
            Some(existing) => {
                // Same UUID at a different path: a copy if the original still
                // exists, otherwise a move. (The peek above already caught the
                // common copy case without mutating this folder; this is the
                // authoritative post-open check.)
                if store_exists_in(Path::new(&existing.path)) {
                    repo.close().await;
                    return Err(AppError::Invalid(
                        "a copy of this project is already known at another folder".into(),
                    ));
                }
                self.catalog.set_path(&pid, &path_str).await?;
            }
        }

        self.catalog.set_loaded(&pid, true).await?;
        self.loaded
            .write()
            .unwrap()
            .insert(pid.clone(), loaded_project(pname, repo));
        self.project_info(&pid).await
    }

    /// Load a KNOWN (catalog) project by id — used at startup and by the UI's
    /// load toggle. Idempotent: loading an already-loaded project is a no-op.
    pub async fn load(&self, id: &str) -> Result<ProjectInfo> {
        if self.is_loaded(id) {
            return self.project_info(id).await;
        }
        let (info, _warnings) = self.load_from_catalog(id).await?;
        Ok(info)
    }

    /// Open a known project's store from its catalog directory, converting a
    /// Stage-1 store to Stage-2 layout on first sight and rebuilding the index
    /// from the canonical files. Returns per-file import warnings (conflict
    /// markers, malformed files) alongside the info. Does NOT short-circuit on
    /// already-loaded — callers that need that (`load`) check first; `reload`
    /// and `startup_load` want the fresh open.
    async fn load_from_catalog(&self, id: &str) -> Result<(ProjectInfo, Vec<String>)> {
        let row = self.catalog.get(id).await?.ok_or(AppError::NotFound)?;
        let dir = Path::new(&row.path);
        if !store_exists_in(dir) {
            return Err(AppError::Invalid(format!(
                "the files for \"{}\" are missing — open it from its current folder",
                row.name
            )));
        }
        let (repo, pid, pname, warnings) = open_store(dir, Some(&row.id), &row.name).await?;
        if pid != row.id {
            repo.close().await;
            return Err(AppError::Invalid(
                "the project at that folder no longer matches the catalog".into(),
            ));
        }
        self.catalog.set_loaded(id, true).await?;
        self.loaded
            .write()
            .unwrap()
            .insert(id.to_string(), loaded_project(pname, repo));
        let info = self.project_info(id).await?;
        Ok((info, warnings))
    }

    /// Reload a project from its on-disk files (Stage 2, post-`git pull`
    /// staleness): drop and close the current store, then rebuild the index from
    /// `items/*.md`. Returns the per-file import warnings so the UI can report
    /// which files were skipped (e.g. unresolved conflict markers). Loading a
    /// not-currently-loaded project is allowed (it just loads fresh).
    pub async fn reload(&self, id: &str) -> Result<Vec<String>> {
        // Drop the lock guard (an owned Option falls out of the statement) BEFORE
        // awaiting the close — the loaded map is only ever touched synchronously.
        let removed = self.loaded.write().unwrap().remove(id);
        if let Some(lp) = removed {
            lp.repo.close().await;
        }
        let (_info, warnings) = self.load_from_catalog(id).await?;
        Ok(warnings)
    }

    /// Unload a loaded project: drop it from the routing map, close the pool
    /// (releasing the Windows file lock and WAL sidecars), and flip the catalog
    /// flag. Unloading a project that isn't loaded is a clean `NotFound`.
    pub async fn unload(&self, id: &str) -> Result<()> {
        let removed = self.loaded.write().unwrap().remove(id);
        match removed {
            Some(lp) => {
                lp.repo.close().await;
                self.catalog.set_loaded(id, false).await?;
                Ok(())
            }
            None => Err(AppError::NotFound),
        }
    }

    /// Remove a project from the catalog; leave its files untouched. Must be
    /// unloaded first.
    pub async fn forget(&self, id: &str) -> Result<()> {
        if self.is_loaded(id) {
            return Err(AppError::Invalid("unload the project before forgetting it".into()));
        }
        if self.catalog.get(id).await?.is_none() {
            return Err(AppError::NotFound);
        }
        self.catalog.remove(id).await
    }

    /// Destructive: delete the project's store files (DB + WAL sidecars + the
    /// generated `.gitignore`) then its catalog row. Must be unloaded first
    /// (the pool is closed, so the file is unlocked on Windows).
    pub async fn delete_files(&self, id: &str) -> Result<()> {
        if self.is_loaded(id) {
            return Err(AppError::Invalid("unload the project before deleting its files".into()));
        }
        let row = self.catalog.get(id).await?.ok_or(AppError::NotFound)?;
        remove_store_files(Path::new(&row.path))?;
        self.catalog.remove(id).await
    }

    // --- Item routing -----------------------------------------------------

    /// Create an item into the project named by `input.project_id` (the routing
    /// key). Rejects an empty target or one that is not loaded. Stamps the owning
    /// UUID onto the returned item.
    pub async fn create(&self, input: NewItem) -> Result<Item> {
        let target = input.project_id.trim().to_string();
        if target.is_empty() {
            return Err(AppError::Invalid("choose a project for this item".into()));
        }
        let repo = self
            .repo_for(&target)
            .map_err(|_| AppError::Invalid("that project isn't loaded".into()))?;
        let mut item = repo.create(input).await?;
        item.project_id = Some(target);
        Ok(item)
    }

    /// Fetch an item by id from whichever loaded store owns it; stamp its project.
    pub async fn get(&self, id: &str) -> Result<Item> {
        let (pid, repo) = self.owner(id).await?;
        let mut item = repo.get(id).await?;
        item.project_id = Some(pid);
        Ok(item)
    }

    pub async fn update(&self, id: &str, patch: UpdateItem) -> Result<Item> {
        let (pid, repo) = self.owner(id).await?;
        let mut item = repo.update(id, patch).await?;
        item.project_id = Some(pid);
        Ok(item)
    }

    pub async fn delete(&self, id: &str) -> Result<()> {
        let (_pid, repo) = self.owner(id).await?;
        repo.delete(id).await
    }

    // --- Prompt routing (plan.7) ------------------------------------------
    // Prompts are viewed ONE project at a time (no cross-store fan-out), so
    // `list_prompts` requires a `projectId`. `get`/`update`/`delete`/`versions`
    // locate the owning store by id (mirroring `owner()` for items) and stamp the
    // owning project on the returned prompt.

    /// Create a prompt into the project named by `input.project_id` (the routing
    /// key). Rejects an empty or not-loaded target. Stamps the owning UUID.
    pub async fn create_prompt(&self, input: NewPrompt) -> Result<Prompt> {
        let target = input.project_id.trim().to_string();
        if target.is_empty() {
            return Err(AppError::Invalid("choose a project for this prompt".into()));
        }
        let repo = self
            .prompts_for(&target)
            .map_err(|_| AppError::Invalid("that project isn't loaded".into()))?;
        let mut prompt = repo.create(input).await?;
        prompt.project_id = Some(target);
        Ok(prompt)
    }

    /// List prompts in ONE project (required `projectId`), stamping ownership.
    pub async fn list_prompts(&self, filter: &PromptListFilter) -> Result<Vec<Prompt>> {
        let target = filter
            .project_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| AppError::Invalid("choose a project to see its prompts".into()))?;
        let repo = self
            .prompts_for(target)
            .map_err(|_| AppError::Invalid("that project isn't loaded".into()))?;
        let mut prompts = repo.list(filter).await?;
        for p in &mut prompts {
            p.project_id = Some(target.to_string());
        }
        Ok(prompts)
    }

    pub async fn get_prompt(&self, id: &str) -> Result<Prompt> {
        let (pid, repo) = self.prompt_owner(id).await?;
        let mut prompt = repo.get(id).await?;
        prompt.project_id = Some(pid);
        Ok(prompt)
    }

    pub async fn update_prompt(&self, id: &str, patch: UpdatePrompt) -> Result<Prompt> {
        let (pid, repo) = self.prompt_owner(id).await?;
        let mut prompt = repo.update(id, patch).await?;
        prompt.project_id = Some(pid);
        Ok(prompt)
    }

    pub async fn prompt_versions(&self, prompt_id: &str) -> Result<Vec<PromptVersion>> {
        let (_pid, repo) = self.prompt_owner(prompt_id).await?;
        repo.versions(prompt_id).await
    }

    pub async fn delete_prompt(&self, id: &str) -> Result<()> {
        let (_pid, repo) = self.prompt_owner(id).await?;
        repo.delete(id).await
    }

    // --- Fan-out reads ----------------------------------------------------

    /// Merged list across the selected stores (a single project when
    /// `filter.project_id` is set, else all loaded). Each store is already
    /// ordered by `push_sort`; `k_way_merge` reproduces that exact order across
    /// stores so the result equals a single-DB query.
    pub async fn list_all(&self, filter: &ListFilter) -> Result<Vec<Item>> {
        let sort = filter.sort.unwrap_or(Sort::Updated);
        let targets = self.targets(filter.project_id.as_deref());
        let mut lists: Vec<VecDeque<Item>> = Vec::with_capacity(targets.len());
        for (pid, repo) in targets {
            let mut items = repo.list(filter).await?;
            for it in &mut items {
                it.project_id = Some(pid.clone());
            }
            lists.push(items.into());
        }
        Ok(k_way_merge(lists, sort))
    }

    /// Merged search: hits grouped by project (projects ordered by name), each
    /// group in its own FTS-rank order. bm25 `rank` is not comparable across
    /// corpora, so a single global ranking would be dishonest — the row project
    /// label is the grouping cue (a global-rank mode is deferred, Decision 6).
    pub async fn search_all(&self, query: &str, filter: &ListFilter) -> Result<Vec<Item>> {
        let targets = self.targets(filter.project_id.as_deref());
        let mut groups: Vec<(String, String, Vec<Item>)> = Vec::with_capacity(targets.len());
        for (pid, repo) in targets {
            let mut items = repo.search(query, filter).await?;
            for it in &mut items {
                it.project_id = Some(pid.clone());
            }
            let name = self.name_of(&pid);
            groups.push((name, pid, items));
        }
        groups.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
        Ok(groups.into_iter().flat_map(|(_, _, items)| items).collect())
    }

    /// The tag vocabulary union across loaded stores: sorted, de-duplicated. A
    /// tag survives while ANY loaded store still carries it on a live item.
    pub async fn active_tags_union(&self) -> Result<Vec<String>> {
        let mut set: BTreeSet<String> = BTreeSet::new();
        for (_pid, repo) in self.snapshot() {
            for tag in repo.list_active_tags().await? {
                set.insert(tag);
            }
        }
        Ok(set.into_iter().collect())
    }

    /// Every known project (catalog order = by name) with its loaded flag and,
    /// for loaded projects only, a live item count.
    pub async fn list_projects(&self) -> Result<Vec<ProjectInfo>> {
        let rows = self.catalog.list().await?;
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            let (loaded, item_count) = match self.repo_for(&row.id).ok() {
                Some(repo) => (true, Some(repo.count_active().await?)),
                None => (false, None),
            };
            out.push(ProjectInfo { id: row.id, name: row.name, path: row.path, loaded, item_count });
        }
        Ok(out)
    }

    // --- Catalog-hosted settings (Section 4.5: never from a project store) ---

    pub async fn get_setting(&self, key: &str) -> Result<Option<String>> {
        self.catalog.get_setting(key).await
    }

    pub async fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.catalog.set_setting(key, value).await
    }

    // --- Internals --------------------------------------------------------

    fn is_loaded(&self, id: &str) -> bool {
        self.loaded.read().unwrap().contains_key(id)
    }

    fn name_of(&self, id: &str) -> String {
        self.loaded
            .read()
            .unwrap()
            .get(id)
            .map(|lp| lp.name.clone())
            .unwrap_or_default()
    }

    fn repo_for(&self, id: &str) -> Result<Arc<dyn ItemRepository>> {
        self.loaded
            .read()
            .unwrap()
            .get(id)
            .map(|lp| lp.repo.clone())
            .ok_or(AppError::NotFound)
    }

    /// Snapshot every loaded (id, repo) so the lock is released before any
    /// `.await`. A store unloaded mid-operation surfaces a clean error from
    /// sqlx (never a panic).
    fn snapshot(&self) -> Vec<(String, Arc<dyn ItemRepository>)> {
        self.loaded
            .read()
            .unwrap()
            .iter()
            .map(|(pid, lp)| (pid.clone(), lp.repo.clone()))
            .collect()
    }

    /// The stores a read fans out to: one project when set (empty if it isn't
    /// loaded), else all loaded.
    fn targets(&self, project_id: Option<&str>) -> Vec<(String, Arc<dyn ItemRepository>)> {
        let loaded = self.loaded.read().unwrap();
        match project_id {
            Some(pid) => loaded
                .get(pid)
                .map(|lp| (pid.to_string(), lp.repo.clone()))
                .into_iter()
                .collect(),
            None => loaded.iter().map(|(pid, lp)| (pid.clone(), lp.repo.clone())).collect(),
        }
    }

    /// Locate the loaded store owning `id`. Probes EVERY loaded store (no
    /// early return) so an id present in two stores — reachable only via a
    /// crafted/duplicate untrusted DB, since real ids are UUIDs — is refused
    /// with a distinguishable error rather than silently routing a write to
    /// whichever store the map happened to enumerate first. `NotFound` if none.
    async fn owner(&self, id: &str) -> Result<(String, Arc<dyn ItemRepository>)> {
        let mut found: Option<(String, Arc<dyn ItemRepository>)> = None;
        for (pid, repo) in self.snapshot() {
            match repo.get(id).await {
                Ok(_) => {
                    if found.is_some() {
                        return Err(AppError::Invalid(
                            "that item exists in more than one loaded project".into(),
                        ));
                    }
                    found = Some((pid, repo));
                }
                Err(AppError::NotFound) => continue,
                Err(e) => return Err(e),
            }
        }
        found.ok_or(AppError::NotFound)
    }

    /// The prompt view of a loaded store (plan.7), or `NotFound`.
    fn prompts_for(&self, id: &str) -> Result<Arc<dyn PromptRepository>> {
        self.loaded
            .read()
            .unwrap()
            .get(id)
            .map(|lp| lp.prompts.clone())
            .ok_or(AppError::NotFound)
    }

    /// Snapshot every loaded (id, prompt repo) so the lock is released before any
    /// `.await` (mirrors `snapshot`).
    fn prompt_snapshot(&self) -> Vec<(String, Arc<dyn PromptRepository>)> {
        self.loaded
            .read()
            .unwrap()
            .iter()
            .map(|(pid, lp)| (pid.clone(), lp.prompts.clone()))
            .collect()
    }

    /// Locate the loaded store owning prompt `id`, probing EVERY loaded store so
    /// an id present in two stores is refused (mirrors `owner()` for items).
    async fn prompt_owner(&self, id: &str) -> Result<(String, Arc<dyn PromptRepository>)> {
        let mut found: Option<(String, Arc<dyn PromptRepository>)> = None;
        for (pid, repo) in self.prompt_snapshot() {
            match repo.get(id).await {
                Ok(_) => {
                    if found.is_some() {
                        return Err(AppError::Invalid(
                            "that prompt exists in more than one loaded project".into(),
                        ));
                    }
                    found = Some((pid, repo));
                }
                Err(AppError::NotFound) => continue,
                Err(e) => return Err(e),
            }
        }
        found.ok_or(AppError::NotFound)
    }

    async fn project_info(&self, id: &str) -> Result<ProjectInfo> {
        let row = self.catalog.get(id).await?.ok_or(AppError::NotFound)?;
        let (loaded, item_count) = match self.repo_for(id).ok() {
            Some(repo) => (true, Some(repo.count_active().await?)),
            None => (false, None),
        };
        Ok(ProjectInfo { id: row.id, name: row.name, path: row.path, loaded, item_count })
    }
}

fn path_to_string(p: &Path) -> String {
    p.to_string_lossy().to_string()
}

fn folder_name(dir: &Path) -> String {
    dir.file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("Project")
        .to_string()
}

/// True if `dir` already holds a worknotes store in ANY layout: the Stage-2
/// index, canonical item files, an identity file (an empty cloned project), or a
/// Stage-1 `project.db`. Used to refuse creating over an existing store and to
/// tell "files missing" from "empty".
fn store_exists_in(dir: &Path) -> bool {
    dir.join(INDEX_DB_FILE).exists()
        || dir.join(LEGACY_DB_FILE).exists()
        || dir.join(IDENTITY_FILE).exists()
        || items_dir_has_files(&dir.join(ITEMS_DIR))
}

fn items_dir_has_files(items_dir: &Path) -> bool {
    std::fs::read_dir(items_dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .any(|e| e.path().extension().and_then(|s| s.to_str()) == Some("md"))
        })
        .unwrap_or(false)
}

/// The git-portable project identity `{id, name}` written to `project.json`.
#[derive(serde::Serialize, serde::Deserialize)]
struct ProjectIdentity {
    id: String,
    name: String,
}

/// Read the committed identity file, if present and well-formed.
fn read_identity(dir: &Path) -> Option<(String, String)> {
    let text = std::fs::read_to_string(dir.join(IDENTITY_FILE)).ok()?;
    let id: ProjectIdentity = serde_json::from_str(&text).ok()?;
    if id.id.is_empty() {
        None
    } else {
        Some((id.id, id.name))
    }
}

/// Write the identity file only when absent — its content is stable in v1
/// (projects are not renamed), so this never rewrites a committed file and never
/// clobbers one carried in by a clone.
fn ensure_identity_file(dir: &Path, id: &str, name: &str) {
    let path = dir.join(IDENTITY_FILE);
    if path.exists() {
        return;
    }
    if let Ok(json) =
        serde_json::to_string_pretty(&ProjectIdentity { id: id.to_string(), name: name.to_string() })
    {
        let _ = std::fs::write(&path, json);
    }
}

/// Read a store's project UUID without mutating the folder. Prefers the
/// git-portable `project.json` (present in a clone, where `index.db` is not);
/// falls back to the DB meta for a store predating the identity file. `None`
/// when the directory carries no identity source at all (an identity-less folder
/// with only item files — adopted as a fresh project on load).
async fn peek_uuid(dir: &Path) -> Result<Option<String>> {
    if let Some((id, _)) = read_identity(dir) {
        return Ok(Some(id));
    }
    let index_path = dir.join(INDEX_DB_FILE);
    let legacy_path = dir.join(LEGACY_DB_FILE);
    let source = if index_path.exists() {
        index_path
    } else if legacy_path.exists() {
        legacy_path
    } else {
        return Ok(None);
    };
    let repo = SqliteRepository::open_existing(&source).await?;
    let (uuid, _name) = repo.read_meta().await?;
    repo.close().await;
    Ok(Some(uuid))
}

/// Open a project directory as a Stage-2, file-backed store and rebuild its
/// index from the canonical files. On first sight of a directory with no
/// `items/` yet, this converts it once (Stage-1 `project.db` → `items/*.md`,
/// count-verified, original kept as `.bak`). Returns the opened store with its
/// items dir attached, its stamped `(uuid, name)`, and per-file import warnings.
/// The minted index's identity is resolved as: the committed `project.json` →
/// the just-converted store's own identity → the known catalog UUID → a fresh
/// UUID; the resolved identity is then written to `project.json` so it travels
/// with a future clone.
async fn open_store(
    dir: &Path,
    catalog_uuid: Option<&str>,
    name_hint: &str,
) -> Result<(SqliteRepository, String, String, Vec<String>)> {
    let items_dir = dir.join(ITEMS_DIR);
    let prompts_dir = dir.join(PROMPTS_DIR);
    let index_path = dir.join(INDEX_DB_FILE);

    // No canonical files yet → derive them ONCE from the DB (never rebuild from
    // an empty dir, which would erase a store that has rows but no files). The
    // conversion returns the source's identity so a minted index keeps it.
    let migrated = if !items_dir.exists() {
        migrate_db_to_files(dir).await?
    } else {
        None
    };

    let repo = if index_path.exists() {
        SqliteRepository::open_existing(&index_path).await?
    } else {
        // No index (a clone that brought only files, or a just-converted Stage-1
        // store). Stamp a fresh index with the best available identity.
        let (uuid, name) = read_identity(dir)
            .or(migrated)
            .or_else(|| catalog_uuid.map(|u| (u.to_string(), name_hint.to_string())))
            .unwrap_or_else(|| (uuid::Uuid::new_v4().to_string(), name_hint.to_string()));
        SqliteRepository::create_at(&index_path, &uuid, &name).await?
    };
    let (uuid, name) = repo.read_meta().await?;
    // Publish the identity so a clone of this dir keeps it (write-if-absent).
    ensure_identity_file(dir, &uuid, &name);
    let repo = repo.with_items_dir(items_dir.clone()).with_prompts_dir(prompts_dir.clone());
    // Rebuild items AND prompts from their canonical files in one pass (plan.7
    // H3): a Reload after a `git pull` reflects both item and prompt files.
    let warnings = repo.rebuild_from_dir(&items_dir, &prompts_dir).await?;
    Ok((repo, uuid, name, warnings))
}

/// Wrap an opened store as a `LoadedProject`: two trait views (items + prompts)
/// over ONE `Arc<SqliteRepository>` — one pool, one `close()`. The
/// `Arc<SqliteRepository>` coerces to each trait object at the field assignment.
fn loaded_project(name: String, repo: SqliteRepository) -> LoadedProject {
    let repo = Arc::new(repo);
    LoadedProject { name, repo: repo.clone(), prompts: repo }
}

/// One-time conversion of a directory that has DB rows but no canonical files
/// yet — a Stage-1 `project.db`, or (only reachable via hand-built fixtures) an
/// `index.db` with no `items/`. Exports every row into a SIBLING staging dir,
/// verifies every file round-trips, and only then publishes `items/` via a
/// single atomic rename — so `items/` appears ONLY when the conversion is
/// complete. An interrupted conversion leaves `items/` absent and the source DB
/// untouched, so the next load retries cleanly (the load-bearing crash-safety
/// property: a partial export can never be mistaken for a finished Stage-2
/// store). For a Stage-1 store it then keeps `project.db` as a `.bak` and
/// refreshes the `.gitignore`; the caller builds the index from `items/`.
/// Returns the source's `(uuid, name)` so the caller stamps the new index with
/// the preserved identity. Idempotent: runs only while `items/` is absent.
async fn migrate_db_to_files(dir: &Path) -> Result<Option<(String, String)>> {
    let items_dir = dir.join(ITEMS_DIR);
    let index_path = dir.join(INDEX_DB_FILE);
    let legacy_path = dir.join(LEGACY_DB_FILE);
    let staging = dir.join(ITEMS_STAGING);

    // Prefer an existing index as the export source; fall back to Stage-1.
    let (source, from_legacy) = if index_path.exists() {
        (index_path.clone(), false)
    } else if legacy_path.exists() {
        (legacy_path.clone(), true)
    } else {
        // Nothing to export (an identity-only clone, or an empty dir): just make
        // the canonical dir so the caller mints a fresh, empty store.
        std::fs::create_dir_all(&items_dir).map_err(|_| convert_error())?;
        return Ok(None);
    };

    // Clear any staging left by a previously interrupted attempt.
    let _ = remove_dir_retrying(&staging);

    let src = SqliteRepository::open_existing(&source).await?;
    let items = src.all_items().await?;
    let (uuid, name) = src.read_meta().await?;
    src.close().await;

    // Stage the canonical files in a sibling dir — NEVER `items/` — so `items/`
    // is published only by the atomic rename below.
    std::fs::create_dir_all(&staging).map_err(|_| convert_error())?;
    for item in &items {
        if itemfile::write_item(&staging, item).is_err() {
            let _ = remove_dir_retrying(&staging);
            return Err(convert_error());
        }
    }
    // Verify every source item round-trips from its file (read+parse directly —
    // NOT `scan`, whose size cap is an untrusted-clone DoS guard, not a limit on
    // the user's own migrated notes).
    for item in &items {
        let ok = itemfile::file_name(&item.id)
            .ok()
            .and_then(|name| std::fs::read_to_string(staging.join(name)).ok())
            .map(|text| itemfile::parse(&text).is_ok())
            .unwrap_or(false);
        if !ok {
            let _ = remove_dir_retrying(&staging);
            return Err(convert_error());
        }
    }

    // ATOMIC PUBLISH: `items/` did not exist (open_store guarantees it), so the
    // rename exposes the complete, verified set in one step.
    if std::fs::rename(&staging, &items_dir).is_err() {
        let _ = remove_dir_retrying(&staging);
        return Err(convert_error());
    }

    // Retire a Stage-1 store now that the canonical files are published: keep the
    // original as a `.bak` (never deleted), drop stale sidecars, refresh the
    // `.gitignore`. The index is (re)built by the caller from `items/`.
    if from_legacy {
        let _ = std::fs::rename(&legacy_path, dir.join(STAGE1_BACKUP));
        for suffix in ["-wal", "-shm"] {
            let _ = remove_file_retrying(&dir.join(format!("{LEGACY_DB_FILE}{suffix}")));
        }
        refresh_gitignore(dir);
    }
    Ok(Some((uuid, name)))
}

/// Rewrite the generated `.gitignore` to the current content, but only when it
/// is absent or still exactly our prior Stage-1 output — never a user's custom
/// file.
fn refresh_gitignore(dir: &Path) {
    let path = dir.join(".gitignore");
    match std::fs::read_to_string(&path) {
        Ok(contents) if contents == LEGACY_GITIGNORE => {
            let _ = std::fs::write(&path, GITIGNORE);
        }
        Err(_) => {
            let _ = std::fs::write(&path, GITIGNORE);
        }
        _ => { /* user-custom, or already current: leave it */ }
    }
}

fn convert_error() -> AppError {
    AppError::Invalid(
        "couldn't convert this project to the new file format; your data was left untouched".into(),
    )
}

/// Delete a project store's files: the Stage-2 `index.db` and any Stage-1
/// `project.db` (each with `-wal`/`-shm` sidecars), the upgrade `.bak`, the
/// canonical `items/` directory, and the generated `.gitignore` (only when it
/// still matches our own output — either era — so a user's custom file is never
/// removed). A file still locked after the bounded retry surfaces cleanly.
fn remove_store_files(dir: &Path) -> Result<()> {
    let locked = || {
        AppError::Invalid("couldn't delete the project files — is the folder in use?".into())
    };
    for base in [INDEX_DB_FILE, LEGACY_DB_FILE] {
        for suffix in ["", "-wal", "-shm"] {
            remove_file_retrying(&dir.join(format!("{base}{suffix}"))).map_err(|_| locked())?;
        }
    }
    let _ = std::fs::remove_file(dir.join(STAGE1_BACKUP));
    let _ = std::fs::remove_file(dir.join(IDENTITY_FILE));
    let _ = remove_dir_retrying(&dir.join(ITEMS_STAGING));
    remove_dir_retrying(&dir.join(ITEMS_DIR)).map_err(|_| locked())?;
    // Sweep the canonical prompt subtree too (plan.7 H3), or destructive
    // "Delete files" would leave sensitive prompt bodies on disk (data remanence).
    remove_dir_retrying(&dir.join(PROMPTS_DIR)).map_err(|_| locked())?;
    let gitignore = dir.join(".gitignore");
    if let Ok(contents) = std::fs::read_to_string(&gitignore) {
        if contents == GITIGNORE || contents == LEGACY_GITIGNORE {
            let _ = std::fs::remove_file(&gitignore);
        }
    }
    Ok(())
}

/// Remove a file, retrying briefly on failure. Windows keeps a transient handle
/// on a SQLite store just after its pool closes (WAL sidecar teardown / an AV or
/// indexer scanning the just-released file lags the close), so an immediate
/// delete can hit "file in use" for a few dozen milliseconds. A missing file is
/// success. ~1s bound, then the real error surfaces.
fn remove_file_retrying(path: &Path) -> std::io::Result<()> {
    for _ in 0..40 {
        match std::fs::remove_file(path) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(_) => std::thread::sleep(std::time::Duration::from_millis(25)),
        }
    }
    match std::fs::remove_file(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

/// Remove a directory tree, retrying briefly (same Windows transient-handle
/// reason as `remove_file_retrying`; a canonical `items/` never holds open file
/// handles, but an AV/indexer scan can still lag a delete). A missing directory
/// is success.
fn remove_dir_retrying(path: &Path) -> std::io::Result<()> {
    for _ in 0..40 {
        match std::fs::remove_dir_all(path) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(_) => std::thread::sleep(std::time::Duration::from_millis(25)),
        }
    }
    match std::fs::remove_dir_all(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

fn note_bucket(item: &Item) -> u8 {
    if item.kind == Kind::Note {
        1
    } else {
        0
    }
}

fn priority_rank(item: &Item) -> u8 {
    match item.priority {
        Some(Priority::High) => 0,
        Some(Priority::Normal) => 1,
        Some(Priority::Low) => 2,
        None => 3,
    }
}

fn status_rank(item: &Item) -> u8 {
    match item.status {
        Some(Status::Doing) => 0,
        Some(Status::Todo) => 1,
        Some(Status::Done) => 2,
        None => 3,
    }
}

/// Total order that mirrors the per-store SQL `push_sort` EXACTLY, so a merged
/// multi-store list equals a single-DB query: `pinned DESC`, the sort-mode key,
/// then `(created_at DESC, id ASC)`. Timestamps are fixed-precision RFC 3339, so
/// byte-order string comparison equals chronological order — matching SQLite's
/// BINARY collation.
fn item_order(a: &Item, b: &Item, sort: Sort) -> Ordering {
    b.pinned
        .cmp(&a.pinned)
        .then_with(|| match sort {
            Sort::Updated => b.updated_at.cmp(&a.updated_at),
            Sort::Created => b.created_at.cmp(&a.created_at),
            Sort::Priority => note_bucket(a)
                .cmp(&note_bucket(b))
                .then_with(|| priority_rank(a).cmp(&priority_rank(b))),
            Sort::Status => note_bucket(a)
                .cmp(&note_bucket(b))
                .then_with(|| status_rank(a).cmp(&status_rank(b))),
        })
        .then_with(|| b.created_at.cmp(&a.created_at))
        .then_with(|| a.id.cmp(&b.id))
}

/// K-way merge of per-store lists, each already ordered by `item_order`. Picks
/// the smallest head across stores each step — O(total items × stores).
fn k_way_merge(mut lists: Vec<VecDeque<Item>>, sort: Sort) -> Vec<Item> {
    let total: usize = lists.iter().map(VecDeque::len).sum();
    let mut out = Vec::with_capacity(total);
    loop {
        let mut best: Option<usize> = None;
        for i in 0..lists.len() {
            if let Some(head) = lists[i].front() {
                match best {
                    None => best = Some(i),
                    Some(b) => {
                        if item_order(head, lists[b].front().unwrap(), sort) == Ordering::Less {
                            best = Some(i);
                        }
                    }
                }
            }
        }
        match best {
            Some(i) => out.push(lists[i].pop_front().unwrap()),
            None => break,
        }
    }
    out
}

#[cfg(test)]
mod merge_tests {
    use super::*;
    use sqlx::types::Json;

    fn item(id: &str, created: &str, updated: &str, pinned: bool) -> Item {
        Item {
            id: id.into(),
            kind: Kind::Note,
            title: id.into(),
            body: String::new(),
            status: None,
            priority: None,
            due_at: None,
            tags: Json(vec![]),
            created_at: created.into(),
            updated_at: updated.into(),
            archived: false,
            pinned,
            project_id: None,
            jira_url: None,
        }
    }

    fn ids(items: &[Item]) -> Vec<&str> {
        items.iter().map(|i| i.id.as_str()).collect()
    }

    #[test]
    fn equal_timestamps_break_by_id_asc() {
        // Merged order must equal a single-DB query: equal updated_at → equal
        // created_at → id ASC. The later-listed item ("id-1") wins on id.
        let ts = "2026-07-14T00:00:00.000+00:00";
        let a = vec![item("id-2", ts, ts, false)].into();
        let b = vec![item("id-1", ts, ts, false)].into();
        let merged = k_way_merge(vec![a, b], Sort::Updated);
        assert_eq!(ids(&merged), vec!["id-1", "id-2"]);
    }

    #[test]
    fn interleaves_by_recency_across_stores() {
        // Sort modes interleave GLOBALLY (not per-store concatenation).
        let a = vec![
            item("a-new", "2026-07-14T00:00:03.000+00:00", "2026-07-14T00:00:03.000+00:00", false),
            item("a-old", "2026-07-14T00:00:01.000+00:00", "2026-07-14T00:00:01.000+00:00", false),
        ]
        .into();
        let b = vec![item("b-mid", "2026-07-14T00:00:02.000+00:00", "2026-07-14T00:00:02.000+00:00", false)].into();
        let merged = k_way_merge(vec![a, b], Sort::Updated);
        assert_eq!(ids(&merged), vec!["a-new", "b-mid", "a-old"]);
    }

    #[test]
    fn pinned_wins_across_stores() {
        let newer = vec![item("newer", "2026-07-14T00:00:09.000+00:00", "2026-07-14T00:00:09.000+00:00", false)].into();
        let pinned = vec![item("pinned", "2026-07-14T00:00:00.000+00:00", "2026-07-14T00:00:00.000+00:00", true)].into();
        let merged = k_way_merge(vec![newer, pinned], Sort::Updated);
        assert_eq!(merged[0].id, "pinned", "pinned leads across stores even against a newer item");
    }

    #[test]
    fn same_id_from_two_stores_is_not_collapsed() {
        // An id collision across stores keeps both (no dedup); the manager stamps
        // distinct project_id and the frontend keys by `projectId:id`.
        let ts = "2026-07-14T00:00:00.000+00:00";
        let mut x = item("dup", ts, ts, false);
        x.project_id = Some("A".into());
        let mut y = item("dup", ts, ts, false);
        y.project_id = Some("B".into());
        let merged = k_way_merge(vec![vec![x].into(), vec![y].into()], Sort::Updated);
        assert_eq!(merged.len(), 2);
        let projects: Vec<&str> = merged.iter().filter_map(|i| i.project_id.as_deref()).collect();
        assert!(projects.contains(&"A") && projects.contains(&"B"));
    }
}
