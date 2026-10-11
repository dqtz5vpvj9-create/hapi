pub mod process;
mod relay;
mod rpc;
mod supervisor;

use anyhow::{Context, Result, bail};
use std::path::PathBuf;

pub fn run() -> Result<()> {
    let mut arguments = std::env::args_os().skip(1);
    let mode = arguments
        .next()
        .context("usage: hapi-windows-host bootstrap|supervise|probe|identity --config <file>")?;
    if mode == "identity" {
        println!("{}", serde_json::to_string(&process::identity()?)?);
        return Ok(());
    }
    if arguments.next().as_deref() != Some(std::ffi::OsStr::new("--config")) {
        bail!("expected --config <file>");
    }
    let path = PathBuf::from(arguments.next().context("missing config path")?).canonicalize()?;
    if arguments.next().is_some() {
        bail!("unexpected argument");
    }
    let config = crate::config::Config::read(&path)?;
    if mode == "bootstrap" {
        let result = process::bootstrap(&config, &path);
        if let Err(error) = &result {
            record_fatal(&config, "bootstrap", error);
        }
        return result;
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    if mode == "supervise" {
        let result = runtime.block_on(supervisor::run(config.clone()));
        if let Err(error) = &result {
            record_fatal(&config, "supervisor", error);
        }
        result
    } else if mode == "probe" {
        runtime.block_on(async {
            let mut client = rpc::Client::connect(&config.pipe_path()).await?;
            let result = client
                .request("thread/loaded/list", serde_json::json!({"cursor":null}))
                .await?;
            println!("{}", result);
            Ok(())
        })
    } else {
        bail!("unknown mode")
    }
}

fn record_fatal(config: &crate::config::Config, role: &str, error: &anyhow::Error) {
    use std::io::Write;
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(config.root.join(format!("logs/{role}-fatal.log")))
    {
        let _ = writeln!(file, "{error:#}");
    }
}
