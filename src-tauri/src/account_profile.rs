//! Immutable process profile and recoverable, explicit legacy import.
use sha2::{Digest, Sha256};
use std::{fs::{self, File, OpenOptions}, io::Read, path::{Path, PathBuf}, sync::OnceLock};
static PROFILE: OnceLock<(String, PathBuf, File)> = OnceLock::new();
pub fn identity_key(issuer: &str, subject: &str) -> String {
    crate::store::project_hash(&format!("{}:{issuer}{subject}", issuer.len()))
}
pub fn root() -> Option<PathBuf> { PROFILE.get().map(|(_, root, _)| root.clone()) }
pub fn is_bound(key: &str) -> bool { PROFILE.get().is_some_and(|(active, _, _)| active == key) }
fn owner_path(home: &Path) -> PathBuf { home.join("legacy-profile-owner.json") }
pub fn legacy_available(key: &str) -> bool {
    let home = crate::store::machine_home();
    if let Ok(owner) = fs::read_to_string(owner_path(&home)) {
        return owner.trim() == key && !home.join("profiles").join(key).join("import-complete").exists();
    }
    home.join("projects.json").exists() || home.join("projects").is_dir()
}
fn copy_verified(source: &Path, destination: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(source).map_err(|_| "Could not inspect the existing workspace")?;
    if metadata.file_type().is_symlink() { return Err("The existing workspace contains a symbolic link. Resolve it before importing.".into()); }
    if metadata.is_dir() {
        fs::create_dir_all(destination).map_err(|_| "Could not create the import directory")?;
        for entry in fs::read_dir(source).map_err(|_| "Could not read the existing workspace")? {
            let entry = entry.map_err(|_| "Could not read a workspace entry")?;
            copy_verified(&entry.path(), &destination.join(entry.file_name()))?;
        }
        File::open(destination).and_then(|file| file.sync_all()).map_err(|_| "Could not save the workspace directory")?;
    } else if metadata.is_file() {
        fs::copy(source, destination).map_err(|_| "Could not copy the existing workspace")?;
        if digest(source)? != digest(destination)? { return Err("Workspace copy verification failed. The original is preserved.".into()); }
        File::open(destination).and_then(|file| file.sync_all()).map_err(|_| "Could not save the workspace copy")?;
    } else { return Err("Unsupported workspace file type".into()); }
    Ok(())
}
fn digest(path: &Path) -> Result<Vec<u8>, String> {
    let mut file = File::open(path).map_err(|_| "Could not verify a workspace file")?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let size = file.read(&mut buffer).map_err(|_| "Could not verify a workspace file")?;
        if size == 0 { break; }
        hash.update(&buffer[..size]);
    }
    Ok(hash.finalize().to_vec())
}
pub fn prepare(home: &Path, key: &str, import: bool) -> Result<PathBuf, String> {
    if key.len() != 64 || !key.bytes().all(|c| c.is_ascii_hexdigit()) { return Err("Invalid profile identity".into()); }
    fs::create_dir_all(home).map_err(|_| "Could not create the account directory")?;
    let lock = OpenOptions::new().create(true).truncate(false).read(true).write(true).open(home.join("profile-import.lock")).map_err(|_| "Could not lock workspace setup")?;
    lock.try_lock().map_err(|_| "Another Palisade instance is importing the workspace. Close it and retry.".to_string())?;
    let target = home.join("profiles").join(key);
    if !import {
        fs::create_dir_all(&target).map_err(|_| "Could not create the profile")?;
        if target.join("import-complete").exists() {
            if fs::read_to_string(owner_path(home)).is_ok_and(|owner| owner.trim() != key) { return Err("Workspace ownership does not match this profile".into()); }
            commit_owner(home, key)?;
        }
        return Ok(target);
    }
    if let Ok(owner) = fs::read_to_string(owner_path(home)) {
        if owner.trim() != key { return Err("The existing workspace belongs to another account profile".into()); }
    }
    if target.join("import-complete").exists() {
        commit_owner(home, key)?;
        return Ok(target);
    }
    if target.exists() && fs::read_dir(&target).map_err(|_| "Could not inspect the profile")?.next().is_some() {
        return Err("This profile already contains work. Import will not overwrite it.".into());
    }
    let stage = home.join("profiles").join(format!(".{key}-import"));
    // An incomplete stage is never exposed. Retry starts from the preserved source.
    if stage.exists() { fs::remove_dir_all(&stage).map_err(|_| "Could not clear an incomplete import")?; }
    fs::create_dir_all(&stage).map_err(|_| "Could not stage the workspace import")?;
    let recovery = home.join("recovery").join(key);
    fs::create_dir_all(&recovery).map_err(|_| "Could not create the recovery copy")?;
    for name in ["projects.json", "projects", "contexts", "harness.log", "completion-telemetry.json"] {
        let source = home.join(name);
        if source.exists() {
            let backup = recovery.join(name);
            if !backup.exists() {
                let pending = recovery.join(format!(".{name}-copy"));
                if pending.is_dir() { fs::remove_dir_all(&pending).map_err(|_| "Could not recover an interrupted backup")?; }
                else if pending.exists() { fs::remove_file(&pending).map_err(|_| "Could not recover an interrupted backup")?; }
                copy_verified(&source, &pending)?;
                fs::rename(pending, &backup).map_err(|_| "Could not finish the recovery copy")?;
                File::open(&recovery).and_then(|file| file.sync_all()).map_err(|_| "Could not save the recovery copy")?;
            }
            copy_verified(&source, &stage.join(name))?;
        }
    }
    crate::db::copy_legacy_credentials(home, &target)?;
    fs::write(stage.join("import-complete"), key).map_err(|_| "Could not finish the import record")?;
    File::open(stage.join("import-complete")).and_then(|file| file.sync_all()).map_err(|_| "Could not save the import record")?;
    File::open(&stage).and_then(|file| file.sync_all()).map_err(|_| "Could not save the imported workspace")?;
    if target.exists() { fs::remove_dir(&target).map_err(|_| "The profile changed during import. Retry without overwriting it.".to_string())?; }
    fs::rename(&stage, &target).map_err(|_| "Could not install the imported workspace")?;
    File::open(target.parent().unwrap()).and_then(|file| file.sync_all()).map_err(|_| "Could not save the imported profile")?;
    // Commit ownership only after files and credentials are verified. A retry
    // after an interrupted commit can finish the same account's ownership.
    commit_owner(home, key)?;
    Ok(target)
}
fn commit_owner(home: &Path, key: &str) -> Result<(), String> {
    let stage = home.join("legacy-profile-owner.tmp");
    fs::write(&stage, key).map_err(|_| "Could not record workspace ownership")?;
    File::open(&stage).and_then(|file| file.sync_all()).map_err(|_| "Could not save workspace ownership")?;
    fs::rename(stage, owner_path(home)).map_err(|_| "Could not commit workspace ownership")?;
    File::open(home).and_then(|file| file.sync_all()).map_err(|_| "Could not save workspace ownership")?;
    Ok(())
}
pub fn bind(key: &str, root: PathBuf) -> Result<(), String> {
    if let Some((active, _, _)) = PROFILE.get() {
        return if active == key { Ok(()) } else { Err("Restart Palisade before opening a different account profile".into()) };
    }
    let lock = OpenOptions::new().create(true).truncate(false).read(true).write(true).open(root.join(".profile.lock")).map_err(|_| "Could not lock the account profile")?;
    lock.try_lock().map_err(|_| "This account profile is open in another Palisade process. Close that process first.".to_string())?;
    PROFILE.set((key.into(), root, lock)).map_err(|_| "A profile was already opened".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn profiles_are_immutable_identities_and_import_preserves_the_original() {
        let home = tempfile::tempdir().unwrap();
        fs::write(home.path().join("projects.json"), b"[]").unwrap();
        let a = identity_key("https://issuer.example", "user_a");
        let b = identity_key("https://issuer.example", "user_b");
        assert_ne!(a, b);
        assert_ne!(a, identity_key("https://other.example", "user_a"));
        let empty = prepare(home.path(), &b, false).unwrap();
        assert!(!empty.join("projects.json").exists());
        assert!(!owner_path(home.path()).exists());
        let imported = prepare(home.path(), &a, true).unwrap();
        assert_eq!(fs::read(imported.join("projects.json")).unwrap(), b"[]");
        assert_eq!(fs::read(home.path().join("projects.json")).unwrap(), b"[]");
        assert_eq!(prepare(home.path(), &a, true).unwrap(), imported);
        assert!(prepare(home.path(), &b, true).is_err());
        assert!(prepare(home.path(), "../escape", false).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn failed_import_does_not_claim_data_and_retry_replaces_incomplete_stage() {
        let home = tempfile::tempdir().unwrap();
        let key = identity_key("https://issuer.example", "retry_user");
        let projects = home.path().join("projects");
        fs::create_dir(&projects).unwrap();
        fs::write(projects.join("history.json"), b"preserved history").unwrap();
        std::os::unix::fs::symlink(projects.join("history.json"), projects.join("unsupported-link")).unwrap();
        assert!(prepare(home.path(), &key, true).is_err(), "unsafe source must fail before ownership");
        assert!(!owner_path(home.path()).exists(), "failed import must leave legacy data unclaimed");
        assert!(!home.path().join("profiles").join(&key).exists(), "incomplete files must not be exposed as a profile");
        fs::remove_file(projects.join("unsupported-link")).unwrap();
        let target = prepare(home.path(), &key, true).unwrap();
        assert_eq!(fs::read(target.join("projects/history.json")).unwrap(), b"preserved history", "retry must import the original");
        assert_eq!(fs::read(home.path().join("recovery").join(&key).join("projects/history.json")).unwrap(), b"preserved history", "retry must finish the recovery copy");
        assert_eq!(fs::read_to_string(owner_path(home.path())).unwrap(), key, "ownership commits only after verified import");
    }

}
