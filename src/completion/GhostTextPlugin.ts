import { StateEffect, StateField, Transaction } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
  keymap,
} from "@codemirror/view";
import * as api from "../api";
import {
  recordAccepted,
  recordDismissed,
  recordLatency,
  recordShown,
  recordTypedPast,
} from "./telemetry";

const GHOST_TEXT_CLASS = "cm-ghostText";

// D1: 1250ms trailing-edge debounce (amended from 3000ms after live
// tuning). The 0.8B model's low-quality suggestions on every micro-pause
// (150ms, D14) disrupted coding flow; 1250ms gives space to finish a
// thought without the model feeling absent.
const DEBOUNCE_MS = 1250;
export const PREFIX_BUDGET_CHARS = 1024; // 256 tokens * 4 chars/token
export const SUFFIX_BUDGET_CHARS = 512; // 128 tokens * 4 chars/token

export const COMPLETION_ENABLED_KEY = "palisade:completionEnabled";
export const COMPLETION_KEYBINDING_KEY = "palisade:completionKeybinding";
export const COMPLETION_SETTINGS_CHANGED_EVENT =
  "palisade:completion-settings-changed";

export function loadCompletionSettings(): FimSettings {
  const enabled = localStorage.getItem(COMPLETION_ENABLED_KEY) !== "false";
  // Tab by default: it is what Cursor, Copilot and every other ghost-text
  // implementation uses, and reaching for Alt-Tab on a suggestion you are
  // already looking at is the thing that makes completion feel foreign.
  // Safe because `acceptGhostText` declines when nothing is suggested, so
  // Tab falls through to `indentWithTab`.
  const acceptKeybinding =
    localStorage.getItem(COMPLETION_KEYBINDING_KEY) || "Tab";
  return { enabled, acceptKeybinding };
}

/** Turns FIM on or off everywhere: the stored setting, the backend, and
 *  every mounted editor (which reconfigures on the change event). The one
 *  persistence path — Settings and the editor status bar both call this
 *  rather than each writing their own copy. */
export async function persistCompletionEnabled(
  enabled: boolean,
  sync: (enabled: boolean) => Promise<unknown>
): Promise<void> {
  localStorage.setItem(COMPLETION_ENABLED_KEY, String(enabled));
  window.dispatchEvent(new Event(COMPLETION_SETTINGS_CHANGED_EVENT));
  await sync(enabled).catch(() => {
    // Best-effort backend sync: the local setting is what the editor reads,
    // so a failed round-trip must not leave the toggle lying about its state.
  });
}

/** What the sidecar thinks should go in next. */
interface GhostText {
  text: string;
  from: number;
  keybinding: string;
}

export interface FimSettings {
  enabled: boolean;
  acceptKeybinding: string;
}

export const setGhostText = StateEffect.define<GhostText | null>();

/** State field storing the current ghost text (or null). */
export const ghostTextState = StateField.define<GhostText | null>({
  create: () => null,
  update: (value, tr) => {
    for (const e of tr.effects) {
      if (e.is(setGhostText)) {
        const next = e.value;
        if (!value && next) recordShown();
        value = next;
      }
    }
    if (value && tr.docChanged) {
      const mapped = tr.changes.mapPos(value.from, 1);
      if (tr.changes.touchesRange(value.from, value.from + value.text.length)) {
        recordTypedPast();
        value = null;
      } else {
        value = { ...value, from: mapped };
      }
    }
    return value;
  },
});

