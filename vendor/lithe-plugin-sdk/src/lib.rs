//! Official SDK for Lithe plugin backends written in Rust.
//!
//! A plugin backend is the one long-lived process a plugin declares under
//! `backend` in `plugin.json`; Lithe starts it when one of the plugin's own
//! web pages first calls a function. It speaks the LSP base protocol on
//! stdio and implements, from
//! [plugin contract v1](https://github.com/Lithe-IDEA/lithe-plugin-docs/blob/main/contract/v1/README.md):
//!
//! - **`litheFunctions` 1 to 3**: plugin functions with progress,
//!   cancellation, and registration at runtime;
//! - **[`Host`] services** of versions 2 and 3: the plugin's own
//!   [`Credentials`] in the platform's secret store from version 2; from
//!   version 3 workspace contexts, files, documents, the editor, previews,
//!   the browser, window messages, capability discovery, subscriptions, and
//!   the commands and context changes the host notifies.
//!
//! The SDK owns the wire format, negotiation, cancellation, and error
//! mapping; plugin code supplies handlers. Each call runs on a thread of its
//! own, so handlers may block. A handler returns `Ok(value)` with a JSON
//! result, a [`PluginError`] the plugin's UI can tell apart by its code, or
//! any other error, which reaches the host only as a generic failure while
//! automatic diagnostics omit its contents. A panic ends only its call;
//! SDK catch boundaries suppress raw panic payload printing.
//!
//! See [`Backend`] for a minimal backend.

mod backend;
mod diagnostics;
mod error;
mod framing;
mod host;
mod panic_boundary;
mod protocol;
mod stdio;

pub use backend::{Backend, BackendHandle, Cancellation, Context, Initialize};
pub use diagnostics::Diagnostics;
pub use error::{sdk_codes, Cancelled, FunctionError, PluginError, SdkError, HOST_ERROR_CODES};
pub use host::{
    Browser, Credentials, Documents, Editor, Event, Host, Preview, Subscription, Subscriptions,
    Terminal, Window, Workspace, WorkspaceContext,
};
pub use protocol::{is_command_id, is_credential_key, is_function_id, is_plugin_error_code};
pub use serde_json::Value;
