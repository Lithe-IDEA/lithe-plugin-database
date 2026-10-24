//! The plugin functions the database window calls. Each one validates its
//! params, assembles a complete connection from the saved profile and its
//! password, and runs one engine method on the shared async runtime.
//!
//! Engine failures reach the page as `PluginError`s whose code is the
//! engine's code (`confirmation_required`, `read_only`, ...), so the page
//! can react to them; their messages never contain the password.
//!
//! A function result is limited to 1 MiB of JSON, so rows past that are
//! dropped from a result and the result says so, and CSV and JSON files are
//! read and written here, at a path the user chose in Lithe's file dialog,
//! instead of crossing to the page.

use crate::store::{password_key, PasswordPersistence, Store};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use lithe_plugin_sdk::{
    sdk_codes, Backend, Cancelled, Context, Credentials, FunctionError, PluginError, SdkError,
    Value,
};
use serde_json::json;
use std::fs;
use std::io::{self, Read, Write};
use std::path::Path;
use std::sync::Arc;
use tokio::runtime::Runtime;
use tokio_util::sync::CancellationToken;

/// Engine methods a page may call through `database.call`. Each takes the
/// connection plus its own params; `capabilities` and `checkWriteProtection`
/// are answered without connecting.
const ENGINE_METHODS: &[&str] = &[
    "applyChanges",
    "checkWriteProtection",
    "describeTable",
    "diagnostics",
    "execute",
    "explain",
    "exportSql",
    "exportSqlToFile",
    "importSql",
    "importSqlFile",
    "listDatabases",
    "listForeignKeys",
    "listIndexes",
    "listObjects",
    "listTables",
    "nacosDeleteConfig",
    "nacosGetConfig",
    "nacosListConfigs",
    "nacosListInstances",
    "nacosListServices",
    "nacosPublishConfig",
    "pageTable",
    "query",
    "redisDeleteKey",
    "redisFlushDatabase",
    "redisGetKey",
    "redisRenameKey",
    "redisReplaceHash",
    "redisScan",
    "redisSetString",
    "redisSetTTL",
    "restoreSql",
    "restoreSqlFile",
    "schemaChange",
    "testConnection",
    "transaction",
];

/// Engine methods `file.export` runs; each answers `{ encoding: "base64", data }`.
const EXPORT_METHODS: &[&str] = &["exportCsv", "exportJson"];

/// Engine methods `file.import` runs; each takes the file as base64 `data`.
const IMPORT_METHODS: &[&str] = &["importCsv", "importJson"];

/// What a result may serialize to: the SDK refuses results over 1 MiB.
const RESULT_BUDGET: usize = 1 << 20;

/// The largest file `file.import` reads; the engine holds it in memory.
const MAXIMUM_IMPORT_BYTES: u64 = 256 << 20;

/// Profile fields the engine reads, by their name in a saved profile.
const CONNECTION_FIELDS: &[&str] = &[
    "kind",
    "host",
    "port",
    "username",
    "database",
    "path",
    "ssl",
    "caCertificatePath",
    "serverName",
    "sshHost",
    "sshPort",
    "sshUsername",
    "sshKeyPath",
    "sshLocalPort",
    "proxyURL",
    "readOnly",
    "productionProtection",
];

const KINDS: &[&str] = &[
    "mysql",
    "mariadb",
    "postgresql",
    "sqlite",
    "sqlserver",
    "mongodb",
    "redis",
    "nacos",
];

pub struct Service {
    store: Store,
    runtime: Runtime,
}

impl Service {
    pub fn new(store: Store, runtime: Runtime) -> Arc<Self> {
        Arc::new(Self { store, runtime })
    }

