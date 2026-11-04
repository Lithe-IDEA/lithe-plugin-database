//! Typed plugin facts transported to the host's litheLogging 1 catalog.
use crate::backend::{lock, Shared};
use crate::{FunctionError, SdkError};
use serde_json::json;
use std::sync::Arc;
use std::time::Instant;

pub(crate) const MAX_INTEGER: u64 = 9_007_199_254_740_991;
pub(crate) const OPERATIONS: &[&str] = &[
    "initialize",
    "shutdown",
    "notification",
    "function-call",
    "result-encoding",
    "lithe/build/model",
    "lithe/build/dependencies",
    "lithe/build/execute",
    "lithe/build/test",
    "lithe/build/discoverTests",
    "lithe/build/prepareRun",
    "lithe/build/prepareDebug",
    "lithe/vcs/status",
    "lithe/vcs/baseContent",
    "lithe/vcs/history",
    "lithe/vcs/fileHistory",
    "lithe/vcs/annotate",
    "lithe/vcs/checkin",
    "lithe/vcs/rollback",
    "lithe/vcs/update",
    "lithe/vcs/fileOperation",
    "lithe/vcs/resolve",
    "lithe/vcs/cleanup",
];
fn token(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._:/-$".contains(&c))
}

pub(crate) fn request_operation_id(
    operation_id: &serde_json::Value,
    request_id: &serde_json::Value,
) -> Option<String> {
    if let Some(id) = operation_id.as_str().filter(|id| token(id, 128)) {
        return Some(id.to_string());
    }
    let fallback = if let Some(id) = request_id.as_str() {
        id.to_string()
    } else if let Some(id) = request_id
        .as_i64()
        .filter(|id| id.unsigned_abs() <= MAX_INTEGER)
    {
        id.to_string()
    } else if let Some(id) = request_id.as_u64().filter(|id| *id <= MAX_INTEGER) {
        id.to_string()
    } else {
        return None;
    };
    token(&fallback, 128).then_some(fallback)
}
/// A lightweight handle using the existing protocol writer, without a queue or file I/O.
#[derive(Clone)]
pub struct Diagnostics {
    pub(crate) shared: Arc<Shared>,
    pub(crate) operation_id: Option<String>,
}
impl Diagnostics {
    /// Records a handled degradation; code is a controlled category, never an error message.
    pub fn degraded(
        &self,
        operation: &str,
        code: &str,
        count: Option<u64>,
    ) -> Result<(), SdkError> {
        self.record("degraded", operation, Some(code), count, None)
    }
    /// Records a real recovery, with the same controlled operation and category.
    pub fn recovered(
        &self,
        operation: &str,
        code: &str,
        count: Option<u64>,
    ) -> Result<(), SdkError> {
        self.record("recovered", operation, Some(code), count, None)
    }
    pub(crate) fn terminal(
        &self,
        operation: &str,
        error: Option<&FunctionError>,
        started: Instant,
    ) {
        let code = error.map(|error| match error {
            FunctionError::Plugin(error) => error.code(),
            FunctionError::Cancelled => "cancelled",
            FunctionError::Internal(_) => "internal_error",
        });
        let _ = self.record(
            if error.is_some() {
                "operationFailed"
            } else {
                "operationFinished"
            },
            operation,
            code,
            None,
            Some(started.elapsed().as_millis().min(u128::from(MAX_INTEGER)) as u64),
        );
    }
    pub(crate) fn record(
        &self,
        kind: &str,
        operation: &str,
        code: Option<&str>,
        count: Option<u64>,
        duration: Option<u64>,
    ) -> Result<(), SdkError> {
        let state = lock(&self.shared.state);
        if !OPERATIONS.contains(&operation) && !state.functions.contains_key(operation) {
            return Err(SdkError::new(
                "sdk.logging.invalidOperation",
                "Diagnostics need a registered operation.",
            ));
        }
        let enabled = state.logging;
        drop(state);
        if code.is_some_and(|code| !token(code, 64)) {
            return Err(SdkError::new(
                "sdk.logging.invalidCode",
                "Diagnostics need a controlled code.",
            ));
        }
        if count.is_some_and(|count| count > MAX_INTEGER) {
            return Err(SdkError::new(
                "sdk.logging.invalidCount",
                "Diagnostics need a safe count.",
            ));
        }
        if !enabled {
            return Ok(());
        }
        let mut params = json!({ "kind": kind, "operation": if operation.len() <= 64 {operation} else {"function-call"} });
        if let Some(code) = code {
            params["code"] = json!(code);
        }
        if let Some(count) = count {
            params["count"] = json!(count);
        }
        if let Some(duration) = duration {
            params["durationMs"] = json!(duration);
        }
        if let Some(id) = self.operation_id.as_deref().filter(|id| token(id, 128)) {
            params["operationId"] = json!(id);
        }
        let mut state = lock(&self.shared.state);
        if !state.logging_ready {
            if state.early_diagnostics.len() < 8 {
                state.early_diagnostics.push(params);
            }
            return Ok(());
        }
        drop(state);
        self.shared
            .write(&json!({ "jsonrpc": "2.0", "method": "lithe/log", "params": params }));
        Ok(())
    }
}