/** Widget that renders the greyed completion text after the cursor. */
export class GhostTextWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly keybinding: string
  ) {
    super();
  }

  toDOM() {
    // Multi-line completions (e.g. "\n    ZZZZ" after a Python `else:`) need
    // inline (not inline-flex) so the inner span's white-space: pre renders
    // \n as visual line breaks. inline-flex lays out children in a single
    // row and swallows newlines.
    const isMultiLine = this.text.includes("\n");
    const container = document.createElement("span");
    container.style.display = isMultiLine ? "inline" : "inline-flex";
    if (!isMultiLine) {
      container.style.alignItems = "center";
      container.style.gap = "4px";
    }

    // Hint first so it sits right after the user's typed text, before the
    // ghost completion — not trailing the whole ghost block.
    const hint = document.createElement("span");
    hint.textContent =
      this.keybinding === "Alt-Tab"
        ? "⌥⇥"
        : this.keybinding === "Tab"
          ? "⇥"
          : this.keybinding;
    hint.style.opacity = "0.4";
    hint.style.fontSize = "0.75em";
    hint.style.pointerEvents = "none";
    hint.style.userSelect = "none";
    hint.style.marginRight = "2px";
    // Lift the hint so it stays visible on the first line when the completion
    // starts with a newline (otherwise it would render below the break).
    if (isMultiLine) hint.style.verticalAlign = "super";
    container.appendChild(hint);

    const span = document.createElement("span");
    span.textContent = this.text;
    span.className = GHOST_TEXT_CLASS;
    span.setAttribute("aria-hidden", "true");
    span.style.opacity = "0.55";
    span.style.pointerEvents = "none";
    span.style.whiteSpace = "pre";
    container.appendChild(span);

    return container;
  }

  eq(other: GhostTextWidget) {
    return this.text === other.text && this.keybinding === other.keybinding;
  }
}

/** Compute the inline ghost-text decoration from the state field. */
const ghostTextDecorations = EditorView.decorations.compute(
  [ghostTextState],
  (state) => {
    const ghost = state.field(ghostTextState);
    if (!ghost || !ghost.text) return Decoration.none;
    const deco = Decoration.widget({
      side: 1,
      widget: new GhostTextWidget(ghost.text, ghost.keybinding),
      block: false,
    });
    return Decoration.set([deco.range(ghost.from)]);
  }
);

/** Extract prefix/suffix around the cursor, limited to the token budget. */
export function extractContext(view: EditorView): {
  prefix: string;
  suffix: string;
  pos: number;
} {
  const state = view.state;
  const pos = state.selection.main.head;
  const prefix = state.doc.sliceString(
    Math.max(0, pos - PREFIX_BUDGET_CHARS),
    pos
  );
  const suffix = state.doc.sliceString(
    pos,
    Math.min(state.doc.length, pos + SUFFIX_BUDGET_CHARS)
  );
  return { prefix, suffix, pos };
}

/**
 * Strip the leading portion of `completion` that duplicates the end of
 * `prefix`.
 *
 * FIM models often regenerate the word the user just typed (prefix ends with
 * "from", completion starts with "from ..."). Without stripping, accepting
 * would double the word ("fromfrom ..."). We find the longest suffix of the
 * prefix's last whitespace-delimited word that is also a prefix of the
 * completion's first whitespace-delimited word, and remove that overlap from
 * the start of the completion.
 *
 * When the prefix ends in whitespace and the overlap is immediately followed
 * by whitespace in the completion, one of those whitespace chars is stripped
 * too, so "import " + "import os" yields "import os" rather than "import  os".
 */
export function stripStarterOverlap(
  prefix: string,
  completion: string
): string {
  if (!completion || !prefix) return completion;

  const prefixEndsWithWs = /\s$/.test(prefix);
  const trimmedPrefix = prefix.replace(/\s+$/, "");
  if (!trimmedPrefix) return completion;

  // D11: if the prefix ends with non-newline whitespace and the completion
  // starts with whitespace, the model regenerated whitespace the user
  // already typed. Strip it before word-overlap detection so the ghost
  // text continues right at the cursor. When the prefix ends with a
  // newline, the completion's leading whitespace is the new line's indent
  // — preserve it.
  let result = completion;
  if (prefixEndsWithWs && !/\n$/.test(prefix) && /^\s/.test(result)) {
    result = result.replace(/^\s+/, "");
  }

  const lastWs = trimmedPrefix.search(/\s[^\s]*$/);
  const lastWord =
    lastWs === -1 ? trimmedPrefix : trimmedPrefix.slice(lastWs + 1);
  if (!lastWord) return result;

  const firstWs = result.search(/\s/);
  const firstWord = firstWs === -1 ? result : result.slice(0, firstWs);
  if (!firstWord) return result;

  const max = Math.min(lastWord.length, firstWord.length);
  let overlap = 0;
  for (let len = 1; len <= max; len++) {
    if (lastWord.endsWith(firstWord.slice(0, len))) overlap = len;
  }
  if (overlap === 0) return result;

  let stripLen = overlap;
  if (prefixEndsWithWs && /\s/.test(result[overlap] ?? "")) {
    stripLen += 1;
  }
  return result.slice(stripLen);
}

