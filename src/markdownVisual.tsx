import { useEffect, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IconCode, IconPhoto } from "@tabler/icons-react";
import MDEditor from "@uiw/react-md-editor";
import { markdownLanguage } from "@codemirror/lang-markdown";
import { StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { defaultSchema } from "rehype-sanitize";
import rehypeSanitize from "rehype-sanitize";
import * as api from "./api";
import { mimeTypeFor } from "./codeLanguage";

export const markdownPreviewSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: ["className"],
    span: ["className"],
    pre: ["className"],
  },
};

type EditSource = (from: number, to: number, label: string) => void;
type Cell = { from: number; to: number; value: string };
const roots = new WeakMap<HTMLElement, Root>();
const imageCache = new Map<string, string>();

function projectImagePath(url: string, filePath: string): string | null {
  if (/^(?:[a-z][a-z\d+.-]*:|#)/i.test(url)) return null;
  try {
    const resolved = new URL(url, `https://project.local/${filePath}`);
    return resolved.hostname === "project.local" ? decodeURIComponent(resolved.pathname.slice(1)) : null;
  } catch {
    return null;
  }
}

function RenderedMarkdown({ source, projectHash, filePath }: { source: string; projectHash: string; filePath: string }) {
  const [images, setImages] = useState<Record<string, string>>({});
  useEffect(() => {
    let active = true;
    const urls = [...source.matchAll(/!\[[^\]]*\]\(([^)]+)\)|<img\b[^>]*\bsrc=["']([^"']+)["']/gi)]
      .map((match) => match[1] ?? match[2]);
    for (const url of urls) {
      const imagePath = projectImagePath(url, filePath);
      if (!imagePath) continue;
      const key = `${projectHash}:${imagePath}`;
      const cached = imageCache.get(key);
      if (cached) {
        setImages((current) => ({ ...current, [url]: cached }));
        continue;
      }
      void api.readFileBase64(projectHash, imagePath).then((base64) => {
        const data = `data:${mimeTypeFor(imagePath)};base64,${base64}`;
        if (imageCache.size >= 16) imageCache.delete(imageCache.keys().next().value!);
        imageCache.set(key, data);
        if (active) setImages((current) => ({ ...current, [url]: data }));
      }).catch(() => {});
    }
    return () => { active = false; };
  }, [source, projectHash, filePath]);
  return <MDEditor.Markdown source={source} rehypePlugins={[[rehypeSanitize, markdownPreviewSchema]]} urlTransform={(url) => {
    if (/^[a-z][a-z\d+.-]*:/i.test(url) && !/^(?:https?:|mailto:|tel:)/i.test(url)) return "";
    const imagePath = projectImagePath(url, filePath);
    return imagePath && /\.(?:png|jpe?g|gif|webp|svg|avif)(?:#.*)?$/i.test(url) ? images[url] ?? "" : url;
  }} />;
}

function renderInto(dom: HTMLElement, content: ReactNode) {
  let root = roots.get(dom);
  if (!root) {
    root = createRoot(dom);
    roots.set(dom, root);
  }
  root.render(content);
}

function tableRows(source: string, from: number): Cell[][] {
  let offset = from;
  return source.split("\n").flatMap((line, row) => {
    const start = offset;
    offset += line.length + 1;
    if (row === 1 && /^\s*\|?[\s:|-]+\|?\s*$/.test(line)) return [];
    const cells: Cell[] = [];
    let local = 0;
    const parts = line.split(/(?<!\\)\|/);
    for (let index = 0; index < parts.length; index++) {
      const raw = parts[index];
      const segment = local;
      local += raw.length + 1;
      if ((index === 0 && line.startsWith("|")) || (index === parts.length - 1 && line.endsWith("|"))) continue;
      const left = raw.length - raw.trimStart().length;
      const right = raw.trimEnd().length;
      cells.push({ from: start + segment + left, to: start + segment + right, value: raw.trim().replace(/\\\|/g, "|") });
    }
    return cells.length ? [cells] : [];
  });
}

class RichWidget extends WidgetType {
  constructor(
    readonly kind: "table" | "html" | "image",
    readonly source: string,
    readonly from: number,
    readonly to: number,
    readonly editSource: EditSource,
    readonly projectHash: string,
    readonly filePath: string
  ) { super(); }

  toDOM(view: EditorView) {
    const dom = document.createElement("div");
    dom.className = `ds-md-widget ds-md-${this.kind}`;
    this.draw(dom, view);
    return dom;
  }

  updateDOM(dom: HTMLElement, view: EditorView) {
    dom.className = `ds-md-widget ds-md-${this.kind}`;
    this.draw(dom, view);
    return true;
  }

  ignoreEvent() { return true; }

  destroy(dom: HTMLElement) {
    const root = roots.get(dom);
    if (root) queueMicrotask(() => root.unmount());
    roots.delete(dom);
  }

  private draw(dom: HTMLElement, view: EditorView) {
    if (this.kind === "table") {
      const rows = tableRows(this.source, this.from);
      renderInto(dom, <div className="ds-md-table-scroll"><table aria-label="Markdown table"><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => {
        const CellTag = rowIndex === 0 ? "th" : "td";
        return <CellTag key={cellIndex}><input aria-label={`Row ${rowIndex + 1}, column ${cellIndex + 1}`} value={cell.value} onChange={(event) => {
          const next = event.target.value.replace(/\|/g, "\\|").replace(/[\r\n]/g, " ");
          view.dispatch({ changes: { from: cell.from, to: cell.to, insert: next } });
        }} /></CellTag>;
      })}</tr>)}</tbody></table></div>);
      return;
    }
    const edit = () => this.editSource(this.from, this.to, this.kind === "html" ? "Edit HTML" : "Edit image Markdown");
    const unsafeHtml = this.kind === "html" && /<(?:script|iframe|style|form|object|embed)\b|\bon\w+\s*=/i.test(this.source);
    renderInto(dom, <div className="ds-md-rendered-block" onClick={(event) => {
      if (!(event.target as Element).closest("a, button, input")) edit();
    }}>{unsafeHtml ? <div className="ds-md-source-fallback"><span>This HTML is shown as source for safety.</span><pre>{this.source}</pre></div> : <RenderedMarkdown source={this.source} projectHash={this.projectHash} filePath={this.filePath} />}<button type="button" onClick={edit}>{this.kind === "html" ? <IconCode size={14} /> : <IconPhoto size={14} />}{this.kind === "html" ? "Edit HTML" : "Edit image"}</button></div>);
  }
}

