//! Buffered, append-only JSONL writer for session and thread logs.
//!
//! `SessionLogWriter` buffers serialized lines in memory per log path and only
//! writes + fsyncs when a turn ends (`ExecutorEvent::Done`), a log's buffer passes
//! a size threshold, or the app quits.
//! This removes the per-message `fsync` cost from the hot path while keeping
//! durability bounded by turn duration (D9). Lines are held in memory, not in an
//! open file descriptor, so external writes (e.g. crash-recovery test fixtures)
//! cannot leave a stale file offset.

use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, PoisonError, TryLockError};
use crate::Res;

/// Lines waiting to be written, plus lines a flusher is writing right now.
///
/// A flush is three steps (see [`flush_shared`]): move the buffers to
/// `in_flight` under the writer lock, write + fsync them with the lock
/// *released*, then retire them under the lock. The fsync is the slow part, so
/// appends and reads never wait on it. While it runs, the log's true state is
/// "`base_len` bytes on disk, then `in_flight`, then `buffers`" — however far
/// the write has got — and every reader goes through [`Self::view`] to see that
/// and nothing else.
pub struct SessionLogWriter {
    buffers: HashMap<PathBuf, Vec<u8>>,
    in_flight: HashMap<PathBuf, InFlight>,
}

struct InFlight {
    /// The file's length when the flush began: the write only ever appends
    /// past it, so these bytes are stable however far the write has got.
    base_len: u64,
    bytes: Arc<Vec<u8>>,
}

/// One log's bytes handed to a flusher.
pub(crate) struct Flushing {
    path: PathBuf,
    bytes: Arc<Vec<u8>>,
}

impl SessionLogWriter {
    pub fn new() -> Self {
        Self { buffers: HashMap::new(), in_flight: HashMap::new() }
    }

    /// Append one already-serialized JSON line to `path`. The line is buffered
    /// in memory; call [`flush_shared`] to write it to disk.
    pub fn append(&mut self, path: &Path, line: &[u8]) -> Res<()> {
        let buf = self.buffers.entry(path.to_path_buf()).or_default();
        buf.extend_from_slice(line);
        buf.push(b'\n');
        Ok(())
    }

    /// Bytes not yet safely on disk for `path`: being written, or still waiting.
    pub fn buffered_len(&self, path: &Path) -> u64 {
        let waiting = self.buffers.get(path).map_or(0, |b| b.len());
        let writing = self.in_flight.get(path).map_or(0, |f| f.bytes.len());
        (waiting + writing) as u64
    }

    /// Bytes of `path` that are on disk and stable. Not `metadata().len()`
    /// alone: while a flush is writing, the file may already hold some of the
    /// in-flight bytes, which `view` reports separately.
    pub fn disk_len(&self, path: &Path) -> u64 {
        self.in_flight.get(path).map_or_else(|| crate::store::file_len(path), |f| f.base_len)
    }

    /// The log as one consistent value: the first `disk_len` bytes of the file,
    /// then these bytes. Together they are every line exactly once, whatever a
    /// concurrent flush has or hasn't written yet.
    pub fn view(&self, path: &Path) -> (u64, Vec<u8>) {
        let mut tail = vec![];
        if let Some(f) = self.in_flight.get(path) {
            tail.extend_from_slice(&f.bytes);
        }
        if let Some(b) = self.buffers.get(path) {
            tail.extend_from_slice(b);
        }
        (self.disk_len(path), tail)
    }

    /// Step 1 of a flush: claim the buffers (one log, or all) for writing.
    pub(crate) fn begin_flush(&mut self, only: Option<&Path>) -> Vec<Flushing> {
        let paths: Vec<PathBuf> = match only {
            Some(path) => vec![path.to_path_buf()],
            None => self.buffers.keys().cloned().collect(),
        };
        let mut batch = vec![];
        for path in paths {
            let Some(buf) = self.buffers.remove(&path).filter(|b| !b.is_empty()) else { continue };
            let bytes = Arc::new(buf);
            let base_len = crate::store::file_len(&path);
            self.in_flight.insert(path.clone(), InFlight { base_len, bytes: bytes.clone() });
            batch.push(Flushing { path, bytes });
        }
        batch
    }

