//! Wire constants and validation shared with Lithe's Rust Core
//! (`rust/lithe-core/src/lsp/interface/plugin_function.rs` in the Lithe
//! repository). The SDK checks the same rules locally so a plugin author sees
//! a mistake when declaring a function instead of as a refused session.

use serde_json::Value;

/// Plugin-function protocol versions this SDK answers, newest first.
/// Version 2 keeps every rule of version 1 and adds host services; version 3
/// adds workspace contexts, capability discovery, host notifications, and
/// `$/cancelRequest` for host requests.
pub const FUNCTIONS_VERSIONS: [u64; 3] = [3, 2, 1];
/// First plugin-function protocol version with host services.
pub const HOST_SERVICES_VERSION: u64 = 2;
/// First plugin-function protocol version with workspace contexts.
pub const CONTEXT_VERSION: u64 = 3;

pub(crate) mod methods {
    pub const INITIALIZE: &str = "initialize";
    pub const SHUTDOWN: &str = "shutdown";
    pub const EXIT: &str = "exit";
    pub const CANCEL_REQUEST: &str = "$/cancelRequest";
    pub const FUNCTION_INVOKE: &str = "lithe/function/invoke";
    pub const FUNCTION_REGISTER: &str = "lithe/function/register";
    pub const FUNCTION_UNREGISTER: &str = "lithe/function/unregister";
    pub const FUNCTION_PROGRESS: &str = "lithe/function/progress";
    pub const TERMINAL_CREATE: &str = "lithe/host/terminal/create";
    pub const TERMINAL_SHOW: &str = "lithe/host/terminal/show";
    pub const TERMINAL_CLOSE: &str = "lithe/host/terminal/close";
    pub const TERMINAL_REOPEN: &str = "lithe/host/terminal/reopen";
    pub const TERMINAL_DISPOSE: &str = "lithe/host/terminal/dispose";
    pub const TERMINAL_ON_EXIT: &str = "lithe/host/terminal/onExit";
    pub const HOST_PREFIX: &str = "lithe/host/";
    pub const CREDENTIALS_GET: &str = "lithe/host/credentials/get";
    pub const CREDENTIALS_SET: &str = "lithe/host/credentials/set";
    pub const CREDENTIALS_DELETE: &str = "lithe/host/credentials/delete";
    pub const GET_CAPABILITIES: &str = "lithe/host/getCapabilities";
    pub const SUBSCRIPTIONS_DISPOSE: &str = "lithe/host/subscriptions/dispose";
    pub const WORKSPACE_LIST_CONTEXTS: &str = "lithe/host/workspace/listContexts";
    pub const WORKSPACE_GET_CONTEXT: &str = "lithe/host/workspace/getContext";
    pub const WORKSPACE_GET_FOLDERS: &str = "lithe/host/workspace/getFolders";
    pub const WORKSPACE_READ_DIRECTORY: &str = "lithe/host/workspace/readDirectory";
    pub const WORKSPACE_STAT: &str = "lithe/host/workspace/stat";
    pub const WORKSPACE_READ_FILE: &str = "lithe/host/workspace/readFile";
    pub const WORKSPACE_WATCH: &str = "lithe/host/workspace/watch";
    pub const WORKSPACE_FIND_FILES: &str = "lithe/host/workspace/findFiles";
    pub const WORKSPACE_FIND_TEXT: &str = "lithe/host/workspace/findText";
    pub const DOCUMENTS_LIST: &str = "lithe/host/documents/list";
    pub const DOCUMENTS_GET_SNAPSHOT: &str = "lithe/host/documents/getSnapshot";
    pub const EDITOR_REGISTER_ACTIONS: &str = "lithe/host/editor/registerActions";
    pub const EDITOR_GET_ACTIVE: &str = "lithe/host/editor/getActive";
    pub const EDITOR_GET_SELECTIONS: &str = "lithe/host/editor/getSelections";
    pub const EDITOR_APPLY_EDITS: &str = "lithe/host/editor/applyEdits";
    pub const EDITOR_REPLACE_SELECTIONS: &str = "lithe/host/editor/replaceSelections";
    pub const EDITOR_INSERT_TEXT: &str = "lithe/host/editor/insertText";
    pub const EDITOR_OPEN: &str = "lithe/host/editor/open";
    pub const EDITOR_REVEAL: &str = "lithe/host/editor/reveal";
    pub const PREVIEW_OPEN_HTML: &str = "lithe/host/preview/openHTML";
    pub const BROWSER_OPEN_EXTERNAL: &str = "lithe/host/browser/openExternal";
    pub const WINDOW_SHOW_INFORMATION: &str = "lithe/host/window/showInformation";
    pub const WINDOW_SHOW_WARNING: &str = "lithe/host/window/showWarning";
    pub const WINDOW_SHOW_ERROR: &str = "lithe/host/window/showError";
    pub const DID_CHANGE_CONTEXTS: &str = "lithe/host/workspace/didChangeContexts";
    pub const SUBSCRIPTION_NOTIFY: &str = "lithe/host/subscriptions/notify";
    pub const COMMAND_DID_RUN: &str = "lithe/host/commands/didRun";
}

