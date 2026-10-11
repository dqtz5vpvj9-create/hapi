use super::{
    process::{self, Process},
    relay::Relay,
    rpc::Client,
};
use crate::{config::Config, policy::restart_delay};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs::OpenOptions,
    io::Write,
    path::Path,
    time::{Duration, Instant},
};
use tokio::{
    task::{JoinHandle, LocalSet},
    time::{MissedTickBehavior, interval},
};
use windows_sys::Win32::Storage::FileSystem::{MOVEFILE_REPLACE_EXISTING, MoveFileExW};

pub fn rotate(path: &Path, always: bool) -> Result<()> {
    if path.exists() && (always || path.metadata()?.len() > 4 * 1024 * 1024) {
        replace(path, &path.with_extension("log.previous"))?;
    }
    Ok(())
}

fn replace(from: &Path, to: &Path) -> Result<()> {
    let success = unsafe {
        MoveFileExW(
            process::wide(from).as_ptr(),
            process::wide(to).as_ptr(),
            MOVEFILE_REPLACE_EXISTING,
        )
    };
    if success == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}

fn write_state(path: &Path, value: &Value) -> Result<()> {
    let temporary = path.with_extension("json.new");
    std::fs::write(&temporary, serde_json::to_vec(value)?)?;
    replace(&temporary, path)
}

fn log(config: &Config, text: &str) {
    let path = config.root.join("logs/supervisor.log");
    let publication = (|| -> Result<()> {
        rotate(&path, false)?;
        writeln!(
            OpenOptions::new().create(true).append(true).open(path)?,
            "{} {text}",
            timestamp()
        )?;
        Ok(())
    })();
    if publication.is_err() {
        eprintln!("supervisor event publication failed");
    }
}

fn timestamp() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .expect("UTC timestamp is representable")
}

struct Role {
    process: Option<Process>,
    failures: u32,
    started: Instant,
    retry: Instant,
}
impl Role {
    fn new() -> Self {
        Self {
            process: None,
            failures: 0,
            started: Instant::now(),
            retry: Instant::now(),
        }
    }

    fn ensure(&mut self, config: &Config, name: &str) -> Result<bool> {
        if let Some(process) = &self.process
            && let Some(code) = process.exit_code()?
        {
            if name == "runner" {
                match Process::adopt_runner(config) {
                    Ok(Some(adopted)) => {
                        log(config, &format!("runner adopted ({})", adopted.id));
                        self.process = Some(adopted);
                        return Ok(false);
                    }
                    Ok(None) => {}
                    Err(_) => log(
                        config,
                        "runner adoption unavailable; retry through normal startup",
                    ),
                }
            }
            log(config, &format!("{name} exited ({code})"));
            self.process = None;
            self.retry = Instant::now() + restart_delay(&mut self.failures, self.started.elapsed());
        }
        if self.process.is_none() && Instant::now() >= self.retry {
            let command = match name {
                "engine" => &config.roles.engine,
                "runner" => &config.roles.runner,
                _ => &config.roles.native,
            };
            match Process::spawn(config, name, command) {
                Ok(process) => {
                    log(config, &format!("{name} started ({})", process.id));
                    self.process = Some(process);
                    self.started = Instant::now();
                    return Ok(true);
                }
                Err(error) => {
                    // Launch failure is a role failure, not a reason to take down
                    // the other live roles. Do not log arguments/credentials.
                    self.retry = Instant::now() + restart_delay(&mut self.failures, Duration::ZERO);
                    log(
                        config,
                        &format!("{name} launch failed: {error:#}; retry scheduled"),
                    );
                }
            }
        }
        Ok(false)
    }

    fn stop(&mut self) {
        if let Some(process) = &mut self.process {
            let _ = process.stop();
        }
        self.retry = Instant::now();
    }
}
impl Drop for Role {
    fn drop(&mut self) {
        self.stop();
    }
}

type Probe = JoinHandle<(Client, Result<(Vec<String>, bool)>)>;

pub async fn run(config: Config) -> Result<()> {
    // Relay owns an ACL descriptor (a raw Win32 allocation), so run its task on
    // the same OS thread. Async socket operations use IOCP, not worker threads.
    let local = LocalSet::new();
    local.run_until(run_local(config)).await
}

