use crate::config::{Command, Config, Connection, quote_windows_argument};
use anyhow::{Context, Result, bail, ensure};
use serde::Serialize;
use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString, c_void},
    fs::OpenOptions,
    mem::{size_of, zeroed},
    os::windows::{
        ffi::{OsStrExt, OsStringExt},
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::{Path, PathBuf},
    ptr::{null, null_mut},
};
use windows_sys::Win32::{
    Foundation::*,
    Security::{Authorization::*, *},
    System::{
        JobObjects::*,
        RemoteDesktop::ProcessIdToSessionId,
        StationsAndDesktops::*,
        SystemServices::{JOB_OBJECT_QUERY, SE_GROUP_INTEGRITY},
        Threading::*,
    },
};

pub fn wide(value: impl AsRef<OsStr>) -> Vec<u16> {
    value.as_ref().encode_wide().chain(Some(0)).collect()
}

fn check(success: i32) -> Result<()> {
    if success == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}

fn owned(handle: HANDLE) -> Result<OwnedHandle> {
    ensure!(
        !handle.is_null() && handle != INVALID_HANDLE_VALUE,
        "{}",
        std::io::Error::last_os_error()
    );
    // SAFETY: handle was just created by a Win32 function; ownership is unique.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}

pub struct Descriptor(*mut c_void);
impl Descriptor {
    pub fn for_user() -> Result<Self> {
        Self::for_user_and_participant(None)
    }

    fn for_user_and_participant(participant: Option<(&str, u32)>) -> Result<Self> {
        let sid = identity()?.user_sid;
        let participant = participant
            .map(|(sid, access)| format!("(A;;0x{access:x};;;{sid})"))
            .unwrap_or_default();
        let sddl = wide(format!("D:P(A;;GA;;;SY)(A;;GA;;;{sid}){participant}S:(ML;;NW;;;ME)"));
        let mut descriptor = null_mut();
        // SAFETY: input is NUL-terminated; API allocates the descriptor.
        unsafe {
            check(ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                null_mut(),
            ))?;
        }
        Ok(Self(descriptor))
    }

    pub fn attributes(&self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.0,
            bInheritHandle: 0,
        }
    }
}
impl Drop for Descriptor {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub pid: u32,
    pub session: u32,
    pub user_sid: String,
    pub administrator: bool,
    pub integrity: u32,
}

fn token() -> Result<OwnedHandle> {
    let mut handle = null_mut();
    unsafe {
        check(OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT,
            &mut handle,
        ))?;
    }
    owned(handle)
}

fn token_information(handle: HANDLE, class: TOKEN_INFORMATION_CLASS) -> Result<Vec<u64>> {
    let mut size = 0;
    unsafe {
        GetTokenInformation(handle, class, null_mut(), 0, &mut size);
    }
    ensure!(size > 0, "{}", std::io::Error::last_os_error());
    // u64 backing keeps Win32's pointer-containing token records aligned.
    let mut buffer = vec![0u64; (size as usize).div_ceil(8)];
    unsafe {
        check(GetTokenInformation(
            handle,
            class,
            buffer.as_mut_ptr().cast(),
            size,
            &mut size,
        ))?;
    }
    Ok(buffer)
}

pub fn identity() -> Result<Identity> {
    let token = token()?;
    let user = token_information(token.as_raw_handle(), TokenUser)?;
    let user = unsafe { &*user.as_ptr().cast::<TOKEN_USER>() };
    let mut text = null_mut();
    unsafe {
        check(ConvertSidToStringSidW(user.User.Sid, &mut text))?;
    }
    let sid = unsafe {
        let mut len = 0;
        while *text.add(len) != 0 {
            len += 1;
        }
        let sid = String::from_utf16_lossy(std::slice::from_raw_parts(text, len));
        LocalFree(text.cast());
        sid
    };
    let integrity = token_information(token.as_raw_handle(), TokenIntegrityLevel)?;
    let label = unsafe { &*integrity.as_ptr().cast::<TOKEN_MANDATORY_LABEL>() };
    let level = unsafe {
        *GetSidSubAuthority(
            label.Label.Sid,
            u32::from(*GetSidSubAuthorityCount(label.Label.Sid)) - 1,
        )
    };
    let mut admin_sid = null_mut();
    unsafe {
        check(ConvertStringSidToSidW(
            wide("S-1-5-32-544").as_ptr(),
            &mut admin_sid,
        ))?;
    }
    let mut admin = 0;
    let result = unsafe { CheckTokenMembership(null_mut(), admin_sid, &mut admin) };
    unsafe {
        LocalFree(admin_sid);
    }
    check(result)?;
    let pid = std::process::id();
    let mut session = 0;
    unsafe {
        check(ProcessIdToSessionId(pid, &mut session))?;
    }
    Ok(Identity {
        pid,
        session,
        user_sid: sid,
        administrator: admin != 0,
        integrity: level,
    })
}