    /// Step 3: the bytes are on disk (or the write failed and is being
    /// reported); either way they stop being "in flight".
    pub(crate) fn finish_flush(&mut self, batch: &[Flushing]) {
        for flushed in batch {
            self.in_flight.remove(&flushed.path);
        }
    }
}

/// One flusher at a time, so a log never has two writes in flight. Only
/// flushers take this — appends and reads never do, which is the point.
pub(crate) static FLUSH_GATE: Mutex<()> = Mutex::new(());

/// Retires a batch on drop, so a panic mid-write can't leave lines "in flight"
/// forever (readers would show them twice).
struct Retire<'a> {
    writer: &'a SharedSessionLogWriter,
    batch: &'a [Flushing],
}

impl Drop for Retire<'_> {
    fn drop(&mut self) {
        self.writer.lock().unwrap_or_else(PoisonError::into_inner).finish_flush(self.batch);
    }
}

/// Make buffered lines durable: write, close any torn tail, fsync.
///
/// `only` limits it to one log. With `wait`, a flush already running is waited
/// for and this returns only once everything buffered *before the call* is on
/// disk (turn end, quit). Without it, a running flush means "skip": the size
/// trigger just tries again on a later append.
///
/// The writer lock is held for bookkeeping only, never across file I/O, so a
/// fsync of a big log stalls no session's appends and no reader.
///
/// Paths whose parent directory no longer exists are skipped rather than
/// failing; this only happens when a temporary directory (e.g. in tests)
/// was dropped while its buffered bytes were still held, and it keeps one
/// flush from aborting every other pending write.
pub fn flush_shared(only: Option<&Path>, wait: bool) -> Res<()> {
    let _gate = if wait {
        FLUSH_GATE.lock().unwrap_or_else(PoisonError::into_inner)
    } else {
        match FLUSH_GATE.try_lock() {
            Ok(gate) => gate,
            Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
            Err(TryLockError::WouldBlock) => return Ok(()),
        }
    };
    let writer = shared_session_log_writer();
    let batch = writer.lock().unwrap_or_else(PoisonError::into_inner).begin_flush(only);
    let _retire = Retire { writer: &writer, batch: &batch };
    let mut last_err: Option<String> = None;
    for flushing in &batch {
        if let Err(err) = write_out(&flushing.path, &flushing.bytes) {
            last_err = Some(err);
        }
    }
    last_err.map_or(Ok(()), |err| Err(err.into()))
}

/// Append `buf` to `path`, closing a torn tail first, then fsync.
pub(crate) fn write_out(path: &Path, buf: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if std::fs::create_dir_all(parent).is_err() && !parent.exists() {
            return Ok(());
        }
    }
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else {
        return Ok(());
    };
    // A previous unclean shutdown may have left a torn line; close it
    // off once per flush so this batch doesn't get glued to it.
    if !crate::store::ends_with_newline(path).unwrap_or(true) {
        file.write_all(b"\n").map_err(|err| format!("close torn line: {err}"))?;
    }
    file.write_all(buf).map_err(|err| format!("append to {}: {err}", path.display()))?;
    file.sync_all().map_err(|err| format!("fsync {}: {err}", path.display()))
}

impl Default for SessionLogWriter {
    fn default() -> Self {
        Self::new()
    }
}

pub type SharedSessionLogWriter = Arc<Mutex<SessionLogWriter>>;

/// The process-global writer used by the store layer and the Tauri harness.
/// Tests that need isolated durability can call [`crate::store::flush_session_log_writer`]
/// before reading back what they just wrote.
pub fn shared_session_log_writer() -> SharedSessionLogWriter {
    static INSTANCE: OnceLock<SharedSessionLogWriter> = OnceLock::new();
    INSTANCE.get_or_init(|| Arc::new(Mutex::new(SessionLogWriter::new()))).clone()
}
