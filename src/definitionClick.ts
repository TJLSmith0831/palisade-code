import { EditorView } from "@codemirror/view";
import { jumpToDefinition } from "@codemirror/lsp-client";

// `@codemirror/lsp-client`'s `languageServerExtensions()` only binds F12 to
// jumpToDefinition — Cmd/Ctrl-click doesn't exist upstream, so it's built
// here on top of the same command. Harmless with no LSP client attached:
// jumpToDefinition just returns false.

const MODIFIER_CLASS = "cm-definition-modifier";

const isDefinitionModifier = (event: KeyboardEvent | MouseEvent) =>
  navigator.platform.startsWith("Mac") ? event.metaKey : event.ctrlKey;

/** Cmd (macOS) / Ctrl (elsewhere) + click jumps to the definition of the
 *  symbol under the pointer, and shows a pointer cursor while the modifier
 *  is held — the same affordance every IDE gives this gesture. */
export function definitionClick() {
  return EditorView.domEventHandlers({
    keydown(event, view) {
      if (isDefinitionModifier(event)) view.dom.classList.add(MODIFIER_CLASS);
    },
    keyup(event, view) {
      if (!isDefinitionModifier(event))
        view.dom.classList.remove(MODIFIER_CLASS);
    },
    blur(_event, view) {
      view.dom.classList.remove(MODIFIER_CLASS);
    },
    mousedown(event, view) {
      if (!isDefinitionModifier(event) || event.button !== 0) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return false;
      event.preventDefault();
      view.dispatch({ selection: { anchor: pos } });
      jumpToDefinition(view);
      return true;
    },
  });
}