/// JSON-RPC and LSP error codes the SDK answers with.
pub(crate) mod error_codes {
    pub const PARSE_ERROR: i64 = -32700;
    pub const INVALID_REQUEST: i64 = -32600;
    pub const METHOD_NOT_FOUND: i64 = -32601;
    pub const INVALID_PARAMS: i64 = -32602;
    pub const INTERNAL_ERROR: i64 = -32603;
    pub const SERVER_NOT_INITIALIZED: i64 = -32002;
    pub const REQUEST_FAILED: i64 = -32000;
    pub const REQUEST_CANCELLED: i64 = -32800;
}

pub(crate) const MAX_FUNCTIONS: usize = 256;
const MAX_FUNCTION_ID_BYTES: usize = 128;
const MAX_PLUGIN_ERROR_CODE_BYTES: usize = 64;
pub(crate) const MAX_MESSAGE_BYTES: usize = 1024;
pub(crate) const MAX_RESULT_BYTES: usize = 1 << 20;
const MAX_CREDENTIAL_KEY_BYTES: usize = 128;
pub(crate) const MAX_CREDENTIAL_SECRET_BYTES: usize = 16 * 1024;
/// Host requests a backend may have unanswered at once; later ones wait.
pub(crate) const MAX_PENDING_HOST_REQUESTS: usize = 16;
/// Events kept for subscriptions whose answer has not been read yet.
pub(crate) const MAX_EARLY_EVENTS: usize = 128;
const MAX_COMMAND_ID_BYTES: usize = 128;
/// The largest integer JSON carries exactly.
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// Dot-separated lowerCamelCase segments, for example `snapshot.refresh`.
pub fn is_function_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_FUNCTION_ID_BYTES
        && value.split('.').all(|segment| {
            let mut characters = segment.chars();
            characters
                .next()
                .is_some_and(|first| first.is_ascii_lowercase())
                && characters.all(|character| character.is_ascii_alphanumeric())
        })
}

/// The plugin error code alphabet Core forwards as `pluginErrorCode`.
pub fn is_plugin_error_code(value: &str) -> bool {
    let mut characters = value.chars();
    value.len() <= MAX_PLUGIN_ERROR_CODE_BYTES
        && characters
            .next()
            .is_some_and(|first| first.is_ascii_alphabetic())
        && characters
            .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character))
}

/// A credential key: 1–128 ASCII letters, digits, `.`, `_`, `:`, or `-`.
pub fn is_credential_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_CREDENTIAL_KEY_BYTES
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._:-".contains(character))
}

/// A command ID from the plugin's manifest: 1–128 of `[a-z0-9.-]`.
pub fn is_command_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_COMMAND_ID_BYTES
        && value.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || ".-".contains(character)
        })
}

/// A context generation: a positive integer JSON carries exactly.
pub(crate) fn generation(value: &Value) -> Option<u64> {
    let generation = match value.as_u64() {
        Some(number) => number,
        None => {
            let number = value.as_f64()?;
            if number.fract() != 0.0 || !(1.0..=MAX_SAFE_INTEGER as f64).contains(&number) {
                return None;
            }
            number as u64
        }
    };
    (1..=MAX_SAFE_INTEGER)
        .contains(&generation)
        .then_some(generation)
}

/// Cuts `value` to `limit` UTF-8 bytes without splitting a character.
pub(crate) fn bounded_text(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        return value.to_string();
    }
    let mut end = limit;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn function_ids_are_dot_separated_lower_camel_case() {
        assert!(is_function_id("snapshot.refresh"));
        assert!(is_function_id("query.runAll2"));
        for invalid in [
            "",
            "Snapshot",
            "snapshot.",
            ".a",
            "a..b",
            "a-b",
            "a.B",
            "1a",
        ] {
            assert!(!is_function_id(invalid), "{invalid}");
        }
        assert!(!is_function_id(&"a".repeat(129)));
    }

    #[test]
    fn plugin_error_codes_and_credential_keys_use_their_alphabets() {
        assert!(is_plugin_error_code("db.connection-failed_2"));
        assert!(!is_plugin_error_code("2db"));
        assert!(!is_plugin_error_code(&"a".repeat(65)));
        assert!(is_credential_key("connection:prod.password"));
        assert!(!is_credential_key(""));
        assert!(!is_credential_key("has space"));
        assert!(!is_credential_key(&"k".repeat(129)));
        assert!(is_command_id("db.refresh-all2"));
        for invalid in ["", "DB.refresh", "db_refresh", "db refresh"] {
            assert!(!is_command_id(invalid), "{invalid}");
        }
        assert!(!is_command_id(&"a".repeat(129)));
    }

    #[test]
    fn generations_are_positive_integers_json_carries_exactly() {
        use serde_json::json;
        assert_eq!(generation(&json!(2)), Some(2));
        assert_eq!(generation(&json!(2.0)), Some(2));
        assert_eq!(generation(&json!(MAX_SAFE_INTEGER)), Some(MAX_SAFE_INTEGER));
        for invalid in [
            json!(0),
            json!(-1),
            json!(1.5),
            json!("2"),
            json!(null),
            json!(MAX_SAFE_INTEGER + 1),
        ] {
            assert_eq!(generation(&invalid), None, "{invalid}");
        }
    }

    #[test]
    fn bounded_text_never_splits_a_character() {
        assert_eq!(bounded_text("abc", 8), "abc");
        assert_eq!(bounded_text("aé", 2), "a");
        assert_eq!(bounded_text("日本語", 7), "日本");
    }
}
