//! Taking a lock without letting one panic brick a subsystem for the rest of
//! the process.
//!
//! A panic while a `Mutex` guard is alive poisons that mutex, and every later
//! `lock().unwrap()` on it panics too — for good. There were 212 unwrapped
//! lock sites against 59 handled ones, and `Harness` alone holds 22
//! independent mutexes, so one panic inside a sink callback could take a
//! whole subsystem out for the lifetime of a process that users keep open for
//! days. No such panic path was found; this is exposure, not a reproduced
//! bug.
//!
//! Recovering is the right default here. The data behind these locks is
//! overwhelmingly a map of sessions, a set of ports, a handle to a child —
//! state that is still perfectly readable after an unrelated panic, and whose
//! loss is total where a poisoned lock's loss is total *and* permanent. A
//! subsystem that might be slightly inconsistent beats one that is certainly
//! dead.
//!
//! Where that reasoning does not hold — an invariant across two fields that a
//! panic could have torn — leave the `unwrap()` and say why in a comment. The
//! point of a single helper is that the exceptions become visible.
//!
//! ## Lock ordering
//!
//! Recovery does not make ordering safe, and the audit called out that 22
//! mutexes were held with none of it written down. Most of that turns out to
//! be a non-problem: `Harness`'s per-field mutexes mean nearly every site
//! takes exactly one, and the overwhelmingly common shape —
//! `self.x.lock().unwrap().insert(..)` — drops its guard at the end of the
//! statement.
//!
//! Scanning for a *bound* guard still alive when a second lock is taken finds
//! four places in the whole backend. They are listed here because four is a
//! number a reader can hold, and because the rule they share is worth
//! stating:
//!
//! | Outer | Inner | Where |
//! |---|---|---|
//! | `chain_sessions` | `acp_sessions` | `lib.rs`, `find_live_session` |
//! | chain-local `sessions` | `acp_sessions` | `chain_exec.rs`, `session_for` |
//! | `completion_server` | `completion_crashes` | `lib.rs`, sidecar restart |
//! | `servers` | that server's `last_error` | `lsp.rs`, `record_exit` |
//!
//! **`acp_sessions` is always taken last.** It is the lock every subsystem
//! eventually wants, so anything that takes it first and then reaches for a
//! chain lock closes the cycle. The same rule generalises: a per-item mutex
//! (`last_error`, a session's buffers) is taken after the collection that
//! owns the item, never before.
//!
//! Holding any of these across an `await`, or across a callback that can
//! re-enter the harness, is what turns an ordering into a deadlock. Release
//! before calling out — `chain_runner.rs` does exactly that, with an explicit
//! `drop(calls)` before it takes its next lock.

use std::sync::{Mutex, MutexGuard, PoisonError};

/// `lock()` that survives an unrelated panic.
pub trait MutexExt<T> {
    /// Locks, recovering the guard if the mutex was poisoned.
    ///
    /// The replacement for `lock().unwrap()`: same shape at the call site,
    /// but a panic elsewhere cannot make this one panic forever.
    fn lock_or_recover(&self) -> MutexGuard<'_, T>;
}

impl<T> MutexExt<T> for Mutex<T> {
    fn lock_or_recover(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Arc;

    #[test]
    fn a_subsystem_keeps_working_after_a_panic_poisons_its_lock() {
        // The shape this exists for: a map of sessions, and a panic in some
        // unrelated callback that happened to be holding the guard.
        let sessions: Arc<Mutex<HashMap<String, u32>>> = Arc::new(Mutex::new(HashMap::new()));
        sessions.lock_or_recover().insert("before".into(), 1);

        let poisoner = Arc::clone(&sessions);
        let panicked = std::thread::spawn(move || {
            let mut guard = poisoner.lock().unwrap();
            guard.insert("during".into(), 2);
            panic!("a sink callback blew up");
        })
        .join();
        assert!(panicked.is_err(), "the test needs that thread to have panicked");
        assert!(sessions.lock().is_err(), "the mutex should now be poisoned");

        // The old code panics here, and on every later access, forever.
        let mut guard = sessions.lock_or_recover();
        assert_eq!(guard.get("before"), Some(&1));
        assert_eq!(guard.get("during"), Some(&2), "writes made before the panic survive");
        guard.insert("after".into(), 3);
        drop(guard);

        assert_eq!(sessions.lock_or_recover().len(), 3, "the subsystem still works");
    }

    #[test]
    fn an_unpoisoned_lock_behaves_exactly_as_before() {
        let value = Mutex::new(vec![1, 2, 3]);
        value.lock_or_recover().push(4);
        assert_eq!(*value.lock_or_recover(), vec![1, 2, 3, 4]);
    }
}
