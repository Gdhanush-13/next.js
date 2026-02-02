use std::{
    cell::Cell,
    hash::Hash,
    ops::{Deref, DerefMut},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use smallvec::SmallVec;
use thread_local::ThreadLocal;
use turbo_bincode::TurboBincodeBuffer;
use turbo_tasks::{FxDashMap, TaskId, parallel};

use crate::{
    backend::storage_schema::TaskStorage,
    backing_storage::SnapshotItem,
    database::key_value_database::KeySpace,
    utils::{
        dash_map_drop_contents::drop_contents,
        dash_map_multi::{RefMut, get_multiple_mut},
    },
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TaskDataCategory {
    Meta,
    Data,
    All,
}

impl TaskDataCategory {
    pub fn into_specific(self) -> SpecificTaskDataCategory {
        match self {
            TaskDataCategory::Meta => SpecificTaskDataCategory::Meta,
            TaskDataCategory::Data => SpecificTaskDataCategory::Data,
            TaskDataCategory::All => unreachable!(),
        }
    }

    pub fn includes_data(self) -> bool {
        matches!(self, TaskDataCategory::Data | TaskDataCategory::All)
    }

    pub fn includes_meta(self) -> bool {
        matches!(self, TaskDataCategory::Meta | TaskDataCategory::All)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SpecificTaskDataCategory {
    Meta,
    Data,
}

impl SpecificTaskDataCategory {
    /// Returns the KeySpace for storing data of this category
    pub fn key_space(self) -> KeySpace {
        match self {
            SpecificTaskDataCategory::Meta => KeySpace::TaskMeta,
            SpecificTaskDataCategory::Data => KeySpace::TaskData,
        }
    }
}

/// Number of shards for the snapshots map. This is intentionally small since:
/// 1. Snapshots are rare (only during dev mode idle-callback persistence races)
/// 2. We're otherwise saturating the CPU doing persistence, so lock contention here doesn't matter.
/// 3. We want to minimize fixed overhead from sharding
const SNAPSHOT_SHARDS: usize = 16;

pub struct Storage {
    snapshot_mode: AtomicBool,
    /// Stores snapshots of task state for tasks accessed during snapshot mode.
    /// - `Some(snapshot)`: Task was modified before snapshot mode and accessed again during it.
    ///   Contains a copy of the pre-snapshot state that needs to be persisted.
    /// - `None`: Task was first modified during snapshot mode (not part of current snapshot). Will
    ///   be added to modified list for the next snapshot cycle.
    snapshots: FxDashMap<TaskId, Option<Box<TaskStorage>>>,
    map: FxDashMap<TaskId, Box<TaskStorage>>,
}

impl Storage {
    pub fn new(shard_amount: usize, small_preallocation: bool) -> Self {
        let map_capacity: usize = if small_preallocation {
            1024
        } else {
            1024 * 1024
        };

        Self {
            snapshot_mode: AtomicBool::new(false),
            snapshots: FxDashMap::with_capacity_and_hasher_and_shard_amount(
                0,
                Default::default(),
                SNAPSHOT_SHARDS,
            ),
            map: FxDashMap::with_capacity_and_hasher_and_shard_amount(
                map_capacity,
                Default::default(),
                shard_amount,
            ),
        }
    }

    /// Processes every modified item (resp. a snapshot of it) with the given function and returns
    /// the results. Ends snapshot mode afterwards.
    /// process is called while holding a read lock on the task storage, so it can access
    /// the TaskStorage directly without cloning.
    /// process_snapshot is called for tasks that were accessed during snapshot mode and
    /// receives an owned Box<TaskStorage> snapshot.
    /// Both callbacks receive a mutable scratch buffer that can be reused across iterations
    /// to avoid repeated allocations.
    /// The returned shards implement `IntoIterator`. Empty shards (no modified or snapshot
    /// entries) are filtered out, but shards may still yield no items if all entries produce
    /// empty `SnapshotItem`s (this is rare and only happens under error conditions).
    pub fn take_snapshot<
        'l,
        P: for<'a> Fn(TaskId, &'a TaskStorage, &mut TurboBincodeBuffer) -> SnapshotItem + Sync,
    >(
        &'l self,
        process: &'l P,
    ) -> Vec<SnapshotShard<'l, P>> {
        if !self.snapshot_mode() {
            self.start_snapshot();
        }

        let guard = Arc::new(SnapshotGuard {
            storage: self,
            scratch_buffers: ThreadLocal::new(),
        });

        // The number of shards is much larger than the number of threads, so the effect of the
        // locks held is negligible.
        parallel::map_collect::<_, _, Vec<_>>(self.map.shards(), |shard| {
            let mut direct_snapshots: Vec<(TaskId, Box<TaskStorage>)> = Vec::new();
            let mut modified: SmallVec<[TaskId; 4]> = SmallVec::new();
            {
                // Take the snapshots from the modified map
                let shard_guard = shard.read();
                // Safety: shard_guard must outlive the iterator.
                for bucket in unsafe { shard_guard.iter() } {
                    // Safety: the guard guarantees that the bucket is not removed and the ptr
                    // is valid.
                    let (key, shared_value) = unsafe { bucket.as_mut() };
                    let flags = &shared_value.get().flags;
                    // Is it possible to be 'new' but not 'modified'
                    // TODO: it shouldn't be
                    if flags.any_modified() || flags.new_persistent_task() {
                        if let Some(mut snapshot) = self.snapshots.get_mut(key) {
                            if let Some(snapshot) = snapshot.take() {
                                direct_snapshots.push((*key, snapshot));
                            }
                        } else {
                            modified.push(*key);
                        }
                    }
                }
                // Safety: shard_guard must outlive the iterator.
                drop(shard_guard);
            }

            // Early return for shards with no entries at all
            if direct_snapshots.is_empty() && modified.is_empty() {
                return None;
            }

            Some(SnapshotShard {
                direct_snapshots,
                modified,
                storage: self,
                process,
                _guard: guard.clone(),
            })
        })
        .into_iter()
        .flatten()
        .collect()
    }

    /// Start snapshot mode.
    pub fn start_snapshot(&self) {
        self.snapshot_mode.store(true, Ordering::Release);
    }

    /// End snapshot mode.
    /// Items that have snapshots will be kept as modified since they have been accessed during the
    /// snapshot mode. Items that are modified will be removed and considered as unmodified.
    /// When items are accessed in future they will be marked as modified.
    fn end_snapshot(&self) {
        // Phase 1: Clear modified/new flags on all tasks that were in the original modified list.
        // This must happen WHILE STILL IN snapshot mode so that any concurrent modifications
        // will go to the `snapshots` map (since they see snapshot_mode=true and modified=false).
        parallel::try_for_each(self.map.shards(), |shard| {
            // Take the snapshots from the modified map
            let shard_guard = shard.write();
            // Safety: shard_guard must outlive the iterator.
            for bucket in unsafe { shard_guard.iter() } {
                // Safety: the guard guarantees that the bucket is not removed and the ptr
                // is valid.
                let (_, shared_value) = unsafe { bucket.as_mut() };
                let flags = &mut shared_value.get_mut().flags;
                if flags.any_modified() {
                    flags.set_data_modified(false);
                    flags.set_meta_modified(false);
                    flags.set_new_persistent_task(false);
                }
            }
            // Safety: shard_guard must outlive the iterator.
            drop(shard_guard);
            anyhow::Ok(())
        })
        .expect("unfailable");

        // Phase 2: Leave snapshot mode - modifications now go to modified list
        self.snapshot_mode.store(false, Ordering::Release);

        // Phase 3: Handle tasks that had snapshots (they were accessed during snapshot mode).
        // These need to be re-added to modified for the next cycle.
        // Now that we're Inactive, concurrent track_modification will go to the modified bits
        // directly, so there's no conflict with us reading+clearing the snapshots map here.
        //
        // NOTE: technically when tracking modifications or beginning a snapshot we hold a `map`
        // lock while updating snapshots, but here we do the reverse.  This is safe only because we
        // cannot be in snapshot mode while this loop executes. TODO: how do we guarantee
        // that start_snapshot isn't called while we are executing end_snapshot?

        parallel::try_for_each(self.snapshots.shards(), |shard| {
            // Take the snapshots from the modified map
            let mut shard_guard = shard.write();
            // Safety: shard_guard must outlive the iterator.
            for (key, _) in shard_guard.drain() {
                if let Some(mut inner) = self.map.get_mut(&key) {
                    if inner.flags.meta_modified_during_snapshot() {
                        inner.flags.set_meta_modified_during_snapshot(false);
                        inner.flags.set_meta_modified(true);
                    }
                    if inner.flags.data_modified_during_snapshot() {
                        inner.flags.set_data_modified_during_snapshot(false);
                        inner.flags.set_data_modified(true);
                    }
                }
            }
            shard_guard.clear();
            // If we are saving a non-trivial amount of memory just clear it out.
            if shard_guard.capacity() > 1024 {
                shard_guard.shrink_to(0, |_entry| {
                    unreachable!("nothing is hashed when resizing an empty shard to zero");
                });
            }
            // Safety: shard_guard must outlive the iterator.
            drop(shard_guard);
            anyhow::Ok(())
        })
        .expect("unfailable");
    }

    /// Returns true if actively snapshotting (modifications should go to snapshots map).
    /// Returns false if inactive (modifications go to modified list).
    fn snapshot_mode(&self) -> bool {
        self.snapshot_mode.load(Ordering::Acquire)
    }

    pub fn access_mut(&self, key: TaskId) -> StorageWriteGuard<'_> {
        let inner = match self.map.entry(key) {
            dashmap::mapref::entry::Entry::Occupied(e) => e.into_ref(),
            dashmap::mapref::entry::Entry::Vacant(e) => e.insert(Box::new(TaskStorage::new())),
        };
        StorageWriteGuard {
            storage: self,
            inner: inner.into(),
        }
    }

    pub fn access_pair_mut(
        &self,
        key1: TaskId,
        key2: TaskId,
    ) -> (StorageWriteGuard<'_>, StorageWriteGuard<'_>) {
        let (a, b) = get_multiple_mut(&self.map, key1, key2, || Box::new(TaskStorage::new()));
        (
            StorageWriteGuard {
                storage: self,
                inner: a,
            },
            StorageWriteGuard {
                storage: self,
                inner: b,
            },
        )
    }

    pub fn drop_contents(&self) {
        drop_contents(&self.map);
        self.snapshots.clear();
    }
}

pub struct StorageWriteGuard<'a> {
    storage: &'a Storage,
    inner: RefMut<'a, TaskId, Box<TaskStorage>>,
}