class MarkerWidget extends WidgetType {
  constructor(readonly label: string, readonly checked?: boolean, readonly toggle?: (view: EditorView) => void) { super(); }
  toDOM(view: EditorView) {
    if (this.checked !== undefined) {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = this.checked;
      input.setAttribute("aria-label", this.checked ? "Mark task incomplete" : "Mark task complete");
      input.addEventListener("change", () => this.toggle?.(view));
      return input;
    }
    const span = document.createElement("span");
    span.className = "ds-md-list-marker";
    span.textContent = this.label;
    return span;
  }
  ignoreEvent() { return true; }
}

/** Render Markdown without transforming its bytes. Every edit still changes the
 * ordinary CodeMirror document, so its history, save and conflict path stay
 * authoritative. */
export function markdownVisual(editSource: EditSource, projectHash: string, filePath: string) {
  const decorations = StateField.define<DecorationSet>({
    create: (state) => build(state, editSource, projectHash, filePath),
    update: (value, transaction) => transaction.docChanged ? build(transaction.state, editSource, projectHash, filePath) : value,
    provide: (field) => EditorView.decorations.from(field),
  });
  return [decorations, EditorView.lineWrapping, EditorView.theme({
    "&": { background: "var(--editor-bg)" },
    ".cm-scroller": { fontFamily: "var(--font-sans, system-ui)", lineHeight: "1.7" },
    ".cm-content": { width: "100%", minWidth: "0", maxWidth: "760px", boxSizing: "border-box", margin: "0 auto", padding: "24px 16px 80px", fontSize: "16px" },
    ".cm-gutters": { display: "none" },
  })];
}

function build(state: EditorState, editSource: EditSource, projectHash: string, filePath: string): DecorationSet {
  const source = state.doc.toString();
  const ranges: ReturnType<Decoration["range"]>[] = [];
  const tree = markdownLanguage.parser.parse(source);
  const cursor = tree.cursor();
  let skipTo = -1;
  const replace = (from: number, to: number, widget?: WidgetType, block = false) => {
    if (to > from) ranges.push(Decoration.replace({ widget, block }).range(from, to));
  };
  const mark = (from: number, to: number, className: string) => {
    if (to > from) ranges.push(Decoration.mark({ class: className }).range(from, to));
  };
  do {
    const { name, from, to } = cursor;
    if (from < skipTo) continue;
    if (name === "HTMLBlock" || name === "Table") {
      replace(from, to, new RichWidget(name === "Table" ? "table" : "html", source.slice(from, to), from, to, editSource, projectHash, filePath), true);
      skipTo = to;
      continue;
    }
    if (name === "Image") {
      replace(from, to, new RichWidget("image", source.slice(from, to), from, to, editSource, projectHash, filePath));
      skipTo = to;
      continue;
    }
    if (/^ATXHeading[1-6]$/.test(name)) {
      ranges.push(Decoration.line({ class: `ds-md-heading ds-md-h${name.slice(-1)}` }).range(state.doc.lineAt(from).from));
    } else if (name === "StrongEmphasis") mark(from, to, "ds-md-strong");
    else if (name === "Emphasis") mark(from, to, "ds-md-emphasis");
    else if (name === "Strikethrough") mark(from, to, "ds-md-strike");
    else if (name === "InlineCode") mark(from, to, "ds-md-code");
    else if (name === "Link") mark(from, to, "ds-md-link");
    else if (name === "Blockquote") ranges.push(Decoration.line({ class: "ds-md-quote" }).range(state.doc.lineAt(from).from));
    else if (name === "FencedCode") {
      const first = state.doc.lineAt(from);
      const last = state.doc.lineAt(Math.max(from, to - 1));
      for (let n = first.number; n <= last.number; n++) ranges.push(Decoration.line({ class: "ds-md-fence" }).range(state.doc.line(n).from));
    } else if (name === "TaskMarker") {
      const checked = source.slice(from, to).toLowerCase().includes("x");
      replace(from, to, new MarkerWidget("", checked, (view) => {
        view.dispatch({ changes: { from: from + 1, to: from + 2, insert: checked ? " " : "x" } });
      }));
    } else if (name === "ListMark") {
      const marker = /^\d/.test(source.slice(from, to)) ? source.slice(from, to) + " " : "• ";
      replace(from, Math.min(to + 1, source.length), /^\[[ xX]\]/.test(source.slice(to + 1, to + 4)) ? undefined : new MarkerWidget(marker));
    } else if (["HeaderMark", "EmphasisMark", "StrikethroughMark", "CodeMark", "QuoteMark", "LinkMark", "URL"].includes(name)) {
      replace(from, name === "HeaderMark" || name === "QuoteMark" ? Math.min(to + 1, source.length) : to);
    } else if (name === "CodeInfo") replace(from, to);
  } while (cursor.next());
  return Decoration.set(ranges, true);
}
