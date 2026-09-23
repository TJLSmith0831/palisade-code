//! Images attached to a chat turn.
//!
//! Every dropped or pasted image is copied into the project's
//! `attachments/` dir the moment it lands in the composer. The copy is what
//! the turn records and what the agent is sent, so the history keeps showing
//! the image after the original on the Desktop is gone, and reads are only
//! ever served from inside that one directory.

use base64::prelude::*;
use std::path::{Path, PathBuf};

use crate::acp_client::PromptImage;
use crate::Res;

/// Larger than any screenshot; small enough that a stray drop of a photo
/// library export can't balloon one prompt past what an agent accepts.
pub const MAX_BYTES: u64 = 20 * 1024 * 1024;

pub fn attachments_dir(home: &Path, hash: &str) -> PathBuf {
    crate::store::project_dir(home, hash).join("attachments")
}

/// The MIME type an agent needs for `ext`, or `None` for anything that is
/// not an image Palisade will attach.
pub fn mime_for(ext: &str) -> Option<&'static str> {
    match ext.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

fn ext_of(path: &Path) -> String {
    path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase()
}

/// Store `bytes` as a new attachment and return the stored path.
pub fn save(home: &Path, hash: &str, bytes: &[u8], ext: &str) -> Res<PathBuf> {
    let ext = ext.to_ascii_lowercase();
    if mime_for(&ext).is_none() {
        return Err(format!("not an image Palisade can attach: .{ext}").into());
    }
    if bytes.len() as u64 > MAX_BYTES {
        return Err("image is larger than 20 MB".into());
    }
    let dir = attachments_dir(home, hash);
    std::fs::create_dir_all(&dir).map_err(|e| crate::PalisadeError::from(format!("create attachments dir: {e}")))?;
    let path = dir.join(format!("{}.{ext}", ulid::Ulid::new()));
    std::fs::write(&path, bytes).map_err(|e| crate::PalisadeError::from(format!("save attachment: {e}")))?;
    Ok(path)
}

/// Copy an image from anywhere on disk into the attachments dir.
pub fn save_from(home: &Path, hash: &str, source: &Path) -> Res<PathBuf> {
    let size = std::fs::metadata(source)
        .map_err(|e| crate::PalisadeError::from(format!("cannot read {}: {e}", source.display())))?
        .len();
    if size > MAX_BYTES {
        return Err("image is larger than 20 MB".into());
    }
    let bytes = std::fs::read(source)
        .map_err(|e| crate::PalisadeError::from(format!("cannot read {}: {e}", source.display())))?;
    save(home, hash, &bytes, &ext_of(source))
}

/// `path`, but only if it really is a file inside this project's attachments
/// dir — the one place these commands are allowed to read from.
fn contained(home: &Path, hash: &str, path: &str) -> Res<PathBuf> {
    let dir = attachments_dir(home, hash)
        .canonicalize()
        .map_err(|_| crate::PalisadeError::not_found("no attachments in this project"))?;
    let resolved = Path::new(path)
        .canonicalize()
        .map_err(|_| crate::PalisadeError::not_found("attachment is missing"))?;
    if !resolved.starts_with(&dir) {
        return Err("not a Palisade attachment".into());
    }
    Ok(resolved)
}

/// A stored attachment as a `data:` URL the webview can show.
pub fn data_url(home: &Path, hash: &str, path: &str) -> Res<String> {
    let image = load(home, hash, path)?;
    Ok(format!("data:{};base64,{}", image.mime_type, image.data))
}

/// A stored attachment, ready to go out as an ACP image block.
pub fn load(home: &Path, hash: &str, path: &str) -> Res<PromptImage> {
    let resolved = contained(home, hash, path)?;
    let mime = mime_for(&ext_of(&resolved)).ok_or("not an image Palisade can attach")?;
    let bytes = std::fs::read(&resolved).map_err(|e| crate::PalisadeError::from(format!("read attachment: {e}")))?;
    Ok(PromptImage {
        path: resolved.to_string_lossy().into_owned(),
        mime_type: mime.to_string(),
        data: BASE64_STANDARD.encode(bytes),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_images_load_back_as_prompt_images() {
        let home = tempfile::tempdir().unwrap();
        let path = save(home.path(), "p1", b"\x89PNG", "PNG").unwrap();
        assert!(path.starts_with(attachments_dir(home.path(), "p1")));
        let image = load(home.path(), "p1", path.to_str().unwrap()).unwrap();
        assert_eq!(image.mime_type, "image/png");
        assert_eq!(image.data, BASE64_STANDARD.encode(b"\x89PNG"));
        assert!(data_url(home.path(), "p1", path.to_str().unwrap()).unwrap().starts_with("data:image/png;base64,"));
    }

    #[test]
    fn non_images_are_refused() {
        let home = tempfile::tempdir().unwrap();
        assert!(save(home.path(), "p1", b"hi", "txt").is_err());
    }

    /// Reads are fenced to the attachments dir: a path outside it — even an
    /// image — is never served, and neither is a `..` walk back out.
    #[test]
    fn reads_outside_the_attachments_dir_are_refused() {
        let home = tempfile::tempdir().unwrap();
        save(home.path(), "p1", b"x", "png").unwrap();
        let outside = home.path().join("secret.png");
        std::fs::write(&outside, b"x").unwrap();
        assert!(load(home.path(), "p1", outside.to_str().unwrap()).is_err());
        let escape = attachments_dir(home.path(), "p1").join("../../../secret.png");
        assert!(load(home.path(), "p1", escape.to_str().unwrap()).is_err());
        // Another project's attachment is outside this one's dir too.
        let other = save(home.path(), "p2", b"x", "png").unwrap();
        assert!(load(home.path(), "p1", other.to_str().unwrap()).is_err());
    }

    #[test]
    fn save_from_copies_so_the_original_can_go_away() {
        let home = tempfile::tempdir().unwrap();
        let src = home.path().join("shot.jpeg");
        std::fs::write(&src, b"jpg").unwrap();
        let stored = save_from(home.path(), "p1", &src).unwrap();
        std::fs::remove_file(&src).unwrap();
        assert_eq!(load(home.path(), "p1", stored.to_str().unwrap()).unwrap().mime_type, "image/jpeg");
    }
}