impl StorageWriteGuard<'_> {
    /// Tracks mutation of this task
    #[inline(always)]
    pub fn track_modification(
        &mut self,
        category: SpecificTaskDataCategory,
        #[allow(unused_variables)] name: &str,
    ) {
        self.track_modification_internal(
            category,
            #[cfg(feature = "trace_task_modification")]
            name,
        );
    }

    fn track_modification_internal(
        &mut self,
        category: SpecificTaskDataCategory,
        #[cfg(feature = "trace_task_modification")] name: &str,
    ) {
        let flags = &self.inner.flags;
        if flags.is_modified_during_snapshot(category) {
            return;
        }
        let modified = flags.is_modified(category);
        #[cfg(feature = "trace_task_modification")]
        let _span = (!modified).then(|| tracing::trace_span!("mark_modified", name).entered());
        match (self.storage.snapshot_mode(), modified) {
            (false, false) => {
                // Not in snapshot mode and item is unmodified
                self.inner.flags.set_modified(category, true);
            }
            (false, true) => {
                // Not in snapshot mode and item is already modified
                // Do nothing
            }
            (true, false) => {
                // In snapshot mode and item is unmodified (so it's not part of the snapshot)
                // Mark it so it gets re-added as Modified after this snapshot completes
                self.inner
                    .flags
                    .set_modified_during_snapshot(category, true);
            }
            (true, true) => {
                // In snapshot mode and item is modified (so it's part of the snapshot)
                // We need to store the original version that is part of the snapshot
                if !flags.any_modified_during_snapshot() {
                    // Snapshot all non-transient fields but keep the modified bits since
                    // save_snapshot relies on them
                    let mut snapshot = self.inner.clone_snapshot();
                    snapshot.flags.set_data_modified(flags.data_modified());
                    snapshot.flags.set_meta_modified(flags.meta_modified());
                    snapshot
                        .flags
                        .set_new_persistent_task(flags.new_persistent_task());
                    self.storage
                        .snapshots
                        .insert(*self.inner.key(), Some(Box::new(snapshot)));
                }
                self.inner
                    .flags
                    .set_modified_during_snapshot(category, true);
            }
        }
    }
}

