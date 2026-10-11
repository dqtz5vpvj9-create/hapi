#[cfg(windows)]
mod fixture {
    use anyhow::{Context, Result};
    use futures_util::{SinkExt, StreamExt};
    use serde_json::{Value, json};
    use socket2::{Domain, SockAddr, Socket, Type};
    use std::{
        collections::BTreeSet,
        fs::OpenOptions,
        io::Write,
        os::windows::process::CommandExt,
        path::PathBuf,
        sync::{Arc, Mutex},
        time::Duration,
    };
    use tokio::net::TcpStream;
    use tokio_tungstenite::{accept_async, tungstenite::Message};

    fn publish(path: PathBuf, value: &Value) -> Result<()> {
        std::fs::write(path, serde_json::to_vec(value)?)?;
        Ok(())
    }

    pub async fn run() -> Result<()> {
        let arguments: Vec<_> = std::env::args().skip(1).collect();
        let role = arguments.first().context("fixture role")?.as_str();
        if role == "clients" {
            return tokio::time::timeout(
                Duration::from_secs(20),
                concurrent_clients(arguments.get(1).context("fixture pipe path")?),
            )
            .await
            .context("concurrent pipe fixture deadline")?;
        }
        let root = PathBuf::from(std::env::var_os("HAPI_HOME").context("fixture state directory")?);
        let identity = hapi_windows_host::windows::process::identity()?;
        publish(
            root.join(format!("{role}-identity.json")),
            &serde_json::to_value(identity)?,
        )?;
        publish(
            root.join(format!("{role}-arguments.json")),
            &json!(arguments),
        )?;
        if role.ends_with("leaf") {
            loop {
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
        let leaf_name = format!("{role}-leaf");
        // The fixture intentionally does not own/kill this child. The runtime's
        // Job Object policy must provide (or deliberately omit) that behavior.
        std::process::Command::new(std::env::current_exe()?)
            .arg(&leaf_name)
            .creation_flags(0x08000000)
            .spawn()?;
        if role == "runner" {
            publish(
                root.join("runner.state.json"),
                &json!({"pid":std::process::id()}),
            )?;
        }
        if role != "engine" {
            loop {
                tokio::time::sleep(Duration::from_millis(100)).await;
                let handoff = root.join("runner-handoff");
                if role == "runner" && handoff.exists() {
                    std::fs::remove_file(handoff)?;
                    std::process::Command::new(std::env::current_exe()?)
                        .arg("runner")
                        .creation_flags(0x08000000)
                        .spawn()?;
                    return Ok(());
                }
            }
        }
        let path = PathBuf::from(arguments.get(1).context("fixture socket path")?);
        if path.exists() {
            std::fs::remove_file(&path)?;
        }
        let listener = Socket::new(Domain::UNIX, Type::STREAM, None)?;
        listener.bind(&SockAddr::unix(&path)?)?;
        listener.listen(128)?;
        listener.set_nonblocking(true)?;
        let loaded = Arc::new(Mutex::new(BTreeSet::from(["already-loaded".to_owned()])));
        loop {
            match listener.accept() {
                Ok((socket, _)) => {
                    socket.set_nonblocking(true)?;
                    let stream = TcpStream::from_std(socket.into())?;
                    let root = root.clone();
                    let loaded = loaded.clone();
                    tokio::spawn(async move {
                        if let Err(error) = serve(stream, root, loaded).await {
                            eprintln!("fixture client: {error}");
                        }
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    tokio::time::sleep(Duration::from_millis(5)).await
                }
                Err(error) => return Err(error.into()),
            }
        }
    }

    async fn serve(
        stream: TcpStream,
        root: PathBuf,
        loaded: Arc<Mutex<BTreeSet<String>>>,
    ) -> Result<()> {
        let mut websocket = accept_async(stream).await?;
        while let Some(message) = websocket.next().await {
            let message = message?;
            let Message::Text(text) = message else {
                continue;
            };
            let request: Value = serde_json::from_str(&text)?;
            let method = request["method"].as_str().context("fixture method")?;
            writeln!(
                OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(root.join("requests.jsonl"))?,
                "{}",
                request
            )?;
            if request.get("id").is_none() {
                continue;
            }
            let result = match method {
                "initialize" => json!({"userAgent":"fixture"}),
                "thread/loaded/list" => {
                    json!({"data":loaded.lock().unwrap().iter().cloned().collect::<Vec<_>>(),"nextCursor":null})
                }
                "thread/list" if request["params"]["cursor"].is_null() => {
                    json!({"data":[{"id":"restore-root"},{"id":"child-root"}],"nextCursor":"page-2"})
                }
                "thread/list" => json!({"data":[{"id":"already-loaded"}],"nextCursor":null}),
                "thread/read" => {
                    json!({"thread":{"id":request["params"]["threadId"],"parentThreadId":if request["params"]["threadId"] == "child-root" { json!("parent") } else { Value::Null }}})
                }
                "thread/resume" => {
                    let id = request["params"]["threadId"]
                        .as_str()
                        .context("resume ID")?;
                    loaded.lock().unwrap().insert(id.to_owned());
                    json!({"thread":{"id":id}})
                }
                _ => anyhow::bail!("unexpected method {method}"),
            };
            websocket
                .send(Message::Text(
                    json!({"id":request["id"],"result":result})
                        .to_string()
                        .into(),
                ))
                .await?;
        }
        Ok(())
    }

    async fn concurrent_clients(path: &str) -> Result<()> {
        use tokio::net::windows::named_pipe::ClientOptions;
        let mut held = Vec::new();
        for _ in 0..32 {
            let pipe = loop {
                match ClientOptions::new().open(path) {
                    Ok(pipe) => break pipe,
                    Err(error) if error.raw_os_error() == Some(231) => {
                        tokio::time::sleep(Duration::from_millis(10)).await
                    }
                    Err(error) => return Err(error.into()),
                }
            };
            let (mut socket, _) =
                tokio_tungstenite::client_async("ws://localhost/rpc", pipe).await?;
            socket
                .send(Message::Text(
                    json!({"id":1,"method":"thread/loaded/list","params":{"cursor":null}})
                        .to_string()
                        .into(),
                ))
                .await?;
            let response = socket.next().await.context("concurrent response")??;
            let response: Value = serde_json::from_slice(&response.into_data())?;
            anyhow::ensure!(
                response["result"]["data"].is_array(),
                "concurrent RPC result"
            );
            held.push(socket);
        }
        println!("{}", json!({"concurrentClients":held.len()}));
        Ok(())
    }
}

#[cfg(windows)]
fn main() -> anyhow::Result<()> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(fixture::run())
}
#[cfg(not(windows))]
fn main() {
    panic!("Windows-only isolated fixture");
}
