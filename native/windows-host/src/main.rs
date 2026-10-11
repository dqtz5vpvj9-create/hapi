#[cfg(windows)]
fn main() {
    if let Err(error) = hapi_windows_host::windows::run() {
        eprintln!("hapi-windows-host: {error:#}");
        std::process::exit(1);
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("hapi-windows-host runs on Windows; portable policy tests run on any host");
    std::process::exit(1);
}