pub struct Job(OwnedHandle);
impl Job {
    fn new(kill_descendants: bool, name: Option<&str>) -> Result<Self> {
        let name = name.map(wide);
        let descriptor = Descriptor::for_user()?;
        let attributes = descriptor.attributes();
        let handle =
            unsafe { CreateJobObjectW(&attributes, name.as_ref().map_or(null(), |v| v.as_ptr())) };
        let exists = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
        let job = Self(owned(handle)?);
        ensure!(!exists, "another host already owns this runtime job");
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        if kill_descendants {
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        }
        unsafe {
            check(SetInformationJobObject(
                job.0.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ))?;
        }
        Ok(job)
    }

    fn assign(&self, process: HANDLE) -> Result<()> {
        unsafe { check(AssignProcessToJobObject(self.0.as_raw_handle(), process)) }
    }
}

pub struct Process {
    // Drop the job first: it owns engine/native descendants. A Runner's job has
    // no kill-on-close flag so detached sessions survive replacement of Runner.
    _job: Option<Job>,
    handle: OwnedHandle,
    pub id: u32,
}

impl Process {
    fn finish_launch(info: PROCESS_INFORMATION, job: Job) -> Result<Self> {
        let handle = owned(info.hProcess)?;
        let thread = owned(info.hThread)?;
        let assigned = job.assign(handle.as_raw_handle());
        if let Err(error) = assigned {
            unsafe {
                TerminateProcess(handle.as_raw_handle(), 1);
            }
            return Err(error);
        }
        if unsafe { ResumeThread(thread.as_raw_handle()) } == u32::MAX {
            unsafe {
                TerminateProcess(handle.as_raw_handle(), 1);
            }
            bail!("resume child: {}", std::io::Error::last_os_error());
        }
        Ok(Self {
            _job: Some(job),
            handle,
            id: info.dwProcessId,
        })
    }

    pub fn exit_code(&self) -> Result<Option<u32>> {
        match unsafe { WaitForSingleObject(self.handle.as_raw_handle(), 0) } {
            WAIT_TIMEOUT => Ok(None),
            WAIT_OBJECT_0 => {
                let mut code = 0;
                unsafe {
                    check(GetExitCodeProcess(self.handle.as_raw_handle(), &mut code))?;
                }
                Ok(Some(code))
            }
            _ => Err(std::io::Error::last_os_error().into()),
        }
    }

    pub fn terminate(&self) -> Result<()> {
        if self.exit_code()?.is_none() {
            unsafe {
                check(TerminateProcess(self.handle.as_raw_handle(), 1))?;
            }
        }
        Ok(())
    }

    pub fn stop(&mut self) -> Result<()> {
        let result = self.terminate();
        // Keep the process handle until the supervisor observes actual exit.
        // Closing this role's job also terminates engine/native descendants.
        self._job.take();
        result
    }