    /// Declares every function on `backend`.
    pub fn install(self: &Arc<Self>, backend: &mut Backend) {
        let declare =
            |backend: &mut Backend,
             id: &str,
             handler: fn(&Service, Value, &Context) -> Result<Value, FunctionError>| {
                let service = Arc::clone(self);
                backend
                    .function(id, move |params, context| {
                        handler(&service, params, context)
                    })
                    .expect("valid function ID");
            };
        declare(backend, "workspace.load", Self::load);
        declare(backend, "profile.save", Self::save_profile);
        declare(backend, "profile.delete", Self::delete_profile);
        declare(backend, "profile.duplicate", Self::duplicate_profile);
        declare(backend, "organization.save", Self::save_organization);
        declare(backend, "connection.test", Self::test_connection);
        declare(backend, "database.call", Self::call);
        declare(backend, "file.export", Self::export_file);
        declare(backend, "file.import", Self::import_file);
        declare(backend, "history.list", Self::list_history);
        declare(backend, "history.append", Self::append_history);
        declare(backend, "connections.previewDBX", Self::preview_dbx);
        declare(backend, "connections.importDBX", Self::import_dbx);
    }

    /// `{ capabilities, profiles, folders }`; profiles never carry passwords.
    fn load(&self, _: Value, _: &Context) -> Result<Value, FunctionError> {
        let mut connections = self.store.connections()?;
        connections["capabilities"] = lithe_database_engine::capabilities();
        Ok(connections)
    }

    /// Saves `profile` (given an `id` when new) and, when `password` is a
    /// string, its password; an absent `password` keeps the current one,
    /// moving it when the profile's `passwordPersistence` changed.
    fn save_profile(&self, params: Value, context: &Context) -> Result<Value, FunctionError> {
        let mut profile = params["profile"].clone();
        if !profile.is_object() {
            return Err(invalid("\"profile\" must be an object.").into());
        }
        if !profile["kind"]
            .as_str()
            .is_some_and(|kind| KINDS.contains(&kind))
        {
            return Err(invalid("The profile has no supported database kind.").into());
        }
        if profile["name"]
            .as_str()
            .is_none_or(|name| name.trim().is_empty())
        {
            return Err(invalid("The profile needs a name.").into());
        }
        let id = match profile["id"].as_str() {
            Some(id) if is_profile_id(id) => id.to_string(),
            Some(_) => return Err(invalid("The profile ID is not valid.").into()),
            None => {
                let id = uuid::Uuid::new_v4().to_string().to_uppercase();
                profile["id"] = json!(id);
                id
            }
        };
        let persistence = PasswordPersistence::of(&profile);
        let credentials = context.credentials();
        let password = match &params["password"] {
            Value::String(password) => Some(password.clone()),
            Value::Null => self.current_password(&id, &credentials)?,
            _ => return Err(invalid("\"password\" must be a string.").into()),
        };
        // The password is placed before the profile is written, so a saved
        // profile never points at a password that failed to store.
        match (persistence, password) {
            (PasswordPersistence::Forever, Some(password)) => {
                credentials
                    .set(&password_key(&id), &password)
                    .map_err(credential_failure)?;
                self.store.forget_session_password(&id);
            }
            (PasswordPersistence::UntilRestart, Some(password)) => {
                self.store.set_session_password(&id, password);
                credentials
                    .delete(&password_key(&id))
                    .map_err(credential_failure)?;
            }
            (_, None) => {}
        }
        Ok(self.store.save_profile(profile)?)
    }

    fn delete_profile(&self, params: Value, context: &Context) -> Result<Value, FunctionError> {
        let id = profile_id(&params["id"])?;
        context
            .credentials()
            .delete(&password_key(id))
            .map_err(credential_failure)?;
        Ok(json!({ "deleted": self.store.delete_profile(id)? }))
    }

    fn save_organization(&self, params: Value, _: &Context) -> Result<Value, FunctionError> {
        let (Some(profiles), Some(folders)) =
            (params["profiles"].as_array(), params["folders"].as_array())
        else {
            return Err(invalid("\"profiles\" and \"folders\" must be lists.").into());
        };
        let saved = self.store.connections()?;
        let saved_ids: Vec<_> = saved["profiles"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|profile| profile["id"].clone())
            .collect();
        // Reordering must not add or drop a profile, whose password would
        // then be orphaned or missing.
        let mut given: Vec<_> = profiles
            .iter()
            .map(|profile| profile["id"].clone())
            .collect();
        let mut expected = saved_ids;
        given.sort_by_key(Value::to_string);
        expected.sort_by_key(Value::to_string);
        if given != expected {
            return Err(PluginError::new(
                "database.staleOrganization",
                "The connection list changed meanwhile; reload and try again.",
            )
            .into());
        }
        self.store
            .save_organization(profiles.clone(), folders.clone())?;
        Ok(Value::Null)
    }

