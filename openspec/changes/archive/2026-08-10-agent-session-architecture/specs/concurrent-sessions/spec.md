## Purpose

Makes Session a first-class, identified, persisted, and concurrent entity — replacing the single application-wide `Mutex<Option<Session>>` — so a thread can run more than one session and two threads can run at once.

## ADDED Requirements

### Requirement: Multiple concurrent sessions
The system SHALL support more than one live session at a time, keyed by a unique session id, without terminating an unrelated session when a new one starts.

#### Scenario: Two agents on one thread
- **WHEN** a session using one agent is live on a thread and the user starts a session using a different agent on the same thread
- **THEN** both sessions run concurrently, each with its own busy state, and neither is terminated by the other starting

#### Scenario: One agent across two threads
- **WHEN** a session is live on thread A and the user starts a new session on thread B
- **THEN** both sessions run concurrently and events route to their respective threads

#### Scenario: Live-session collision warning
- **WHEN** a new session is started in a project root where another session is already live
- **THEN** the system surfaces a one-line warning naming the other live session, and still starts the new session (no blocking, no lock)

### Requirement: Per-session lifecycle and busy state
The system SHALL track `busy` and support `terminate` independently per session. Querying execution status SHALL return the state of all live sessions, not a single global flag.

#### Scenario: Independent busy flags
- **WHEN** two sessions are live, one processing a turn and one idle
- **THEN** querying status reports the processing session as busy and the idle session as not busy

#### Scenario: Cancelling one session does not affect another
- **WHEN** the user cancels one live session
- **THEN** only that session terminates; other live sessions continue running

#### Scenario: Cancelling an in-flight Codex turn
- **WHEN** the user cancels a session mid-turn whose agent uses a per-turn (non-persistent) transport
- **THEN** the underlying process for that turn is killed, not merely detached

### Requirement: Session records are persisted append-only
The system SHALL append a session record on session start (open) and on session end (close, with an outcome), to a per-thread append-only log distinct from the message log.

#### Scenario: Session lifecycle recorded
- **WHEN** a session starts and later ends
- **THEN** an open record and a close record both exist in the thread's session log, and the close record's outcome is one of `done`, `crashed`, or `cancelled` matching how the session actually ended

#### Scenario: Interrupted session on restart
- **WHEN** the application restarts and a session record exists with no close (`ended_at`) recorded
- **THEN** that record is closed with outcome `interrupted`, and no process from before the restart is assumed to still be running

### Requirement: Provider resume handle lives on the session record, not the thread
The system SHALL store a session's provider-private resume handle only on that session's record, never on the thread's durable metadata.

#### Scenario: Provider handle scoped to its session
- **WHEN** a session using a resumable agent ends
- **THEN** its provider resume handle is recorded on that session's record, and the thread's own metadata carries no provider-specific handle field

#### Scenario: Legacy handle migration
- **WHEN** a thread has a legacy provider handle from before this change and no session log yet exists
- **THEN** reading that thread synthesizes exactly one closed session record attributing the handle to the Claude agent, without fabricating a resumable session for any other agent

### Requirement: Busy guard covers all sessions on a thread
The system SHALL refuse a thread-deletion request if any session belonging to that thread is currently busy, not just the most recently active one.

#### Scenario: Delete blocked by any busy session
- **WHEN** a thread has two sessions and one of them is busy
- **THEN** a request to delete that thread is refused
