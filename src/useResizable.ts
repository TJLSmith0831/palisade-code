import { useCallback, useRef, useState } from "react";

interface Persisted {
  size: number;
  collapsed: boolean;
}

export interface UseResizableOptions {
  storageKey: string;
  defaultSize: number;
  min: number;
  max: number;
  axis: "horizontal" | "vertical";
  /** Pointer moving toward the panel's outer edge should shrink it (e.g. a right sidebar dragged from its left border). */
  reverse?: boolean;
  defaultCollapsed?: boolean;
}

export interface UseResizableResult {
  size: number;
  collapsed: boolean;
  toggleCollapsed: () => void;
  setCollapsed: (next: boolean) => void;
  handleProps: {
    onPointerDown: (e: Pick<PointerEvent, "clientX" | "clientY">) => void;
    onPointerMove: (e: Pick<PointerEvent, "clientX" | "clientY">) => void;
    onPointerUp: () => void;
  };
}

const load = (
  storageKey: string,
  defaultSize: number,
  defaultCollapsed: boolean,
  min: number,
  max: number,
): Persisted => {
  const raw = localStorage.getItem(storageKey);
  if (!raw) return { size: defaultSize, collapsed: defaultCollapsed };
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.size === "number" && typeof parsed.collapsed === "boolean") {
      // Clamp on read: a size saved under an older, looser min would
      // otherwise stick forever — which is how a chat pane saved at 270px
      // kept clipping its own send button after the floor was raised.
      return { ...parsed, size: Math.min(max, Math.max(min, parsed.size)) };
    }
  } catch {
    // fall through to default
  }
  return { size: defaultSize, collapsed: defaultCollapsed };
};

export function useResizable(options: UseResizableOptions): UseResizableResult {
  const { storageKey, defaultSize, min, max, axis, reverse, defaultCollapsed = false } = options;
  const [state, setState] = useState<Persisted>(() =>
    load(storageKey, defaultSize, defaultCollapsed, min, max),
  );
  const drag = useRef<{ start: number; startSize: number } | null>(null);

  // storageKey changes when the active project changes (`palisade:layout:<hash>:...`).
  // Reset synchronously during render (not in a useEffect) so a project switch
  // can't race an in-flight drag/toggle that lands between commit and effect.
  const prevKey = useRef(storageKey);
  if (prevKey.current !== storageKey) {
    prevKey.current = storageKey;
    setState(load(storageKey, defaultSize, defaultCollapsed, min, max));
  }

  const persist = useCallback(
    (next: Persisted) => {
      localStorage.setItem(storageKey, JSON.stringify(next));
    },
    [storageKey],
  );

  const onPointerDown = useCallback(
    (e: Pick<PointerEvent, "clientX" | "clientY">) => {
      drag.current = { start: axis === "horizontal" ? e.clientX : e.clientY, startSize: state.size };
    },
    [axis, state.size],
  );

  const onPointerMove = useCallback(
    (e: Pick<PointerEvent, "clientX" | "clientY">) => {
      if (!drag.current) return;
      const pos = axis === "horizontal" ? e.clientX : e.clientY;
      const delta = pos - drag.current.start;
      const raw = drag.current.startSize + (reverse ? -delta : delta);
      const clamped = Math.min(max, Math.max(min, raw));
      setState((prev) => ({ ...prev, size: clamped }));
    },
    [axis, max, min, reverse],
  );

  const onPointerUp = useCallback(() => {
    if (!drag.current) return;
    drag.current = null;
    setState((prev) => {
      persist(prev);
      return prev;
    });
  }, [persist]);

  const toggleCollapsed = useCallback(() => {
    setState((prev) => {
      const next = { ...prev, collapsed: !prev.collapsed };
      persist(next);
      return next;
    });
  }, [persist]);

  const setCollapsed = useCallback(
    (next: boolean) => {
      setState((prev) => {
        if (prev.collapsed === next) return prev;
        const updated = { ...prev, collapsed: next };
        persist(updated);
        return updated;
      });
    },
    [persist],
  );

  return {
    size: state.size,
    collapsed: state.collapsed,
    toggleCollapsed,
    setCollapsed,
    handleProps: { onPointerDown, onPointerMove, onPointerUp },
  };
}