    /// Tests a profile as edited, before it is saved. Without a `password`
    /// param the saved password of the profile's `id` is used.
    fn test_connection(&self, params: Value, context: &Context) -> Result<Value, FunctionError> {
        let profile = &params["profile"];
        if !profile["kind"]
            .as_str()
            .is_some_and(|kind| KINDS.contains(&kind))
        {
            return Err(invalid("The profile has no supported database kind.").into());
        }
        let password = match &params["password"] {
            Value::String(password) => password.clone(),
            _ => match profile["id"].as_str().filter(|id| is_profile_id(id)) {
                Some(id) => self
                    .current_password(id, &context.credentials())?
                    .unwrap_or_default(),
                None => String::new(),
            },
        };
        self.run(
            context,
            "testConnection",
            connection(profile, password),
            Value::Null,
        )
    }

    /// Runs `method` on the saved profile `profileID` with `params`.
    fn call(&self, params: Value, context: &Context) -> Result<Value, FunctionError> {
        let method = params["method"].as_str().unwrap_or_default();
        if !ENGINE_METHODS.contains(&method) {
            return Err(invalid(format!("{method:?} is not a database method.")).into());
        }
        let value = self.run_on_profile(&params, method, params["params"].clone(), context)?;
        Ok(fit_result(value)?)
    }

    /// Runs an export method on `profileID` and writes the file it produced
    /// to `path`; answers `{ bytes }`.
    fn export_file(&self, params: Value, context: &Context) -> Result<Value, FunctionError> {
        let method = params["method"].as_str().unwrap_or_default();
        if !EXPORT_METHODS.contains(&method) {
            return Err(invalid(format!("{method:?} is not an export method.")).into());
        }
        let path = chosen_path(&params["path"])?;
        let exported = self.run_on_profile(&params, method, params["params"].clone(), context)?;
        let bytes = exported["data"]
            .as_str()
            .and_then(|data| BASE64.decode(data).ok())
            .ok_or_else(|| FunctionError::internal(format!("{method} answered no base64 data")))?;
        context.check_cancelled()?;
        write_atomically(path, &bytes).map_err(|error| file_failure(path, error))?;
        Ok(json!({ "bytes": bytes.len() }))
    }

    /// Reads the file at `path` and runs an import method on `profileID`
    /// with it.
    fn import_file(&self, params: Value, context: &Context) -> Result<Value, FunctionError> {
        let method = params["method"].as_str().unwrap_or_default();
        if !IMPORT_METHODS.contains(&method) {
            return Err(invalid(format!("{method:?} is not an import method.")).into());
        }
        let path = chosen_path(&params["path"])?;
        let bytes = read_import(path).map_err(|error| file_failure(path, error))?;
        let mut method_params = match params["params"].clone() {
            Value::Object(object) => object,
            Value::Null => Default::default(),
            _ => return Err(invalid("\"params\" must be an object.").into()),
        };
        method_params.insert("data".into(), Value::String(BASE64.encode(bytes)));
        let value = self.run_on_profile(&params, method, Value::Object(method_params), context)?;
        Ok(fit_result(value)?)
    }

    /// Runs `method` on the saved profile `call.profileID` with its current
    /// password. A `call.database` string connects to that database instead
    /// of the profile's, as the sidebar does for each database it lists.
    fn run_on_profile(
        &self,
        call: &Value,
        method: &str,
        params: Value,
        context: &Context,
    ) -> Result<Value, FunctionError> {
        let id = profile_id(&call["profileID"])?;
        let database = match &call["database"] {
            Value::Null => None,
            Value::String(database) => Some(database.clone()),
            _ => return Err(invalid("\"database\" must be a string.").into()),
        };
        let mut profile = self.store.profile(id)?.ok_or_else(|| {
            PluginError::new(
                "database.unknownProfile",
                "The connection no longer exists.",
            )
        })?;
        if let Some(database) = database {
            profile["database"] = Value::String(database);
        }
        let password = self
            .current_password(id, &context.credentials())?
            .unwrap_or_default();
        self.run(context, method, connection(&profile, password), params)
    }

