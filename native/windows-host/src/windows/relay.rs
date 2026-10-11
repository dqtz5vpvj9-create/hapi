use super::process::Descriptor;
use crate::config::Config;
use anyhow::{Result, bail};
use socket2::{Domain, SockAddr, Socket, Type};
use std::{io, path::Path};
use tokio::{
    net::{
        TcpStream,
        windows::named_pipe::{NamedPipeServer, ServerOptions},
    },
    task::JoinSet,
};

// One listening instance remains available in addition to the connected
// clients. A client's lifetime is independent of an engine thread's lifetime.
const MAX_CLIENTS: usize = 64;

pub struct Relay {
    pipe_path: String,
    socket_path: std::path::PathBuf,
    descriptor: Descriptor,
    server: NamedPipeServer,
}

impl Relay {
    /// Bind before starting any roles. A running PowerShell deployment owns its
    /// pipe, so an accidental second deployment fails before starting an engine.
    pub fn bind(config: &Config) -> Result<Self> {
        let descriptor = Descriptor::for_user()?;
        let pipe_path = config.pipe_path();
        let server = create_server(&pipe_path, &descriptor, true)?;
        Ok(Self {
            pipe_path,
            socket_path: config.socket_path.clone(),
            descriptor,
            server,
        })
    }

    pub async fn run(mut self) -> Result<()> {
        let mut clients = JoinSet::new();
        loop {
            tokio::select! {
                result = self.server.connect(), if clients.len() < MAX_CLIENTS => {
                    result?;
                    let next = create_server(&self.pipe_path, &self.descriptor, false)?;
                    let mut pipe = std::mem::replace(&mut self.server, next);
                    let path = self.socket_path.clone();
                    clients.spawn(async move {
                        let mut socket = unix_connect(&path).await?;
                        tokio::io::copy_bidirectional(&mut pipe, &mut socket).await?;
                        Ok::<_, anyhow::Error>(())
                    });
                }
                result = clients.join_next(), if !clients.is_empty() => {
                    // An individual disconnected client must not take down the
                    // listener. Report transport errors without logging payloads.
                    if let Some(Err(error)) = result { eprintln!("relay client task: {error}"); }
                }
            }
        }
    }
}

fn create_server(path: &str, descriptor: &Descriptor, first: bool) -> Result<NamedPipeServer> {
    let mut attributes = descriptor.attributes();
    // Same-user + SYSTEM ACL, medium integrity, local connections only. The
    // descriptor lives across this call and Windows copies it during creation.
    let server = unsafe {
        ServerOptions::new()
            .first_pipe_instance(first)
            .reject_remote_clients(true)
            .max_instances(MAX_CLIENTS + 1)
            .create_with_security_attributes_raw(
                path,
                (&mut attributes as *mut windows_sys::Win32::Security::SECURITY_ATTRIBUTES).cast(),
            )?
    };
    Ok(server)
}

pub async fn unix_connect(path: &Path) -> Result<TcpStream> {
    // Windows AF_UNIX sockets support WinSock overlapped I/O. TcpStream here is
    // only Tokio's IOCP socket wrapper; no TCP listener/port is opened.
    let socket = Socket::new(Domain::UNIX, Type::STREAM, None)?;
    socket.set_nonblocking(true)?;
    match socket.connect(&SockAddr::unix(path)?) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
        Err(error) => bail!("connect local native socket: {error}"),
    }
    let stream = TcpStream::from_std(socket.into())?;
    stream.writable().await?;
    if let Some(error) = stream.take_error()? {
        return Err(error.into());
    }
    Ok(stream)
}