    /// Runner can replace itself during a handoff. Only adopt its state PID if
    /// it is the configured binary inside THIS bootstrap's ownership job.
    pub fn adopt_runner(config: &Config) -> Result<Option<Self>> {
        let state = config.root.join("state/runner.state.json");
        if !state.exists() {
            return Ok(None);
        }
        let state: serde_json::Value = serde_json::from_slice(&std::fs::read(state)?)?;
        let Some(pid) = state["pid"]
            .as_u64()
            .and_then(|pid| u32::try_from(pid).ok())
        else {
            return Ok(None);
        };
        let raw = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE | PROCESS_TERMINATE,
                0,
                pid,
            )
        };
        if raw.is_null() {
            return Ok(None);
        }
        let handle = owned(raw)?;
        let mut buffer = vec![0u16; 32768];
        let mut length = buffer.len() as u32;
        unsafe {
            check(QueryFullProcessImageNameW(
                handle.as_raw_handle(),
                0,
                buffer.as_mut_ptr(),
                &mut length,
            ))?;
        }
        let path = PathBuf::from(OsString::from_wide(&buffer[..length as usize]));
        if !path
            .as_os_str()
            .eq_ignore_ascii_case(config.roles.runner.executable.as_os_str())
        {
            return Ok(None);
        }
        let job =
            owned(unsafe { OpenJobObjectW(JOB_OBJECT_QUERY, 0, wide(job_name(config)).as_ptr()) })?;
        let mut in_job = 0;
        unsafe {
            check(IsProcessInJob(
                handle.as_raw_handle(),
                job.as_raw_handle(),
                &mut in_job,
            ))?;
        }
        if in_job == 0 {
            return Ok(None);
        }
        let process = Self {
            _job: None,
            handle,
            id: pid,
        };
        if process.exit_code()?.is_some() {
            return Ok(None);
        }
        Ok(Some(process))
    }

    pub fn spawn(config: &Config, role: &str, command: &Command) -> Result<Self> {
        let codex = config.codex()?;
        let executable = if command.executable == Path::new("@codex") {
            codex.clone()
        } else {
            command.executable.clone()
        };
        let mut environment: BTreeMap<OsString, OsString> = std::env::vars_os().collect();
        // Windows environment keys are case insensitive. Remove inherited
        // variants before replacing PATH/TEMP/HAPI variables.
        let mut set = |key: &str, value: OsString| {
            environment.retain(|old, _| !old.eq_ignore_ascii_case(OsStr::new(key)));
            environment.insert(key.into(), value);
        };
        let mut path = vec![codex.parent().context("Codex directory")?.to_path_buf()];
        path.extend(config.path_prefix.iter().cloned());
        if let Some(inherited) = std::env::var_os("PATH") {
            path.extend(std::env::split_paths(&inherited));
        }
        set("PATH", std::env::join_paths(path)?);
        set("HAPI_HOME", config.root.join("state").into_os_string());
        set("TEMP", config.root.join("temp").into_os_string());
        set("TMP", config.root.join("temp").into_os_string());
        if command.hub_credentials {
            let credentials: Connection = serde_json::from_slice(
                &std::fs::read(&config.connection_file).context("read Hub connection file")?,
            )
            .context("parse Hub connection file")?;
            set("HAPI_API_URL", credentials.hub.into());
            set("CLI_API_TOKEN", credentials.token.into());
        }
        for (key, value) in &command.environment {
            set(key, value.into());
        }
        let mut entries: Vec<_> = environment.into_iter().collect();
        entries.sort_by_cached_key(|(key, _)| key.to_string_lossy().to_uppercase());
        let mut block = Vec::new();
        for (key, value) in entries {
            block.extend(key.encode_wide());
            block.push('=' as u16);
            block.extend(value.encode_wide());
            block.push(0);
        }
        block.push(0);

        let log_path = config.root.join(format!("logs/{role}-console.log"));
        super::supervisor::rotate(&log_path, true)?;
        let log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)?;
        let input = OpenOptions::new().read(true).open("NUL")?;
        let handles = [log.as_raw_handle(), input.as_raw_handle()];
        for handle in handles {
            unsafe {
                check(SetHandleInformation(
                    handle,
                    HANDLE_FLAG_INHERIT,
                    HANDLE_FLAG_INHERIT,
                ))?;
            }
        }
        let mut attributes = AttributeList::handles(&handles)?;
        let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
        startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = input.as_raw_handle();
        startup.StartupInfo.hStdOutput = log.as_raw_handle();
        startup.StartupInfo.hStdError = log.as_raw_handle();
        startup.lpAttributeList = attributes.pointer();
        let mut arguments = vec![quote_windows_argument(&executable.to_string_lossy())];
        arguments.extend(
            command
                .arguments
                .iter()
                .map(|arg| quote_windows_argument(arg)),
        );
        let mut line = wide(arguments.join(" "));
        let mut info = unsafe { zeroed() };
        let job = Job::new(role != "runner", None)?;
        unsafe {
            check(CreateProcessW(
                wide(&executable).as_ptr(),
                line.as_mut_ptr(),
                null(),
                null(),
                1,
                CREATE_NO_WINDOW
                    | CREATE_SUSPENDED
                    | CREATE_UNICODE_ENVIRONMENT
                    | EXTENDED_STARTUPINFO_PRESENT,
                block.as_ptr().cast(),
                wide(&command.directory).as_ptr(),
                &startup.StartupInfo,
                &mut info,
            ))?;
        }
        Self::finish_launch(info, job)
    }
}