impl Deref for StorageWriteGuard<'_> {
    type Target = TaskStorage;

    fn deref(&self) -> &Self::Target {
        &self.inner
    }
}

impl DerefMut for StorageWriteGuard<'_> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.inner
    }
}

/// How big of a buffer to allocate initially. Based on metrics from a large
/// application this should cover about 98% of values with no resizes.
const SCRATCH_BUFFER_INITIAL_SIZE: usize = 4096;

/// State machine for a per-thread scratch buffer slot.
///
/// Transitions:
/// - `Uninit` → `Taken` (first take)
/// - `Available` → `Taken` (subsequent takes)
/// - `Taken` → `Available` (return)
///
/// Any other transition is a bug (e.g. double-take or double-return).
#[derive(Default)]
enum ScratchBufferSlot {
    /// No buffer has been allocated on this thread yet.
    #[default]
    Uninit,
    /// The buffer is currently checked out.
    Taken,
    /// The buffer is available for reuse.
    Available(TurboBincodeBuffer),
}

pub struct SnapshotGuard<'l> {
    storage: &'l Storage,
    /// Per-thread scratch buffers for encoding task data. Buffers are taken
    /// by `SnapshotShardIter` on creation and returned on drop, allowing reuse
    /// across multiple shards processed by the same thread. When the guard is
    /// dropped (after all iterators are done), the `ThreadLocal` drops too,
    /// freeing all buffers.
    scratch_buffers: ThreadLocal<Cell<ScratchBufferSlot>>,
}

