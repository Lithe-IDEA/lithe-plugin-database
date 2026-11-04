//! Keeps stdout for protocol frames only.

use std::io::{self, Write};

/// The stream the protocol is written to. On Unix this is a duplicate of
/// the original stdout descriptor, and descriptor 1 is pointed at stderr, so
/// output printed by plugin code or its dependencies cannot corrupt the
/// protocol. Elsewhere it is stdout itself, and plugin code must not print.
pub(crate) fn protocol_output() -> Box<dyn Write + Send> {
    #[cfg(unix)]
    {
        use std::os::fd::FromRawFd;
        extern "C" {
            fn dup(fd: i32) -> i32;
            fn dup2(source: i32, target: i32) -> i32;
        }
        // SAFETY: `dup` and `dup2` only operate on the process's descriptor
        // table. The duplicate is a fresh descriptor that nothing else owns,
        // so the `File` becomes its single owner.
        unsafe {
            let protocol = dup(1);
            if protocol >= 0 {
                if dup2(2, 1) < 0 {
                    std::process::exit(1);
                }
                return Box::new(std::fs::File::from_raw_fd(protocol));
            }
        }
    }
    Box::new(io::stdout())
}
