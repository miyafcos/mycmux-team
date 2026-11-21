use std::os::windows::io::{AsHandle, AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle};
use std::sync::{atomic::{AtomicBool, Ordering}, Arc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use windows::core::{HRESULT, Result, PCWSTR};
use windows::Win32::Foundation::{ERROR_NOT_FOUND, HANDLE};
use windows::Win32::System::IO::CancelSynchronousIo;
use windows::Win32::System::JobObjects::{
    CreateJobObjectW, JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
    QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

use super::POLL_INTERVAL;

#[derive(Default)]
pub(super) struct OutputCompletion {
    pub(super) reader: bool,
    pub(super) close: bool,
}

impl OutputCompletion {
    pub(super) fn complete(&self) -> bool { self.reader && self.close }
}

#[cfg(test)]
type CancelRead = Box<dyn FnMut(&JoinHandle<()>) -> Result<()> + Send>;

#[cfg(test)]
#[derive(Default)]
pub(super) struct OutputTestHooks {
    pub(super) cancel: Option<CancelRead>,
    pub(super) reaped: Option<std::sync::mpsc::SyncSender<()>>,
}

fn cancel_read(reader: &JoinHandle<()>) -> Result<()> {
    unsafe { CancelSynchronousIo(HANDLE(reader.as_raw_handle())) }
}

pub(super) fn finish_output(
    reader: JoinHandle<()>,
    closer: JoinHandle<()>,
    stop_reading: Arc<AtomicBool>,
    cancel_at: Instant,
    deadline: Instant,
    #[cfg(test)] mut hooks: OutputTestHooks,
) -> OutputCompletion {
    let mut reader = Some(reader);
    let mut closer = Some(closer);
    let mut done = OutputCompletion::default();
    let mut retry_cancel = true;
    loop {
        let now = Instant::now();
        if now >= deadline { break; }
        if reader.as_ref().is_some_and(JoinHandle::is_finished) {
            done.reader = reader.take().unwrap().join().is_ok();
        }
        if closer.as_ref().is_some_and(JoinHandle::is_finished) {
            done.close = closer.take().unwrap().join().is_ok();
        }
        if reader.is_none() && closer.is_none() { return done; }

        if let Some(worker) = reader.as_ref().filter(|_| retry_cancel && now >= cancel_at && Instant::now() < deadline) {
            stop_reading.store(true, Ordering::SeqCst);
            // The stop flag can race with the start of ReadFile. Retry only
            // while Windows sees no pending read and there is time remaining.
            #[cfg(not(test))]
            let result = cancel_read(worker);
            #[cfg(test)]
            let result = match &mut hooks.cancel {
                Some(cancel) => cancel(worker),
                None => cancel_read(worker),
            };
            retry_cancel = result.is_err_and(|error| error.code() == HRESULT::from_win32(ERROR_NOT_FOUND.0));
        }
        thread::sleep(POLL_INTERVAL.min(deadline.saturating_duration_since(Instant::now())));
    }

    // The reaper owns both worker handles, even when the attempt has timed out.
    stop_reading.store(true, Ordering::SeqCst);
    thread::spawn(move || {
        if let Some(reader) = reader { let _ = reader.join(); }
        if let Some(closer) = closer { let _ = closer.join(); }
        #[cfg(test)]
        if let Some(reaped) = hooks.reaped { let _ = reaped.send(()); }
    });
    done
}

pub(super) struct SetupJob(OwnedHandle);

impl SetupJob {
    pub(super) fn new() -> Result<Self> {
        let handle = unsafe { CreateJobObjectW(None, PCWSTR::null())? };
        let job = Self(unsafe { OwnedHandle::from_raw_handle(handle.0) });
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        unsafe {
            SetInformationJobObject(
                job.raw(), JobObjectExtendedLimitInformation, std::ptr::from_ref(&limits).cast(),
                std::mem::size_of_val(&limits) as u32,
            )?;
        }
        Ok(job)
    }

    pub(super) fn handle(&self) -> BorrowedHandle<'_> { self.0.as_handle() }

    fn raw(&self) -> HANDLE { HANDLE(self.0.as_raw_handle()) }

    pub(super) fn is_empty(&self) -> Result<bool> {
        Ok(self.accounting()?.ActiveProcesses == 0)
    }

    pub(super) fn accounting(&self) -> Result<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION> {
        let mut counts = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        unsafe {
            QueryInformationJobObject(
                self.raw(), JobObjectBasicAccountingInformation, std::ptr::from_mut(&mut counts).cast(),
                std::mem::size_of_val(&counts) as u32, None,
            )?;
        }
        Ok(counts)
    }

    pub(super) fn stop(&self) -> Result<bool> {
        if self.is_empty()? { return Ok(true); }
        unsafe { TerminateJobObject(self.raw(), 1)?; }
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if self.is_empty()? { return Ok(true); }
            if Instant::now() >= deadline { return Ok(false); }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[cfg(test)]
    pub(super) fn restrict_to_query(&mut self) -> Result<()> {
        use windows::Win32::Foundation::{DuplicateHandle, DUPLICATE_HANDLE_OPTIONS};
        use windows::Win32::System::Threading::GetCurrentProcess;
        const JOB_OBJECT_QUERY: u32 = 0x0004;
        let process = unsafe { GetCurrentProcess() };
        let mut handle = HANDLE::default();
        unsafe {
            DuplicateHandle(process, self.raw(), process, &mut handle, JOB_OBJECT_QUERY,
                false, DUPLICATE_HANDLE_OPTIONS(0))?;
        }
        self.0 = unsafe { OwnedHandle::from_raw_handle(handle.0) };
        Ok(())
    }
}
