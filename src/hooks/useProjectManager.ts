import { useCallback, useMemo, useState } from "react";
import * as api from "../api";
import type { Mode, Project, ThreadMeta } from "../api";

export function useProjectManager() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [threads, setThreads] = useState<ThreadMeta[]>([]);
  const [thread, setThread] = useState<ThreadMeta | null>(null);
  const [branches, setBranches] = useState<api.BranchInfo[]>([]);
  const [changeComplete, setChangeComplete] = useState<boolean | null>(null);
  const [specLinkChoice, setSpecLinkChoice] =
    useState<api.SpecLinkAmbiguous | null>(null);

  const refreshBranches = useCallback(async (projectHash: string) => {
    try {
      const list = await api.gitBranches(projectHash);
      setBranches(list);
    } catch {
      setBranches([]);
    }
  }, []);

  const createThread = useCallback(
    async (projectHash: string, title: string) => {
      const created = await api.createThread(projectHash, title);
      setThreads((prev) => [...prev, created]);
      return created;
    },
    []
  );

  const renameThread = useCallback(
    async (projectHash: string, threadId: string, title: string) => {
      const updated = await api.renameThread(projectHash, threadId, title);
      setThreads((prev) => prev.map((t) => (t.id === threadId ? updated : t)));
      if (thread?.id === threadId) {
        setThread(updated);
      }
    },
    [thread?.id]
  );

  const deleteThread = useCallback(
    async (projectHash: string, threadId: string) => {
      await api.deleteThread(projectHash, threadId);
      setThreads((prev) => prev.filter((t) => t.id !== threadId));
      if (thread?.id === threadId) {
        setThread(null);
      }
    },
    [thread?.id]
  );

  const setThreadMode = useCallback(
    async (projectHash: string, threadId: string, mode: Mode) => {
      const updated = await api.setThreadMode(projectHash, threadId, mode);
      setThreads((prev) => prev.map((t) => (t.id === threadId ? updated : t)));
      if (thread?.id === threadId) {
        setThread(updated);
      }
    },
    [thread?.id]
  );

  const setThreadExecutor = useCallback(
    async (
      projectHash: string,
      threadId: string,
      agentId: string,
      model: string | null
    ) => {
      const updated = await api.setThreadExecutor(
        projectHash,
        threadId,
        agentId,
        model
      );
      setThreads((prev) => prev.map((t) => (t.id === threadId ? updated : t)));
      if (thread?.id === threadId) {
        setThread(updated);
      }
    },
    [thread?.id]
  );

  return useMemo(
    () => ({
      projects,
      setProjects,
      project,
      setProject,
      threads,
      setThreads,
      thread,
      setThread,
      branches,
      setBranches,
      changeComplete,
      setChangeComplete,
      specLinkChoice,
      setSpecLinkChoice,
      refreshBranches,
      createThread,
      renameThread,
      deleteThread,
      setThreadMode,
      setThreadExecutor,
    }),
    [
      projects,
      project,
      threads,
      thread,
      branches,
      changeComplete,
      specLinkChoice,
      refreshBranches,
      createThread,
      renameThread,
      deleteThread,
      setThreadMode,
      setThreadExecutor,
    ]
  );
}

export type ProjectManager = ReturnType<typeof useProjectManager>;