struct AttributeList(Vec<usize>);
impl AttributeList {
    fn handles(handles: &[HANDLE]) -> Result<Self> {
        let mut bytes = 0;
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut bytes);
        }
        let mut list = Self(vec![0; bytes.div_ceil(size_of::<usize>())]);
        unsafe {
            check(InitializeProcThreadAttributeList(
                list.pointer(),
                1,
                0,
                &mut bytes,
            ))?;
            check(UpdateProcThreadAttribute(
                list.pointer(),
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                handles.as_ptr().cast(),
                size_of_val(handles),
                null_mut(),
                null(),
            ))?;
        }
        Ok(list)
    }
    fn pointer(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.0.as_mut_ptr().cast()
    }
}
impl Drop for AttributeList {
    fn drop(&mut self) {
        unsafe {
            DeleteProcThreadAttributeList(self.pointer());
        }
    }
}

fn job_name(config: &Config) -> String {
    format!("Local\\HapiOwnership-{}", config.pipe_name)
}

pub fn require_bootstrap_job(config: &Config) -> Result<()> {
    let job =
        owned(unsafe { OpenJobObjectW(JOB_OBJECT_QUERY, 0, wide(job_name(config)).as_ptr()) })
            .context("supervisor must be launched by its bootstrap")?;
    let mut member = 0;
    unsafe {
        check(IsProcessInJob(
            GetCurrentProcess(),
            job.as_raw_handle(),
            &mut member,
        ))?;
    }
    ensure!(
        member != 0,
        "supervisor is outside its bootstrap ownership job"
    );
    Ok(())
}

struct Desktop {
    desktop: HDESK,
    station: HWINSTA,
}
impl Drop for Desktop {
    fn drop(&mut self) {
        unsafe {
            if !self.desktop.is_null() {
                CloseDesktop(self.desktop);
            }
            if !self.station.is_null() {
                CloseWindowStation(self.station);
            }
        }
    }
}