    /// Saves a copy of profile `id` named `name` under a new ID, with its
    /// password kept the same way.
    fn duplicate_profile(&self, params: Value, context: &Context) -> Result<Value, FunctionError> {
        let id = profile_id(&params["id"])?;
        let name = params["name"]
            .as_str()
            .filter(|name| !name.trim().is_empty())
            .ok_or_else(|| invalid("The copy needs a name."))?;
        let mut profile = self.store.profile(id)?.ok_or_else(|| {
            PluginError::new(
                "database.unknownProfile",
                "The connection no longer exists.",
            )
        })?;
        let copy = uuid::Uuid::new_v4().to_string().to_uppercase();
        profile["id"] = json!(copy);
        profile["name"] = json!(name);
        let credentials = context.credentials();
        match (
            PasswordPersistence::of(&profile),
            self.current_password(id, &credentials)?,
        ) {
            (PasswordPersistence::Forever, Some(password)) => credentials
                .set(&password_key(&copy), &password)
                .map_err(credential_failure)?,
            (PasswordPersistence::UntilRestart, Some(password)) => {
                self.store.set_session_password(&copy, password)
            }
            (_, None) => {}
        }
        Ok(self.store.save_profile(profile)?)
    }

    fn list_history(&self, _: Value, _: &Context) -> Result<Value, FunctionError> {
        Ok(Value::Array(self.store.history()?))
    }

    fn append_history(&self, params: Value, _: &Context) -> Result<Value, FunctionError> {
        let entry = &params["entry"];
        if !entry.is_object() || !entry["id"].is_string() {
            return Err(invalid("\"entry\" must be an object with an \"id\".").into());
        }
        self.store.append_history(entry.clone())?;
        Ok(Value::Null)
    }

    /// Reads a DBX connection export; see [`crate::dbx::preview`].
    fn preview_dbx(&self, params: Value, _: &Context) -> Result<Value, FunctionError> {
        crate::dbx::preview(&self.store, &params)
    }

    /// Saves connections chosen from a DBX export; see [`crate::dbx::import`].
    fn import_dbx(&self, params: Value, context: &Context) -> Result<Value, FunctionError> {
        crate::dbx::import(&self.store, &params, &context.credentials())
    }

    /// The password of a saved profile: the session copy, else the stored one.
    fn current_password(
        &self,
        id: &str,
        credentials: &Credentials,
    ) -> Result<Option<String>, FunctionError> {
        if let Some(password) = self.store.session_password(id) {
            return Ok(Some(password));
        }
        credentials
            .get(&password_key(id))
            .map_err(credential_failure)
    }

    /// Runs one engine method until it finishes or the call is cancelled;
    /// cancelling drops the method's future, which closes its connection.
    fn run(
        &self,
        context: &Context,
        method: &str,
        connection: Value,
        params: Value,
    ) -> Result<Value, FunctionError> {
        let mut params = match params {
            Value::Object(params) => params,
            Value::Null => Default::default(),
            _ => return Err(invalid("\"params\" must be an object.").into()),
        };
        params.insert("connection".into(), connection);
        let token = CancellationToken::new();
        let cancelled = token.clone();
        context.cancellation().on_cancel(move || cancelled.cancel());
        let outcome = self.runtime.block_on(async {
            tokio::select! {
                outcome = lithe_database_engine::dispatch(method, Value::Object(params)) => Some(outcome),
                () = token.cancelled() => None,
            }
        });
        match outcome {
            None => Err(Cancelled.into()),
            Some(Ok(value)) => Ok(value),
            Some(Err((code, message))) => Err(engine_failure(&code, message).into()),
        }
    }
}

/// The engine's connection object for a saved profile and its password.
fn connection(profile: &Value, password: String) -> Value {
    let mut connection = serde_json::Map::new();
    for field in CONNECTION_FIELDS {
        if let Some(value) = profile.get(*field).filter(|value| !value.is_null()) {
            connection.insert((*field).into(), value.clone());
        }
    }
    connection.insert("password".into(), Value::String(password));
    Value::Object(connection)
}

