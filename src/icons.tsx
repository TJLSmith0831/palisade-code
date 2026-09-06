// Row-action icons, re-exported from Tabler so the app has one icon source
// (CLAUDE.md: Mantine components and Tabler icons exclusively). Kept behind
// these names because that's what the call sites already say, and the names
// describe the action rather than the glyph.
import {
  IconPencil,
  IconX,
  IconFilePlus,
  IconFolderPlus,
  IconFile,
  IconFileTypeCss,
  IconFileTypeHtml,
  IconFileTypeJs,
  IconFileTypeJsx,
  IconFileTypeTs,
  IconFileTypeTsx,
  IconFileTypeVue,
  IconFileTypePhp,
  IconFileTypeRs,
  IconFileTypeSql,
  IconFileTypeXml,
  IconFileTypeSvg,
  IconFileTypePng,
  IconFileTypeJpg,
  IconFileTypeBmp,
  IconFileTypePdf,
  IconFileTypeZip,
  IconFileTypeDoc,
  IconFileTypeDocx,
  IconFileTypeXls,
  IconFileTypePpt,
  IconFileTypeTxt,
  IconFileTypeCsv,
  IconJson,
  IconMarkdown,
  IconBrandPython,
  IconBrandGolang,
  IconBrandDocker,
  IconTerminal2,
  IconSettings,
  IconPhoto,
  IconLock,
  type Icon,
} from "@tabler/icons-react";

/** Matches the previous hand-rolled family: 14px, 1.5 stroke. */
const props = { size: 14, stroke: 1.5, "aria-hidden": true } as const;

export const RenameIcon = () => <IconPencil {...props} />;
export const DeleteIcon = () => <IconX {...props} />;
export const NewFileIcon = () => <IconFilePlus {...props} />;
export const NewFolderIcon = () => <IconFolderPlus {...props} />;

// Conventional per-language brand colors, applied to Tabler's outline icons
// (which otherwise render in currentColor) so the tree reads like a real IDE
// file browser at a glance. Extension keys are lowercase, no leading dot.
const FILE_TYPES: Record<string, { icon: Icon; color: string }> = {
  js: { icon: IconFileTypeJs, color: "#f0db4f" },
  mjs: { icon: IconFileTypeJs, color: "#f0db4f" },
  cjs: { icon: IconFileTypeJs, color: "#f0db4f" },
  jsx: { icon: IconFileTypeJsx, color: "#61dafb" },
  ts: { icon: IconFileTypeTs, color: "#3178c6" },
  tsx: { icon: IconFileTypeTsx, color: "#3178c6" },
  vue: { icon: IconFileTypeVue, color: "#42b883" },
  py: { icon: IconBrandPython, color: "#3776ab" },
  rs: { icon: IconFileTypeRs, color: "#ce422b" },
  go: { icon: IconBrandGolang, color: "#00add8" },
  php: { icon: IconFileTypePhp, color: "#787cb5" },
  html: { icon: IconFileTypeHtml, color: "#e34c26" },
  htm: { icon: IconFileTypeHtml, color: "#e34c26" },
  css: { icon: IconFileTypeCss, color: "#264de4" },
  scss: { icon: IconFileTypeCss, color: "#cc6699" },
  sass: { icon: IconFileTypeCss, color: "#cc6699" },
  json: { icon: IconJson, color: "#8a8a8a" },
  md: { icon: IconMarkdown, color: "#8a8a8a" },
  mdx: { icon: IconMarkdown, color: "#8a8a8a" },
  sql: { icon: IconFileTypeSql, color: "#8a8a8a" },
  xml: { icon: IconFileTypeXml, color: "#e37933" },
  svg: { icon: IconFileTypeSvg, color: "#ffb13b" },
  png: { icon: IconFileTypePng, color: "#a78bfa" },
  jpg: { icon: IconFileTypeJpg, color: "#a78bfa" },
  jpeg: { icon: IconFileTypeJpg, color: "#a78bfa" },
  gif: { icon: IconPhoto, color: "#a78bfa" },
  webp: { icon: IconPhoto, color: "#a78bfa" },
  bmp: { icon: IconFileTypeBmp, color: "#a78bfa" },
  pdf: { icon: IconFileTypePdf, color: "#e5484d" },
  zip: { icon: IconFileTypeZip, color: "#8a8a8a" },
  gz: { icon: IconFileTypeZip, color: "#8a8a8a" },
  tar: { icon: IconFileTypeZip, color: "#8a8a8a" },
  doc: { icon: IconFileTypeDoc, color: "#2b579a" },
  docx: { icon: IconFileTypeDocx, color: "#2b579a" },
  xls: { icon: IconFileTypeXls, color: "#217346" },
  xlsx: { icon: IconFileTypeXls, color: "#217346" },
  ppt: { icon: IconFileTypePpt, color: "#d24726" },
  pptx: { icon: IconFileTypePpt, color: "#d24726" },
  txt: { icon: IconFileTypeTxt, color: "#8a8a8a" },
  csv: { icon: IconFileTypeCsv, color: "#8a8a8a" },
  sh: { icon: IconTerminal2, color: "#8a8a8a" },
  bash: { icon: IconTerminal2, color: "#8a8a8a" },
  zsh: { icon: IconTerminal2, color: "#8a8a8a" },
  yml: { icon: IconSettings, color: "#8a8a8a" },
  yaml: { icon: IconSettings, color: "#8a8a8a" },
  toml: { icon: IconSettings, color: "#8a8a8a" },
  ini: { icon: IconSettings, color: "#8a8a8a" },
  env: { icon: IconLock, color: "#8a8a8a" },
  lock: { icon: IconLock, color: "#8a8a8a" },
  dockerfile: { icon: IconBrandDocker, color: "#2496ed" },
};

/** Extension-based file icon, colored like a real IDE would. Falls back to a
 * plain outline file icon in the current (muted) text color for anything
 * unrecognized, so unknown types never look broken. */
export const FileTypeIcon = ({ name }: { name: string }) => {
  const dot = name.lastIndexOf(".");
  const ext = dot === -1 ? name.toLowerCase() : name.slice(dot + 1).toLowerCase();
  const match = FILE_TYPES[ext];
  if (!match) return <IconFile {...props} />;
  const Icon = match.icon;
  return <Icon {...props} color={match.color} />;
};
