import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import MDEditor from "@uiw/react-md-editor";
import "@uiw/react-md-editor/markdown-editor.css";
import "@uiw/react-markdown-preview/markdown.css";

import * as api from "./api";
import type { Message, Mode, Project, ThreadMeta } from "./api";
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

  const fail = (err: unknown) => setError(String(err));

  const selectThread = useCallback(async (projectHash: string, next: ThreadMeta | null) => {
    setThread(next);
    if (!next) {
      setMessages([]);
      return;
    }
    localStorage.setItem(lastThreadKey(projectHash), next.id);
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

  const onToggleMode = async () => {
    if (!project || !thread) return;
    const next: Mode = thread.currentMode === "spec" ? "go" : "spec";
    try {
      const updated = await api.setThreadMode(project.hash, thread.id, next);
      setThread(updated);
      setThreads(await api.listThreads(project.hash));
      setMessages(await api.readThread(project.hash, thread.id));
    } catch (err) {
      fail(err);
    }
  };

  const onSend = async () => {
    if (!project || !thread || !draft.trim()) return;
    try {
      await api.appendMessage(project.hash, thread.id, "user", thread.currentMode, draft.trim());
      setDraft("");
      setMessages(await api.readThread(project.hash, thread.id));
    } catch (err) {
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
      </header>

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
                <div className="spacer" />
                <button
                  className={`mode ${thread.currentMode}`}
                  onClick={onToggleMode}
                  data-testid="mode-toggle"
                >
                  {thread.currentMode} mode
                </button>
              </div>
              <div className="messages" data-testid="messages">
                {messages.length === 0 && <p className="empty">No messages yet.</p>}
                {messages.map((m) => (
                  <div key={m.seq} className={`message ${m.role}`}>
                    <span className="meta">
                      {m.role} · {m.mode}
                    </span>
                    <div className="content">{m.content}</div>
                  </div>
                ))}
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
                  placeholder="Write a message…"
                  data-testid="composer-input"
                />
                <button type="submit" data-testid="composer-send">
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