/** Insert the ghost text at the cursor and clear it. */
export function acceptGhostText(view: EditorView): boolean {
  const ghost = view.state.field(ghostTextState);
  if (!ghost) return false;

  recordAccepted();
  view.dispatch({
    changes: { from: ghost.from, to: ghost.from, insert: ghost.text },
    selection: { anchor: ghost.from + ghost.text.length },
    effects: setGhostText.of(null),
    userEvent: "ghost.accept",
  });
  return true;
}

/** Clear the ghost text without inserting it. */
export function dismissGhostText(view: EditorView): boolean {
  const ghost = view.state.field(ghostTextState);
  if (!ghost) return false;
  recordDismissed();
  view.dispatch({ effects: setGhostText.of(null) });
  return true;
}

class FimViewPlugin {
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private controller: AbortController | null = null;
  private settings: FimSettings;
  private projectHash: string;
  private filePath: string;

  constructor(
    _view: EditorView,
    settings: FimSettings,
    projectHash: string,
    filePath: string
  ) {
    this.settings = settings;
    this.projectHash = projectHash;
    this.filePath = filePath;
  }

  update(update: ViewUpdate) {
    if (update.docChanged) {
      // Trigger on any user-initiated edit (typing, Enter, backspace, paste),
      // but not programmatic changes like saves. CodeMirror sets a userEvent
      // annotation for user actions; programmatic changes have none.
      if (
        update.transactions.some(
          (tr) => tr.annotation(Transaction.userEvent) !== undefined
        )
      ) {
        this.cancel();
        this.schedule(update.view);
      }
    }

    if (update.selectionSet) {
      const ghost = update.state.field(ghostTextState);
      if (ghost && update.state.selection.main.head !== ghost.from) {
        const view = update.view;
        setTimeout(() => {
          // Dismiss only if the same ghost is still shown after the update.
          const current = view.state.field(ghostTextState);
          if (current && current.from === ghost.from) {
            view.dispatch({ effects: setGhostText.of(null) });
          }
        }, 0);
      }
    }
  }

  private schedule(view: EditorView) {
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = setTimeout(() => this.request(view), DEBOUNCE_MS);
  }

  private cancel() {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
    }
  }

  private async request(view: EditorView) {
    if (!this.settings.enabled) return;
    this.cancel();

    const { prefix, suffix, pos } = extractContext(view);
    // Capture the controller locally so we can check if THIS request was
    // aborted after the await resolves. this.controller is replaced by the
    // next request's controller, so checking it would test the wrong one.
    const controller = new AbortController();
    this.controller = controller;

    try {
      const res = await api.completeCode(
        this.projectHash,
        this.filePath,
        prefix,
        suffix
      );
      recordLatency(res.modelLatencyMs);
      // D7: drop stale results if a new keystroke aborted this request.
      // The cursor-position check below catches cursor moves, but a
      // type-then-backspace cycle can return the cursor to the same
      // position with stale context — only the abort check catches that.
      if (controller.signal.aborted) return;
      // Ignore stale responses for a cursor that has moved.
      if (view.state.selection.main.head !== pos) return;
      if (res.completion) {
        const text = stripStarterOverlap(prefix, res.completion);
        if (!text) return;
        view.dispatch({
          effects: setGhostText.of({
            text,
            from: pos,
            keybinding: this.settings.acceptKeybinding,
          }),
        });
      }
    } catch {
      // Graceful degradation: no ghost text on error.
    }
  }
}

export function fimCompletion(
  settings: FimSettings,
  projectHash: string,
  filePath: string
) {
  const plugin = ViewPlugin.define(
    (view) => new FimViewPlugin(view, settings, projectHash, filePath)
  );

  const acceptKey =
    settings.acceptKeybinding === "Option-Tab" ||
    settings.acceptKeybinding === "Alt-Tab"
      ? "Alt-Tab"
      : settings.acceptKeybinding;
  // Escape dismisses; Tab (or the chosen key) accepts.

  return [
    ghostTextState,
    ghostTextDecorations,
    plugin,
    keymap.of([
      { key: acceptKey, run: acceptGhostText },
      { key: "Escape", run: dismissGhostText },
    ]),
    EditorView.theme({
      [`.${GHOST_TEXT_CLASS}`]: {
        color: "var(--code-comment, #888)",
        opacity: "0.55",
      },
    }),
  ];
}
