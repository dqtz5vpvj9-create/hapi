use anyhow::{Context, Result, bail};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::{
    net::windows::named_pipe::{ClientOptions, NamedPipeClient},
    time::{sleep, timeout},
};
use tokio_tungstenite::{WebSocketStream, client_async, tungstenite::Message};

pub struct Client {
    socket: WebSocketStream<NamedPipeClient>,
    sequence: u64,
}

impl Client {
    pub async fn connect(path: &str) -> Result<Self> {
        let (socket, _) = timeout(Duration::from_secs(5), async {
            let pipe = loop {
                match ClientOptions::new().open(path) {
                    Ok(pipe) => break pipe,
                    Err(error)
                        if error.raw_os_error() == Some(231)
                            || error.kind() == std::io::ErrorKind::NotFound =>
                    {
                        sleep(Duration::from_millis(25)).await
                    }
                    Err(error) => return Err(error.into()),
                }
            };
            Ok::<_, anyhow::Error>(client_async("ws://localhost/rpc", pipe).await?)
        })
        .await
        .context("native pipe connect deadline")??;
        let mut client = Self {
            socket,
            sequence: 0,
        };
        client.request("initialize", json!({"clientInfo":{"name":"hapi_windows_supervisor","version":"1"},"capabilities":{"experimentalApi":true}})).await?;
        timeout(
            Duration::from_secs(5),
            client.socket.send(Message::Text(
                json!({"method":"initialized"}).to_string().into(),
            )),
        )
        .await??;
        Ok(client)
    }

    pub async fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        self.sequence += 1;
        let id = self.sequence;
        timeout(Duration::from_secs(10), async {
            self.socket
                .send(Message::Text(
                    json!({"id":id,"method":method,"params":params})
                        .to_string()
                        .into(),
                ))
                .await?;
            while let Some(message) = self.socket.next().await {
                let message = message?;
                if message.is_close() {
                    bail!("native server closed connection");
                }
                let Message::Text(text) = message else {
                    continue;
                };
                let response: Value = serde_json::from_str(&text)?;
                // Notifications and tool/permission requests belong to HAPI or
                // the desktop client. They are never executed by this probe.
                if response["id"].as_u64() != Some(id) || response.get("method").is_some() {
                    continue;
                }
                if response.get("error").is_some() {
                    // A server error can embed private paths or tool content.
                    bail!(
                        "native {method} returned RPC error {}",
                        response["error"]["code"]
                    );
                }
                return response
                    .get("result")
                    .cloned()
                    .context("missing native result");
            }
            bail!("native transport ended")
        })
        .await
        .with_context(|| format!("native {method} deadline"))?
    }

    async fn loaded_roots(&mut self) -> Result<Vec<String>> {
        let mut loaded = Vec::new();
        let mut cursor = Value::Null;
        loop {
            let page = self
                .request("thread/loaded/list", json!({"cursor":cursor}))
                .await?;
            for id in page["data"]
                .as_array()
                .context("invalid loaded thread page")?
            {
                let id = id.as_str().context("invalid loaded thread ID")?;
                let result = self
                    .request("thread/read", json!({"threadId":id,"includeTurns":false}))
                    .await?;
                if result["thread"]["parentThreadId"].is_null() {
                    loaded.push(id.to_owned());
                }
            }
            cursor = page["nextCursor"].clone();
            if cursor.is_null() {
                break;
            }
        }
        Ok(loaded)
    }

    pub async fn probe(
        &mut self,
        previous: &[String],
        restore_pending: bool,
    ) -> Result<(Vec<String>, bool)> {
        let mut loaded = self.loaded_roots().await?;
        let mut failed = false;
        if restore_pending && !previous.is_empty() {
            let mut saved = std::collections::BTreeSet::new();
            let mut cursor = Value::Null;
            loop {
                let page = self.request("thread/list", json!({"archived":false,"limit":100,"cursor":cursor,"useStateDbOnly":true,"modelProviders":[],"sourceKinds":["cli","vscode","exec","appServer","unknown"]})).await?;
                for thread in page["data"]
                    .as_array()
                    .context("invalid saved thread page")?
                {
                    saved.insert(
                        thread["id"]
                            .as_str()
                            .context("invalid saved thread ID")?
                            .to_owned(),
                    );
                }
                cursor = page["nextCursor"].clone();
                if cursor.is_null() {
                    break;
                }
            }
            for id in previous {
                if loaded.contains(id) || !saved.contains(id) {
                    continue;
                }
                let restore = async {
                    let result = self
                        .request("thread/read", json!({"threadId":id,"includeTurns":false}))
                        .await?;
                    if result["thread"]["parentThreadId"].is_null() {
                        self.request("thread/resume", json!({"threadId":id,"excludeTurns":true}))
                            .await?;
                    }
                    Ok::<_, anyhow::Error>(())
                }
                .await;
                if restore.is_err() {
                    failed = true;
                }
            }
            loaded = self.loaded_roots().await?;
        }
        Ok((crate::policy::saved_roots(previous, loaded, failed), failed))
    }
}
