use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::SystemTime,
};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Command {
    /// @codex resolves the newest installed desktop binary on every launch.
    pub executable: PathBuf,
    pub arguments: Vec<String>,
    pub directory: PathBuf,
    #[serde(default)]
    pub environment: BTreeMap<String, String>,
    #[serde(default)]
    pub hub_credentials: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Roles {
    pub engine: Command,
    pub runner: Command,
    pub native: Command,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub root: PathBuf,
    pub codex_install_root: PathBuf,
    pub socket_path: PathBuf,
    pub pipe_name: String,
    pub connection_file: PathBuf,
    pub path_prefix: Vec<PathBuf>,
    #[serde(default)]
    pub sandbox_bootstrap_group_sid: Option<String>,
    pub roles: Roles,
}

impl Config {
    pub fn read(path: &Path) -> Result<Self> {
        let config: Self =
            serde_json::from_slice(&std::fs::read(path).context("read host config")?)
                .context("parse host config")?;
        ensure!(
            !config.pipe_name.is_empty() && !config.pipe_name.contains(['\\', '/']),
            "pipeName must be a local pipe name"
        );
        Ok(config)
    }

    pub fn codex(&self) -> Result<PathBuf> {
        resolve_codex(&self.codex_install_root)
    }

    pub fn pipe_path(&self) -> String {
        format!(r"\\.\pipe\{}", self.pipe_name)
    }
}

pub fn resolve_codex(root: &Path) -> Result<PathBuf> {
    let mut candidates = Vec::new();
    for entry in std::fs::read_dir(root).context("read installed Codex versions")? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            let executable = entry.path().join("codex.exe");
            // Desktop updates can leave the running executable behind after
            // removing its companions. Cleanup also bumps the directory mtime.
            if executable.is_file()
                && entry.path().join("codex-code-mode-host.exe").is_file()
            {
                candidates.push((
                    executable
                        .metadata()?
                        .modified()
                        .unwrap_or(SystemTime::UNIX_EPOCH),
                    executable,
                ));
            }
        }
    }
    candidates.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    candidates
        .into_iter()
        .next()
        .map(|(_, path)| path)
        .context("no complete desktop Codex installation with code-mode host")
}

#[derive(Deserialize)]
pub struct Connection {
    pub hub: String,
    pub token: String,
}

// Match Windows CommandLineToArgvW / CRT argument quoting, including empty
// arguments and trailing backslashes. Never interpret arguments through a shell.
pub fn quote_windows_argument(argument: &str) -> String {
    if !argument.is_empty() && !argument.contains([' ', '\t', '\n', '\r', '"']) {
        return argument.to_owned();
    }
    let mut quoted = String::from("\"");
    let mut slashes = 0;
    for ch in argument.chars() {
        match ch {
            '\\' => slashes += 1,
            '"' => {
                quoted.extend(std::iter::repeat_n('\\', slashes * 2 + 1));
                quoted.push('"');
                slashes = 0;
            }
            _ => {
                quoted.extend(std::iter::repeat_n('\\', slashes));
                slashes = 0;
                quoted.push(ch);
            }
        }
    }
    quoted.extend(std::iter::repeat_n('\\', slashes * 2));
    quoted.push('"');
    quoted
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_resolution_ignores_cleanup_time_and_incomplete_installs() {
        let root = std::env::temp_dir().join(format!(
            "hapi-codex-resolution-{}-{}", std::process::id(),
            SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let make = |name: &str, seconds: u64, complete: bool| {
            let dir = root.join(name);
            std::fs::create_dir_all(&dir).unwrap();
            let exe = dir.join("codex.exe");
            let file = std::fs::File::create(&exe).unwrap();
            file.set_modified(SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(seconds)).unwrap();
            if complete {
                std::fs::write(dir.join("codex-code-mode-host.exe"), b"host").unwrap();
            }
            exe
        };
        let newest = make("new", 200, true);
        make("old", 100, true); // Directory was touched later, executable is older.
        make("incomplete", 300, false);
        assert_eq!(resolve_codex(&root).unwrap(), newest);
        std::fs::remove_file(root.join("new/codex-code-mode-host.exe")).unwrap();
        assert_eq!(resolve_codex(&root).unwrap(), root.join("old/codex.exe"));
        std::fs::remove_file(root.join("old/codex-code-mode-host.exe")).unwrap();
        assert!(resolve_codex(&root).is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn windows_arguments_keep_spaces_quotes_empty_values_and_paths() {
        assert_eq!(quote_windows_argument(""), "\"\"");
        assert_eq!(quote_windows_argument(r"D:\"), r"D:\");
        assert_eq!(quote_windows_argument(r"C:\a b\"), "\"C:\\a b\\\\\"");
        assert_eq!(quote_windows_argument("a\"b"), "\"a\\\"b\"");
        assert_eq!(quote_windows_argument("中文 路径"), "\"中文 路径\"");
    }
}