async fn run_local(config: Config) -> Result<()> {
    let identity = process::identity()?;
    ensure!(
        !identity.administrator && identity.integrity <= 8192,
        "refusing administrative/high-integrity runtime token"
    );
    process::require_bootstrap_job(&config)?;
    let _singleton = process::singleton(&config)?;
    for directory in ["logs", "state", "temp"] {
        std::fs::create_dir_all(config.root.join(directory))?;
    }
    let relay = Relay::bind(&config)?;
    let mut relay_task = Some(tokio::task::spawn_local(relay.run()));
    let mut relay_failures = 0;
    let mut relay_started = Instant::now();
    let mut relay_retry = Instant::now();
    let snapshot = config.root.join("state/native-loaded-roots.json");
    let mut saved: Vec<String> = if snapshot.exists() {
        serde_json::from_slice::<Value>(&std::fs::read(&snapshot)?)?["threadIds"]
            .as_array()
            .context("invalid saved root snapshot")?
            .iter()
            .map(|id| {
                id.as_str()
                    .context("invalid saved root ID")
                    .map(str::to_owned)
            })
            .collect::<Result<_>>()?
    } else {
        Vec::new()
    };
    let mut roles = BTreeMap::from([
        ("engine", Role::new()),
        ("runner", Role::new()),
        ("native", Role::new()),
    ]);
    let mut healthy = false;
    let mut restore_pending = true;
    let mut last_healthy = Instant::now();
    let mut next_probe = Instant::now();
    let mut connecting: Option<JoinHandle<Result<Client>>> = None;
    let mut probe: Option<Probe> = None;
    let mut client: Option<Client> = None;
    let mut ticks = interval(Duration::from_secs(1));
    ticks.set_missed_tick_behavior(MissedTickBehavior::Skip);
    log(
        &config,
        &format!(
            "Rust supervisor started in session {}, non-administrative",
            identity.session
        ),
    );
    // A retained stop-file supports controlled isolated tests and an orderly
    // operator stop. It is never created automatically by the runtime.
    let stop_file = config.root.join("state/stop-requested");
    loop {
        tokio::select! {
            _ = ticks.tick() => {
                if stop_file.exists() { break; }
                if relay_task.as_ref().is_some_and(JoinHandle::is_finished) {
                    let _ = relay_task.take().unwrap().await;
                    relay_retry = Instant::now() + restart_delay(&mut relay_failures, relay_started.elapsed());
                    if let Some(task) = connecting.take() { task.abort(); }
                    if let Some(task) = probe.take() { task.abort(); }
                    client = None;
                    healthy = false;
                    log(&config, "relay exited; reconnecting transport without stopping roles");
                }
                if relay_task.is_none() && Instant::now() >= relay_retry {
                    match Relay::bind(&config) {
                        Ok(relay) => {
                            relay_task = Some(tokio::task::spawn_local(relay.run()));
                            relay_started = Instant::now();
                            next_probe = Instant::now();
                        }
                        Err(_) => relay_retry = Instant::now() + restart_delay(&mut relay_failures, Duration::ZERO),
                    }
                }
                let old_engine = roles["engine"].process.as_ref().map(|process| process.id);
                roles.get_mut("engine").unwrap().ensure(&config, "engine")?;
                let new_engine = roles["engine"].process.as_ref().map(|process| process.id);
                let engine_changed = old_engine != new_engine;
                roles.get_mut("runner").unwrap().ensure(&config, "runner")?;
                if engine_changed {
                    if let Some(task) = connecting.take() { task.abort(); }
                    if let Some(task) = probe.take() { task.abort(); }
                    client = None;
                    healthy = false;
                    restore_pending = true;
                    next_probe = Instant::now();
                    if new_engine.is_some() { last_healthy = Instant::now(); }
                }
                if connecting.as_ref().is_some_and(JoinHandle::is_finished) {
                    match connecting.take().unwrap().await? {
                        Ok(connected) => client = Some(connected),
                        Err(_) => { healthy = false; next_probe = Instant::now() + Duration::from_secs(10); log(&config, "native probe connection unavailable"); },
                    }
                }
                if probe.as_ref().is_some_and(JoinHandle::is_finished) {
                    let (connected, result) = probe.take().unwrap().await?;
                    match result {
                        Ok((roots, failed)) => {
                            saved = roots;
                            restore_pending = failed;
                            if write_state(&snapshot, &json!({"threadIds":saved})).is_err() { log(&config, "native snapshot publication failed; retry on next probe"); }
                            healthy = true;
                            last_healthy = Instant::now();
                            client = Some(connected);
                        }
                        Err(_) => { healthy = false; log(&config, "native protocol probe unavailable"); },
                    }
                    next_probe = Instant::now() + Duration::from_secs(10);
                }
                if Instant::now() >= next_probe && connecting.is_none() && probe.is_none() {
                    if let Some(mut connected) = client.take() {
                        let previous = saved.clone();
                        probe = Some(tokio::spawn(async move {
                            let result = connected.probe(&previous, restore_pending).await;
                            (connected, result)
                        }));
                    } else {
                        let path = config.pipe_path();
                        connecting = Some(tokio::spawn(async move { Client::connect(&path).await }));
                    }
                }
                if !healthy && last_healthy.elapsed() > Duration::from_secs(120) {
                    // Preserve the existing native-outage recovery threshold.
                    // A Hub/network failure never enters this native health path.
                    log(&config, "native protocol unavailable for 120 seconds; restarting owned engine");
                    if let Some(task) = connecting.take() { task.abort(); }
                    if let Some(task) = probe.take() { task.abort(); }
                    client = None;
                    roles.get_mut("engine").unwrap().stop();
                    last_healthy = Instant::now();
                }
                if healthy { roles.get_mut("native").unwrap().ensure(&config, "native")?; }
                let mut status = serde_json::Map::new();
                for (name, role) in &roles { status.insert((*name).into(), json!({"pid":role.process.as_ref().map(|p|p.id),"failures":role.failures})); }
                status.insert("pipe".into(), json!({"pid":relay_task.as_ref().map(|_|identity.pid),"failures":relay_failures,"inProcess":true}));
                if write_state(&config.root.join("state/supervisor.json"), &json!({"timestamp":timestamp(),"pid":identity.pid,"session":identity.session,"nativeReady":healthy,"restorePending":restore_pending,"roles":status})).is_err() {
                    log(&config, "supervisor status publication failed; retry on next tick");
                }
            }
        }
    }
    if let Some(task) = connecting {
        task.abort();
    }
    if let Some(task) = probe {
        task.abort();
    }
    if let Some(task) = relay_task {
        task.abort();
    }
    log(&config, "supervisor stopping");
    // Role Drop closes owned jobs. Bootstrap's outer job remains the final
    // owner of the backend tree, exactly as in the existing scheduled runtime.
    Ok(())
}
