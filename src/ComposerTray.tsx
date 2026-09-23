// The strip above a composer's text box: skills picked from the `/` menu,
// images dropped or pasted in, and (on Fleet) other dropped files. Kept out of
// App.tsx so the Fleet composer can carry the same tray without skills.
import { useEffect, useState, type ClipboardEvent } from "react";
import { HoverCard, Image, Skeleton, UnstyledButton } from "@mantine/core";
import {
  IconAlertTriangle,
  IconFile,
  IconPhoto,
  IconPhotoPlus,
  IconWand,
  IconX,
} from "@tabler/icons-react";
import * as api from "./api";
import { shortPath } from "./mentions";
import { bareName, skillTrigger } from "./slashCommands";

/** The image types an agent receives as image blocks — the frontend's copy of
 *  `attachments::mime_for`, which stays the authority (it refuses the rest).
 *  Anything else dropped goes in as an `@path` mention. */
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"];
export const isAttachableImage = (path: string) =>
  IMAGE_EXTENSIONS.includes(path.split(".").pop()?.toLowerCase() ?? "");

const fileName = (path: string) => path.split("/").pop() ?? path;

/** The × on a tray item. Its own control, so it keeps a real focus ring and
 *  a name a screen reader can read, instead of a glyph inside a label. */
function RemoveButton({ label, onClick, testId }: { label: string; onClick: () => void; testId?: string }) {
  return (
    <UnstyledButton className="ds-tray-remove" aria-label={label} onClick={onClick} data-testid={testId}>
      <IconX size={11} stroke={2.25} />
    </UnstyledButton>
  );
}

/** A skill in the tray or on a sent message. Hover shows what it is — the
 *  agent's own description, plus where it lives when it is a user-level
 *  skill Palisade can see on disk — never the skill's full text. */
export function SkillChip({
  name,
  commands,
  installed,
  onRemove,
}: {
  name: string;
  commands: api.AgentCommand[];
  installed: api.Skill[];
  onRemove?: () => void;
}) {
  const command = commands.find((c) => c.name === name);
  const onDisk = installed.find((s) => s.name === bareName(name));
  const description = command?.description || onDisk?.description;
  const label = skillTrigger(name);
  // Only a session that has advertised its list can be said to lack one; an
  // installed skill is available whatever this session has said so far.
  const missing = commands.length > 0 && !command && !onDisk;
  return (
    <HoverCard openDelay={250} closeDelay={80} width={300} shadow="md" withinPortal position="top-start">
      <HoverCard.Target>
        <span
          className="ds-composer-chip ds-tray-item"
          data-kind="skill"
          data-missing={missing || undefined}
          data-testid="composer-chip"
          tabIndex={onRemove ? undefined : 0}
        >
          <IconWand size={12} />
          {label}
          {onRemove && <RemoveButton label={`Remove ${label}`} onClick={onRemove} testId="composer-chip-remove" />}
        </span>
      </HoverCard.Target>
      <HoverCard.Dropdown className="ds-skill-card" data-testid="skill-hovercard">
        <div className="ds-skill-card-head">
          <span className="ds-skill-card-glyph" aria-hidden="true">
            <IconWand size={14} />
          </span>
          <span className="ds-skill-card-name">{bareName(name)}</span>
          <span className="ds-skill-card-source">{onDisk ? "User skill" : "Agent skill"}</span>
        </div>
        <p className="ds-skill-card-desc">{description ?? "This skill has no description."}</p>
        {missing && (
          <p className="ds-skill-card-warn">
            <IconAlertTriangle size={12} />
            Not advertised by this session's agent.
          </p>
        )}
        {onDisk && (
          <p className="ds-skill-card-path" title={onDisk.path}>
            {shortPath(onDisk.path, 48)}
          </p>
        )}
      </HoverCard.Dropdown>
    </HoverCard>
  );
}

/** Loads a stored attachment as a data URL. */
function useAttachmentSrc(projectHash: string | null | undefined, path: string) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!projectHash) return;
    let live = true;
    api.readAttachment(projectHash, path).then(
      (url) => live && setSrc(url),
      () => live && setSrc(null)
    );
    return () => {
      live = false;
    };
  }, [projectHash, path]);
  return src;
}

