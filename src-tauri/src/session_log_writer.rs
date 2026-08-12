//! Buffered, append-only JSONL writer for session and thread logs.
//!
//! `SessionLogWriter` buffers serialized lines in memory per log path and only
//! writes + fsyncs when a turn ends (`ExecutorEvent::Done`) or the app quits.
//! This removes the per-message `fsync` cost from the hot path while keeping
//! durability bounded by turn duration (D9). Lines are held in memory, not in an
//! open file descriptor, so external writes (e.g. crash-recovery test fixtures)
//! cannot leave a stale file offset.

use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

/// In-memory buffer per log path. All writes are buffered; call `flush()` to
/// make them durable.
pub struct SessionLogWriter {
    buffers: HashMap<PathBuf, Vec<u8>>,
}

impl SessionLogWriter {
    pub fn new() -> Self {
        Self { buffers: HashMap::new() }
    }

    /// Append one already-serialized JSON line to `path`. The line is buffered
    /// in memory; call `flush()` to write it to disk.
    pub fn append(&mut self, path: &Path, line: &[u8]) -> Result<(), String> {
        let buf = self.buffers.entry(path.to_path_buf()).or_default();
        buf.extend_from_slice(line);
        buf.push(b'\n');
        Ok(())
    }

    /// Bytes buffered for `path` since the last flush. The seq cache can treat
    /// `file_len(path) + buffered_len(path)` as the expected on-disk length
    /// after the next flush.
    pub fn buffered_len(&self, path: &Path) -> u64 {
        self.buffers.get(path).map(|b| b.len() as u64).unwrap_or(0)
    }

    /// The raw bytes buffered for `path` since the last flush, so a reader can
    /// see unflushed writes without forcing a flush. Each buffered entry is a
    /// serialized JSON line followed by `\n`, so the slice is valid UTF-8.
    pub fn buffer_for(&self, path: &Path) -> Option<&[u8]> {
        self.buffers.get(path).map(|b| b.as_slice())
    }

    /// Flush every buffered log: open the file, close any torn line from an
    /// unclean shutdown, write the buffered bytes, fsync, and close.
    ///
    /// Paths whose parent directory no longer exist are skipped rather than
    /// failing; this only happens when a temporary directory (e.g. in tests)
    /// was dropped while its buffered bytes were still held, and it keeps one
    /// flush from aborting every other pending write.
    pub fn flush(&mut self) -> Result<(), String> {
        let mut last_err: Option<String> = None;
        for (path, buf) in self.buffers.iter() {
            if buf.is_empty() {
                continue;
            }
            if let Some(parent) = path.parent() {
                if std::fs::create_dir_all(parent).is_err() && !parent.exists() {
                    continue;
                }
            }
            let mut file = match OpenOptions::new().create(true).append(true).open(path) {
                Ok(f) => f,
                Err(_) => continue,
            };
            // A previous unclean shutdown may have left a torn line; close it
            // off once per flush so this batch doesn't get glued to it.
            if !crate::store::ends_with_newline(path).unwrap_or(true) {
                if let Err(err) = file.write_all(b"\n") {
                    last_err = Some(format!("close torn line: {err}"));
                    continue;
                }
            }
            if let Err(err) = file.write_all(buf) {
                last_err = Some(format!("append to {}: {err}", path.display()));
                continue;
            }
            if let Err(err) = file.sync_all() {
                last_err = Some(format!("fsync {}: {err}", path.display()));
                continue;
            }
        }
        self.buffers.clear();
        last_err.map_or(Ok(()), Err)
    }
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