impl SnapshotGuard<'_> {
    fn take_scratch_buffer(&self) -> TurboBincodeBuffer {
        let cell = self.scratch_buffers.get_or_default();
        match cell.take() {
            ScratchBufferSlot::Available(buf) => {
                cell.set(ScratchBufferSlot::Taken);
                buf
            }
            ScratchBufferSlot::Uninit => {
                cell.set(ScratchBufferSlot::Taken);
                TurboBincodeBuffer::with_capacity(SCRATCH_BUFFER_INITIAL_SIZE)
            }
            ScratchBufferSlot::Taken => {
                panic!("scratch buffer taken twice without being returned");
            }
        }
    }

    fn return_scratch_buffer(&self, buffer: TurboBincodeBuffer) {
        let cell = self.scratch_buffers.get_or_default();
        match cell.take() {
            ScratchBufferSlot::Taken => cell.set(ScratchBufferSlot::Available(buffer)),
            ScratchBufferSlot::Available(_) => {
                panic!("scratch buffer returned without being taken (already available)");
            }
            ScratchBufferSlot::Uninit => {
                panic!("scratch buffer returned without being taken (uninit)");
            }
        }
    }
}

impl Drop for SnapshotGuard<'_> {
    fn drop(&mut self) {
        self.storage.end_snapshot();
    }
}

pub struct SnapshotShard<'l, P> {
    direct_snapshots: Vec<(TaskId, Box<TaskStorage>)>,
    modified: SmallVec<[TaskId; 4]>,
    storage: &'l Storage,
    process: &'l P,
    /// Held for its `Drop` impl — ensures snapshot mode ends when all shards are done.
    _guard: Arc<SnapshotGuard<'l>>,
}

impl<'l, P> IntoIterator for SnapshotShard<'l, P>
where
    P: Fn(TaskId, &TaskStorage, &mut TurboBincodeBuffer) -> SnapshotItem + Sync,
{
    type Item = SnapshotItem;
    type IntoIter = SnapshotShardIter<'l, P>;

    fn into_iter(self) -> Self::IntoIter {
        let buffer = self._guard.take_scratch_buffer();
        SnapshotShardIter {
            shard: self,
            buffer,
        }
    }
}

/// Iterator over a single shard's snapshot items. Holds a thread-local scratch
/// buffer for the duration of iteration and returns it on drop.
pub struct SnapshotShardIter<'l, P> {
    shard: SnapshotShard<'l, P>,
    buffer: TurboBincodeBuffer,
}

impl<'l, P> Iterator for SnapshotShardIter<'l, P>
where
    P: Fn(TaskId, &TaskStorage, &mut TurboBincodeBuffer) -> SnapshotItem + Sync,
{
    type Item = SnapshotItem;

    fn next(&mut self) -> Option<Self::Item> {
        while let Some((task_id, snapshot)) = self.shard.direct_snapshots.pop() {
            let item = (self.shard.process)(task_id, &snapshot, &mut self.buffer);
            if !item.is_empty() {
                return Some(item);
            }
        }
        while let Some(task_id) = self.shard.modified.pop() {
            let inner = self.shard.storage.map.get(&task_id).unwrap();
            if !inner.flags.any_modified_during_snapshot() {
                let item = (self.shard.process)(task_id, &inner, &mut self.buffer);
                if !item.is_empty() {
                    return Some(item);
                }
            } else {
                drop(inner);

                let mut modified_state = self
                    .shard
                    .storage
                    .snapshots
                    .get_mut(&task_id)
                    .expect("The snapshot bit was set, so it must be in Snapshot state");

                if let Some(snapshot) = modified_state.take() {
                    let item = (self.shard.process)(task_id, &snapshot, &mut self.buffer);
                    if !item.is_empty() {
                        return Some(item);
                    }
                }
            }
        }
        None
    }
}

impl<P> Drop for SnapshotShardIter<'_, P> {
    fn drop(&mut self) {
        self.shard
            ._guard
            .return_scratch_buffer(std::mem::take(&mut self.buffer));
    }
}
