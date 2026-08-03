import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import MDEditor from "@uiw/react-md-editor";
import "@uiw/react-md-editor/markdown-editor.css";
import "@uiw/react-markdown-preview/markdown.css";

import * as api from "./api";
import type { ExecutorEvent, Message, Preflight, Project, ThreadMeta } from "./api";
import { EventList, itemsFromMessages } from "./EventView";
import "./App.css";

const lastThreadKey = (hash: string) => `floo:lastThread:${hash}`;

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [threads, setThreads] = useState<ThreadMeta[]>([]);
  const [thread, setThread] = useState<ThreadMeta | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [note, setNote] = useState<{ name: string; content: string } | null>(null);
  const [tab, setTab] = useState<"threads" | "notes">("threads");
  const [notePane, setNotePane] = useState<"edit" | "preview">("edit");
  const [commandBar, setCommandBar] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [flight, setFlight] = useState<Preflight | null>(null);
  const [live, setLive] = useState<ExecutorEvent[]>([]);
  const [busy, setBusy] = useState(false);

  const fail = (err: unknown) => setError(String(err));

  const selectThread = useCallback(async (projectHash: string, next: ThreadMeta | null) => {
    setThread(next);
    if (!next) {
      setMessages([]);
      return;
    }
    localStorage.setItem(lastThreadKey(projectHash), next.id);
    setLive([]);
    setMessages(await api.readThread(projectHash, next.id));
  }, []);

  const selectProject = useCallback(
    async (next: Project) => {
      try {
        const refreshed = await api.switchProject(next.hash);
        setProject(refreshed);
        setNote(null);
        const [found, noteNames] = await Promise.all([
          api.listThreads(refreshed.hash),
          api.listNotes(refreshed.hash),
        ]);
        setThreads(found);
        setNotes(noteNames);
        const remembered = localStorage.getItem(lastThreadKey(refreshed.hash));
        await selectThread(refreshed.hash, found.find((t) => t.id === remembered) ?? found[0] ?? null);
      } catch (err) {
        fail(err);
      }
    },
    [selectThread],
  );

  // Restore the most recently used project on launch.
  useEffect(() => {
    api.listProjects().then((found) => {
      setProjects(found);
      if (found.length > 0) selectProject(found[0]);
    }, fail);
  }, [selectProject]);

  // -------------------------------------------------------------- projects

  const onAddProject = async () => {
    try {
      const picked = await open({ directory: true, title: "Add a project" });
      if (typeof picked !== "string") return;
      const added = await api.addProject(picked);
      setProjects(await api.listProjects());
      await selectProject(added);
    } catch (err) {
      fail(err);
    }
  };

  const onRenameProject = async () => {
    if (!project) return;
    const name = prompt("Project display name", project.displayName);
    if (!name?.trim()) return;
    try {
      await api.renameProject(project.hash, name.trim());
      const refreshed = await api.listProjects();
      setProjects(refreshed);
      setProject(refreshed.find((p) => p.hash === project.hash) ?? project);
    } catch (err) {
      fail(err);
    }
  };

  // --------------------------------------------------------------- threads

  const onNewThread = async () => {
    if (!project) return;
    try {
      const created = await api.createThread(project.hash, "New thread");
      setThreads(await api.listThreads(project.hash));
      setNote(null);
      await selectThread(project.hash, created);
    } catch (err) {
      fail(err);
    }
  };

  const onRenameThread = async () => {
    if (!project || !thread) return;
    const title = prompt("Thread title", thread.title);
    if (!title?.trim()) return;
    try {
      const renamed = await api.renameThread(project.hash, thread.id, title.trim());
      setThread(renamed);
      setThreads(await api.listThreads(project.hash));
    } catch (err) {
      fail(err);
    }
  };

  // Keeps the event listener (registered once) pointed at the current thread.
  const current = useRef({ project, thread });
  current.current = { project, thread };

  const refresh = useCallback(async () => {
    const { project, thread } = current.current;
    if (!project || !thread) return;
    const [found, history] = await Promise.all([
      api.listThreads(project.hash),
      api.readThread(project.hash, thread.id),
    ]);
    setThreads(found);
    setThread(found.find((t) => t.id === thread.id) ?? thread);
    setMessages(history);
    setLive([]);
  }, []);

  useEffect(() => {
    api.preflight().then(setFlight, fail);
  }, []);

  // Executor output streams in live; once the turn ends, the persisted log
  // becomes the source of truth again so both paths can't drift.
  useEffect(() => {
    const streaming = listen<ExecutorEvent>("executor-event", async ({ payload }) => {
      if (payload.kind === "done" || payload.kind === "crashed") {
        setBusy(false);
        await refresh().catch(fail);
        return;
      }
      setLive((previous) => [...previous, payload]);
    });
    const updated = listen<string>("thread-updated", () => {
      refresh().catch(fail);
    });
    return () => {
      streaming.then((un) => un());
      updated.then((un) => un());
    };
  }, [refresh]);

  const onGo = async () => {
    const { project, thread } = current.current;
    if (!project || !thread) return;
    try {
      setBusy(true);
      const meta = await api.goMode(project.hash, thread.id);
      await refresh();
      // A linked change means /grill-apply was just sent; otherwise we're idle.
      if (!meta.openSpecChangeName) setBusy(false);
    } catch (err) {
      setBusy(false);
      fail(err);
    }
  };

  const onSpec = async () => {
    const { project, thread } = current.current;
    if (!project || !thread) return;
    try {
      await api.specMode(project.hash, thread.id);
      setBusy(false);
      await refresh();
    } catch (err) {
      fail(err);
    }
  };

  const onPropose = async () => {
    const { project, thread } = current.current;
    if (!project || !thread) return;
    try {
      setBusy(true);
      await api.propose(project.hash, thread.id);
      await refresh();
    } catch (err) {
      setBusy(false);
      fail(err);
    }
  };

  const onToggleMode = () => (thread?.currentMode === "spec" ? onGo() : onSpec());

  const onSend = async () => {
    if (!project || !thread || !draft.trim()) return;
    const text = draft.trim();
    setDraft("");
    // /go and /propose are the same functions the buttons call.
    if (text === "/go") return onGo();
    if (text === "/spec") return onSpec();
    if (text === "/propose") return onPropose();
    try {
      setBusy(true);
      await api.sendMessage(project.hash, thread.id, text, thread.currentMode);
      setMessages(await api.readThread(project.hash, thread.id));
      // Chat-only mode never answers, so never leave the composer locked.
      if (!flight?.selected) setBusy(false);
    } catch (err) {
      setBusy(false);
      fail(err);
    }
  };

  // ----------------------------------------------------------------- notes

  const openNote = useCallback(
    async (projectHash: string, name: string) => {
      try {
        setNote({ name, content: await api.readNote(projectHash, name) });
        setNotePane("edit");
      } catch (err) {
        fail(err);
      }
    },
    [],
  );

  const onCreateNote = async (rawName: string) => {
    if (!project || !rawName.trim()) return;
    try {
      const path = await api.createNote(project.hash, rawName.trim());
      setNotes(await api.listNotes(project.hash));
      setCommandBar(false);
      setTab("notes");
      await openNote(project.hash, path.split("/").pop()!);
    } catch (err) {
      fail(err);
    }
  };

  // Auto-save hand-edits — no confirmation, no re-prompt.
  const saveTimer = useRef<number | undefined>(undefined);
  const onEditNote = (content: string) => {
    if (!project || !note) return;
    setNote({ ...note, content });
    window.clearTimeout(saveTimer.current);
    const { hash } = project;
    const { name } = note;
    saveTimer.current = window.setTimeout(() => {
      api.writeNote(hash, name, content).catch(fail);
    }, 300);
  };

  // ⌘N opens the note command bar from anywhere.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        if (project) setCommandBar(true);
      }
      if (event.key === "Escape") setCommandBar(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [project]);

  // ------------------------------------------------------------------ view

  return (
    <div className="app" data-color-mode="dark">
      <header className="topbar">
        <span className="brand">🔥 Floo Network</span>
        <select
          data-testid="project-picker"
          value={project?.hash ?? ""}
          onChange={(event) => {
            const next = projects.find((p) => p.hash === event.target.value);
            if (next) selectProject(next);
          }}
        >
          {projects.length === 0 && <option value="">No project</option>}
          {projects.map((p) => (
            <option key={p.hash} value={p.hash}>
              {p.displayName}
            </option>
          ))}
        </select>
        <button onClick={onAddProject} data-testid="add-project">
          Add project
        </button>
        {project && (
          <button onClick={onRenameProject} data-testid="rename-project">
            Rename
          </button>
        )}
        <span className="root" title={project?.root}>
          {project?.root}
        </span>
        <button
          className={`status ${flight?.ready ? "ok" : flight?.selected ? "warn" : "bad"}`}
          onClick={() => api.preflight(true).then(setFlight, fail)}
          title={
            flight
              ? [`executor: ${flight.selected ?? "none"}`, ...flight.warnings].join("\n")
              : "checking…"
          }
          data-testid="preflight-status"
        >
          {flight?.selected ?? "no executor"}
          {flight && !flight.ready && flight.selected ? " ⚠" : ""}
        </button>
      </header>
      {flight && flight.warnings.length > 0 && (
        <div className="warnings" data-testid="preflight-warnings">
          {flight.warnings.map((warning) => (
            <div key={warning}>⚠ {warning}</div>
          ))}
        </div>
      )}

      {error && (
        <div className="error" onClick={() => setError(null)} data-testid="error">
          {error} <span className="dismiss">dismiss</span>
        </div>
      )}

      <div className="body">
        <aside className="sidebar">
          <div className="tabs">
            <button
              className={tab === "threads" ? "on" : ""}
              onClick={() => setTab("threads")}
              data-testid="tab-threads"
            >
              Threads
            </button>
            <button
              className={tab === "notes" ? "on" : ""}
              onClick={() => setTab("notes")}
              data-testid="tab-notes"
            >
              Notes
            </button>
          </div>

          {tab === "threads" ? (
            <>
              <button className="wide" onClick={onNewThread} disabled={!project} data-testid="new-thread">
                + New thread
              </button>
              <ul data-testid="thread-list">
                {threads.map((t) => (
                  <li
                    key={t.id}
                    className={t.id === thread?.id ? "on" : ""}
                    onClick={() => {
                      setNote(null);
                      if (project) selectThread(project.hash, t);
                    }}
                  >
                    <span className="title">{t.title}</span>
                    <span className={`badge ${t.currentMode}`}>{t.currentMode}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <>
              <button
                className="wide"
                onClick={() => setCommandBar(true)}
                disabled={!project}
                data-testid="create-note"
              >
                + Create note
              </button>
              <ul data-testid="note-list">
                {notes.map((name) => (
                  <li
                    key={name}
                    className={name === note?.name ? "on" : ""}
                    onClick={() => project && openNote(project.hash, name)}
                  >
                    <span className="title">{name}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </aside>

        <main className="main">
          {note ? (
            <>
              <div className="pane-head">
                <strong data-testid="note-name">{note.name}</strong>
                <div className="tabs">
                  <button
                    className={notePane === "edit" ? "on" : ""}
                    onClick={() => setNotePane("edit")}
                    data-testid="note-edit-tab"
                  >
                    Edit
                  </button>
                  <button
                    className={notePane === "preview" ? "on" : ""}
                    onClick={() => setNotePane("preview")}
                    data-testid="note-preview-tab"
                  >
                    Preview
                  </button>
                </div>
                <div className="spacer" />
                <button onClick={() => setNote(null)}>Close</button>
              </div>
              <div className="editor" data-testid="note-editor">
                <MDEditor
                  value={note.content}
                  onChange={(value) => onEditNote(value ?? "")}
                  preview={notePane}
                  hideToolbar
                  height="100%"
                />
              </div>
            </>
          ) : thread ? (
            <>
              <div className="pane-head">
                <strong data-testid="thread-title">{thread.title}</strong>
                <button onClick={onRenameThread} data-testid="rename-thread">
                  Rename
                </button>
                {thread.openSpecChangeName && (
                  <span className="change-chip" data-testid="change-chip">
                    {thread.openSpecChangeName}
                  </span>
                )}
                <div className="spacer" />
                <button
                  onClick={onPropose}
                  disabled={busy || thread.currentMode !== "spec" || !flight?.selected}
                  data-testid="propose"
                >
                  /propose
                </button>
                <button
                  className={`mode ${thread.currentMode}`}
                  onClick={onToggleMode}
                  disabled={busy || !flight?.selected}
                  data-testid="mode-toggle"
                  title={busy ? "Wait for the current turn to finish" : undefined}
                >
                  {thread.currentMode} mode
                </button>
              </div>
              <div className="messages" data-testid="messages">
                {messages.length === 0 && live.length === 0 && (
                  <p className="empty">No messages yet.</p>
                )}
                <EventList items={[...itemsFromMessages(messages), ...live]} />
                {busy && (
                  <div className="working" data-testid="working">
                    executor working…
                  </div>
                )}
              </div>
              <form
                className="composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  onSend();
                }}
              >
                <input
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder={
                    flight?.selected
                      ? "Message, or /go · /spec · /propose"
                      : "Chat-only — no executor on PATH"
                  }
                  data-testid="composer-input"
                />
                <button type="submit" data-testid="composer-send" disabled={busy}>
                  Send
                </button>
              </form>
            </>
          ) : (
            <p className="empty">
              {project ? "Create a thread to get started." : "Add a project to get started."}
            </p>
          )}
        </main>
      </div>

      {commandBar && (
        <div className="overlay" onClick={() => setCommandBar(false)}>
          <div className="commandbar" onClick={(event) => event.stopPropagation()}>
            <label htmlFor="noteName">New note</label>
            <input
              id="noteName"
              name="noteName"
              autoFocus
              autoComplete="off"
              placeholder="filename"
              data-testid="note-name-input"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  onCreateNote(event.currentTarget.value);
                }
              }}
            />
            <span className="hint">Enter to create · Esc to cancel</span>
          </div>
        </div>
      )}
    </div>
  );
}