/** Bytes behind a base64 `data:` URL, as a short human size. */
function dataUrlSize(src: string): string {
  const base64 = src.slice(src.indexOf(",") + 1);
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const bytes = Math.floor((base64.length * 3) / 4) - padding;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** One attached image: a thumbnail, a larger preview on hover, and an ×. */
export function AttachmentThumb({
  projectHash,
  path,
  onRemove,
  noImageSupport = false,
  size = 44,
}: {
  projectHash: string | null | undefined;
  path: string;
  onRemove?: () => void;
  /** The agent never said it takes images — this one goes as a path. */
  noImageSupport?: boolean;
  /** Edge length in px: the tray keeps it compact, a sent turn shows more. */
  size?: number;
}) {
  const src = useAttachmentSrc(projectHash, path);
  const [dims, setDims] = useState<string | null>(null);
  // The stored copy is named by a ULID, which says nothing to a person; the
  // type is what distinguishes one attachment from another at a glance.
  const name = `${(path.split(".").pop() ?? "").toUpperCase()} image`;
  return (
    <HoverCard openDelay={200} closeDelay={80} shadow="md" withinPortal position="top-start">
      <HoverCard.Target>
        <span
          className="ds-attachment ds-tray-item"
          data-testid="attachment-thumb"
          style={{ width: size, height: size }}
          tabIndex={onRemove ? undefined : 0}
          aria-label={name}
        >
          {src ? <Image src={src} alt={name} /> : <Skeleton w={size} h={size} radius={6} />}
          {noImageSupport && (
            <span className="ds-attachment-warn" aria-label="Sent as a path">
              <IconAlertTriangle size={11} />
            </span>
          )}
          {onRemove && <RemoveButton label={`Remove ${name}`} onClick={onRemove} testId="attachment-remove" />}
        </span>
      </HoverCard.Target>
      <HoverCard.Dropdown className="ds-image-card">
        {src ? (
          <Image
            src={src}
            alt={name}
            onLoad={(e) => setDims(`${e.currentTarget.naturalWidth}×${e.currentTarget.naturalHeight}`)}
          />
        ) : (
          <IconPhoto size={24} />
        )}
        <div className="ds-image-card-meta" title={path}>
          <span className="ds-image-card-name">{name}</span>
          {src && <span>{[dims, dataUrlSize(src)].filter(Boolean).join(" · ")}</span>}
        </div>
        {noImageSupport && (
          <p className="ds-skill-card-warn">
            <IconAlertTriangle size={12} />
            This agent can't see images; it gets the file path instead.
          </p>
        )}
      </HoverCard.Dropdown>
    </HoverCard>
  );
}

/** A dropped non-image file waiting to go as an `@path` mention. */
function FileChip({ path, onRemove }: { path: string; onRemove?: () => void }) {
  return (
    <span className="ds-composer-chip ds-tray-item" data-kind="file" title={path} data-testid="file-chip">
      <IconFile size={12} />
      {fileName(path)}
      {onRemove && <RemoveButton label={`Remove ${fileName(path)}`} onClick={onRemove} />}
    </span>
  );
}

/** The skills-and-images strip. Renders nothing when it has nothing. */
export function ComposerTray({
  projectHash,
  skills = [],
  attachments,
  files = [],
  commands = [],
  installed = [],
  noImageSupport = false,
  onRemoveSkill,
  onRemoveAttachment,
  onRemoveFile,
}: {
  projectHash: string | null | undefined;
  skills?: string[];
  attachments: string[];
  /** Non-image files dropped on a composer that has no text mentions of its
   *  own to put them in (Fleet); sent as `@path` mentions. */
  files?: string[];
  onRemoveFile?: (path: string) => void;
  commands?: api.AgentCommand[];
  installed?: api.Skill[];
  noImageSupport?: boolean;
  onRemoveSkill?: (name: string) => void;
  onRemoveAttachment: (path: string) => void;
}) {
  if (skills.length === 0 && attachments.length === 0 && files.length === 0) return null;
  return (
    <div className="ds-composer-tray" data-testid="composer-tray">
      {skills.map((name) => (
        <SkillChip
          key={name}
          name={name}
          commands={commands}
          installed={installed}
          onRemove={onRemoveSkill && (() => onRemoveSkill(name))}
        />
      ))}
      {attachments.map((path) => (
        <AttachmentThumb
          key={path}
          projectHash={projectHash}
          path={path}
          noImageSupport={noImageSupport}
          onRemove={() => onRemoveAttachment(path)}
        />
      ))}
      {files.map((path) => (
        <FileChip key={path} path={path} onRemove={onRemoveFile && (() => onRemoveFile(path))} />
      ))}
    </div>
  );
}

/** Shown over a composer while a file is dragged across the window, so the
 *  drop target says what a drop will do before the user lets go. */
export function DropHint({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <div className="ds-drop-hint" aria-hidden="true" data-testid="drop-hint">
      <IconPhotoPlus size={20} />
      <span className="ds-drop-hint-title">Drop to attach</span>
      <span className="ds-drop-hint-sub">Images go to the agent as images · other files as @mentions</span>
    </div>
  );
}

/** The images on a paste, as base64 + extension, ready for `saveAttachment`. */
export async function pastedImages(
  data: DataTransfer | null
): Promise<{ dataBase64: string; ext: string }[]> {
  // A pasted image has a MIME type, not a file name: `image/jpeg` → `jpeg`.
  const extOf = (file: File) => file.type.slice("image/".length);
  const files = Array.from(data?.files ?? []).filter((f) => IMAGE_EXTENSIONS.includes(extOf(f)));
  return Promise.all(
    files.map(
      (file) =>
        new Promise<{ dataBase64: string; ext: string }>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const url = String(reader.result);
            resolve({
              dataBase64: url.slice(url.indexOf(",") + 1),
              ext: extOf(file),
            });
          };
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        })
    )
  );
}

/**
 * A text box's `onPaste` that turns pasted images into attachments and lets
 * a paste of plain text through untouched.
 */
export const imagePasteHandler =
  (
    onImages: ((images: { dataBase64: string; ext: string }[]) => void) | undefined,
    onError?: (err: unknown) => void
  ) =>
  (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!onImages) return;
    const hasImage = Array.from(event.clipboardData?.files ?? []).some((f) =>
      isAttachableImage(`.${f.type.slice("image/".length)}`)
    );
    if (!hasImage) return;
    event.preventDefault();
    pastedImages(event.clipboardData).then(onImages, onError);
  };