/// Keeps `value` within the result limit. Rows that do not fit are dropped
/// from the end and the result is marked `truncated` and `sizeLimited`, so
/// the page can say why; any other result that large is refused.
fn fit_result(mut value: Value) -> Result<Value, PluginError> {
    let size = |value: &Value| serde_json::to_vec(value).map_or(usize::MAX, |bytes| bytes.len());
    if size(&value) <= RESULT_BUDGET {
        return Ok(value);
    }
    let too_large = || {
        PluginError::new(
            "database.resultTooLarge",
            "The result is larger than 1 MiB. Narrow the query, or export it to a file.",
        )
    };
    let Some(rows) = value
        .get_mut("rows")
        .and_then(Value::as_array_mut)
        .map(std::mem::take)
    else {
        return Err(too_large());
    };
    value["truncated"] = Value::Bool(true);
    value["sizeLimited"] = Value::Bool(true);
    // Each kept row adds its own bytes and a separating comma.
    let mut remaining = RESULT_BUDGET
        .checked_sub(size(&value))
        .ok_or_else(too_large)?;
    let mut kept = Vec::new();
    for row in rows {
        let cost = size(&row) + 1;
        if cost > remaining {
            break;
        }
        remaining -= cost;
        kept.push(row);
    }
    value["rows"] = Value::Array(kept);
    Ok(value)
}

/// A path from Lithe's file dialog: absolute, so it never resolves against
/// the backend's working directory, the plugin's state.
pub(crate) fn chosen_path(value: &Value) -> Result<&Path, PluginError> {
    value
        .as_str()
        .map(Path::new)
        .filter(|path| path.is_absolute())
        .ok_or_else(|| invalid("\"path\" must be an absolute file path."))
}

/// Writes beside `path` and renames, so a failed export never leaves half a
/// file in place of what the user had there.
fn write_atomically(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "no file name"))?;
    let mut temporary_name = std::ffi::OsString::from(".");
    temporary_name.push(name);
    temporary_name.push(".lithe-export");
    let temporary = path.with_file_name(temporary_name);
    let written = (|| {
        let mut file = fs::File::create(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()
    })()
    .and_then(|()| fs::rename(&temporary, path));
    if written.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    written
}

fn read_import(path: &Path) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(MAXIMUM_IMPORT_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAXIMUM_IMPORT_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "the file is larger than 256 MiB",
        ));
    }
    Ok(bytes)
}

/// A file the user chose that cannot be read or written; the user knows the
/// path, so the message names it.
pub(crate) fn file_failure(path: &Path, error: io::Error) -> PluginError {
    PluginError::new(
        "database.fileFailed",
        format!("{}: {error}", path.display()),
    )
}

/// An engine failure the page can tell apart by the engine's code.
fn engine_failure(code: &str, message: String) -> PluginError {
    let code = if lithe_plugin_sdk::is_plugin_error_code(code) {
        code
    } else {
        "database.failed"
    };
    PluginError::new(code, message)
}

/// A credential store the page can explain, such as a missing permission or
/// a locked Keychain; anything else stays an internal failure.
pub(crate) fn credential_failure(error: SdkError) -> FunctionError {
    if error.code() == sdk_codes::CALL_CANCELLED {
        FunctionError::Cancelled
    } else if error.code() == sdk_codes::NOT_NEGOTIATED || error.code().starts_with("plugin.host.")
    {
        PluginError::new(
            "database.credentialsUnavailable",
            format!(
                "Lithe could not reach the system credential store: {}",
                error.message()
            ),
        )
        .into()
    } else {
        error.into()
    }
}

pub(crate) fn invalid(message: impl Into<String>) -> PluginError {
    PluginError::new("database.invalidParams", message)
}

fn profile_id(value: &Value) -> Result<&str, PluginError> {
    value
        .as_str()
        .filter(|id| is_profile_id(id))
        .ok_or_else(|| invalid("The connection ID is not valid."))
}