pub fn bootstrap(config: &Config, path: &Path) -> Result<()> {
    for directory in ["logs", "state", "temp"] {
        std::fs::create_dir_all(config.root.join(directory))?;
    }
    let original = token()?;
    let mut restricted = null_mut();
    unsafe {
        check(CreateRestrictedToken(
            original.as_raw_handle(),
            DISABLE_MAX_PRIVILEGE | LUA_TOKEN,
            0,
            null(),
            0,
            null(),
            0,
            null(),
            &mut restricted,
        ))?;
    }
    let restricted = owned(restricted)?;
    let mut sid = null_mut();
    unsafe {
        check(ConvertStringSidToSidW(
            wide("S-1-16-8192").as_ptr(),
            &mut sid,
        ))?;
    }
    let label = TOKEN_MANDATORY_LABEL {
        Label: SID_AND_ATTRIBUTES {
            Sid: sid,
            Attributes: SE_GROUP_INTEGRITY as u32,
        },
    };
    let level_result = unsafe {
        SetTokenInformation(
            restricted.as_raw_handle(),
            TokenIntegrityLevel,
            (&label as *const TOKEN_MANDATORY_LABEL).cast(),
            size_of::<TOKEN_MANDATORY_LABEL>() as u32 + GetLengthSid(sid),
        )
    };
    unsafe {
        LocalFree(sid);
    }
    check(level_result)?;
    let descriptor = Descriptor::for_user()?;
    let mut dacl = null_mut();
    let (mut present, mut defaulted) = (0, 0);
    unsafe {
        check(GetSecurityDescriptorDacl(
            descriptor.0,
            &mut present,
            &mut dacl,
            &mut defaulted,
        ))?;
    }
    let default_dacl = TOKEN_DEFAULT_DACL { DefaultDacl: dacl };
    unsafe {
        check(SetTokenInformation(
            restricted.as_raw_handle(),
            TokenDefaultDacl,
            (&default_dacl as *const TOKEN_DEFAULT_DACL).cast(),
            size_of::<TOKEN_DEFAULT_DACL>() as u32,
        ))?;
    }
    // S4U batch desktop ACLs can depend on an enabled Administrators SID. Use
    // the same private station/desktop strategy as TaskHost.cs, never WinSta0.
    let name = format!("HapiBatch-{}", std::process::id());
    // Codex's separate sandbox accounts must initialize USER32 before their
    // runner can enter its policy-specific private desktop. Grant only the
    // standard noninteractive participant rights, not WRITE_DAC/WRITE_OWNER.
    // Pipe/job/token descriptors remain restricted to the owner and SYSTEM.
    let participant = config.sandbox_bootstrap_group_sid.as_deref();
    let station_descriptor = Descriptor::for_user_and_participant(
        participant.map(|sid| (sid, 0x2006E)),
    )?;
    let desktop_descriptor = Descriptor::for_user_and_participant(
        participant.map(|sid| (sid, 0x200CF)),
    )?;
    let station_attributes = station_descriptor.attributes();
    let desktop_attributes = desktop_descriptor.attributes();
    let mut desktop = Desktop {
        station: null_mut(),
        desktop: null_mut(),
    };
    let previous = unsafe { GetProcessWindowStation() };
    desktop.station =
        unsafe { CreateWindowStationW(wide(&name).as_ptr(), 0, 0xF037F, &station_attributes) };
    ensure!(
        !desktop.station.is_null(),
        "create private station: {}",
        std::io::Error::last_os_error()
    );
    unsafe {
        check(SetProcessWindowStation(desktop.station))?;
    }
    desktop.desktop = unsafe {
        CreateDesktopW(
            wide("Default").as_ptr(),
            null(),
            null(),
            0,
            0xF01FF,
            &desktop_attributes,
        )
    };
    let desktop_error = std::io::Error::last_os_error();
    unsafe {
        check(SetProcessWindowStation(previous))?;
    }
    ensure!(
        !desktop.desktop.is_null(),
        "create private desktop: {desktop_error}"
    );
    let executable = std::env::current_exe()?;
    let mut line = wide(format!(
        "{} supervise --config {}",
        quote_windows_argument(&executable.to_string_lossy()),
        quote_windows_argument(&path.to_string_lossy())
    ));
    let mut startup: STARTUPINFOW = unsafe { zeroed() };
    let mut desktop_name = wide(format!("{name}\\Default"));
    startup.cb = size_of::<STARTUPINFOW>() as u32;
    startup.lpDesktop = desktop_name.as_mut_ptr();
    let job = Job::new(true, Some(&job_name(config)))?;
    let mut info = unsafe { zeroed() };
    unsafe {
        check(CreateProcessAsUserW(
            restricted.as_raw_handle(),
            wide(executable).as_ptr(),
            line.as_mut_ptr(),
            null(),
            null(),
            0,
            CREATE_NO_WINDOW | CREATE_SUSPENDED,
            null(),
            wide(&config.root).as_ptr(),
            &startup,
            &mut info,
        ))?;
    }
    let child = Process::finish_launch(info, job)?;
    let wait = unsafe { WaitForSingleObject(child.handle.as_raw_handle(), INFINITE) };
    ensure!(
        wait == WAIT_OBJECT_0,
        "wait for supervisor: {}",
        std::io::Error::last_os_error()
    );
    let code = child.exit_code()?.context("supervisor still running")?;
    ensure!(code == 0, "supervisor exited with code {code}");
    Ok(())
}

pub fn singleton(config: &Config) -> Result<OwnedHandle> {
    let descriptor = Descriptor::for_user()?;
    let attributes = descriptor.attributes();
    let handle = unsafe {
        CreateMutexW(
            &attributes,
            0,
            wide(format!("Local\\HapiSupervisor-{}", config.pipe_name)).as_ptr(),
        )
    };
    let exists = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
    let handle = owned(handle)?;
    ensure!(!exists, "another supervisor is already running");
    Ok(handle)
}