/// Profile IDs are UUIDs, which also keeps credential keys well formed.
fn is_profile_id(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connections_carry_only_engine_fields_and_the_password() {
        let profile = json!({
            "id": "4B0E1B67-7E0E-4C0C-9E43-0D5E9B7F4C11", "name": "Prod", "kind": "mysql",
            "host": "db", "port": 3306, "proxyURL": "ssh -W %h:%p bastion", "colorHex": "#f00",
            "visibleDatabases": null, "productionProtection": true,
        });
        assert_eq!(
            connection(&profile, "pw".into()),
            json!({
                "kind": "mysql", "host": "db", "port": 3306, "proxyURL": "ssh -W %h:%p bastion",
                "productionProtection": true, "password": "pw",
            })
        );
    }

    #[test]
    fn engine_codes_reach_the_page_when_they_are_identifiers() {
        assert_eq!(
            engine_failure("confirmation_required", "Confirm".into()).code(),
            "confirmation_required"
        );
        assert_eq!(
            engine_failure("bad code!", "x".into()).code(),
            "database.failed"
        );
    }

    #[test]
    fn rows_past_the_result_limit_are_dropped_and_marked() {
        let row = json!({ "id": 1, "text": "x".repeat(1000) });
        let rows: Vec<_> = (0..2000).map(|_| row.clone()).collect();
        let fitted =
            fit_result(json!({ "columns": ["id", "text"], "truncated": false, "rows": rows }))
                .unwrap();
        assert!(serde_json::to_vec(&fitted).unwrap().len() <= RESULT_BUDGET);
        assert_eq!(fitted["truncated"], true);
        assert_eq!(fitted["sizeLimited"], true);
        let kept = fitted["rows"].as_array().unwrap().len();
        assert!((1000..2000).contains(&kept), "{kept}");

        let small = json!({ "rows": [row], "truncated": false });
        assert_eq!(fit_result(small.clone()).unwrap(), small);
        let huge = json!({ "stringValue": "x".repeat(RESULT_BUDGET) });
        assert_eq!(
            fit_result(huge).unwrap_err().code(),
            "database.resultTooLarge"
        );
    }

    #[test]
    fn exports_replace_the_chosen_file_whole() {
        let directory =
            std::env::temp_dir().join(format!("lithe-database-export-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("rows.csv");
        fs::write(&path, "old").unwrap();
        write_atomically(&path, b"id\n1\n").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"id\n1\n");
        assert_eq!(read_import(&path).unwrap(), b"id\n1\n");
        // A failed write leaves no temporary file and the old content.
        let missing = directory.join("missing").join("rows.csv");
        assert!(write_atomically(&missing, b"x").is_err());
        let names: Vec<_> = fs::read_dir(&directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, ["rows.csv"]);
        fs::remove_dir_all(&directory).unwrap();

        assert!(chosen_path(&json!("relative.csv")).is_err());
        assert!(chosen_path(&json!(null)).is_err());
        assert!(chosen_path(&json!("/tmp/rows.csv")).is_ok());
    }

    #[test]
    fn every_engine_method_is_known_to_the_engine() {
        // An allowed method the engine does not implement would fail only
        // when a page first calls it.
        lithe_database_engine::install_drivers();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let directory =
            std::env::temp_dir().join(format!("lithe-database-methods-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("probe.sqlite");
        for method in ENGINE_METHODS
            .iter()
            .chain(EXPORT_METHODS)
            .chain(IMPORT_METHODS)
        {
            // Redis and Nacos methods exist only for their kinds. Port 1
            // refuses connections, so no local server is ever touched.
            let connection = match method {
                _ if method.starts_with("redis") => {
                    json!({ "kind": "redis", "host": "127.0.0.1", "port": 1 })
                }
                _ if method.starts_with("nacos") => {
                    json!({ "kind": "nacos", "host": "127.0.0.1", "port": 1 })
                }
                _ => json!({ "kind": "sqlite", "path": path }),
            };
            let outcome = runtime.block_on(lithe_database_engine::dispatch(
                method,
                json!({ "connection": connection }),
            ));
            if let Err((code, message)) = outcome {
                assert_ne!(code, "unknown_method", "{method}: {message}");
            }
        }
        std::fs::remove_dir_all(&directory).unwrap();
    }
}
