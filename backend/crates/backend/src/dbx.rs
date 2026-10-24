//! Connections exported from DBX, read into saved profiles.
//!
//! DBX exports `{ connections, layout }` or a bare list of connections,
//! optionally sealed as `{ format: "dbx-encrypted", version: 1, salt, iv,
//! data }`: AES-256-GCM under a PBKDF2-SHA256 key of 100,000 iterations,
//! with the 16-byte tag after the ciphertext. The layout's groups become
//! folders, merged by name into the folders already saved.
//!
//! Nothing here connects: imported connections are saved as read, and
//! their passwords go to the host's credential store. Settings a profile
//! cannot carry are reported as warnings with stable keys
//! (`sshPassword`, `proxy`, ...) that the page translates.
//!
//! The page sends only the file's path, the export password, and the IDs
//! of the connections to import; both functions read the file again, so a
//! saved profile is never built from data the page sent.

use crate::service::{chosen_path, credential_failure, file_failure, invalid};
use crate::store::{is_same_connection, password_key, Store};
use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use hmac::Hmac;
use lithe_plugin_sdk::{Credentials, FunctionError, PluginError, Value};
use serde_json::json;
use sha2::Sha256;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, Read};
use std::path::Path;

/// The largest export read; DBX writes a few KiB per connection.
const MAXIMUM_FILE_BYTES: u64 = 16 << 20;

const ENCRYPTED_FORMAT: &str = "dbx-encrypted";
const KEY_ITERATIONS: u32 = 100_000;
const NONCE_BYTES: usize = 12;
const TAG_BYTES: usize = 16;

/// The defaults of a new profile in the page (`newProfile` in `model.ts`).
const SENSITIVE_COLUMN_PATTERNS: &[&str] = &["password", "secret", "token", "api_key"];
const SSH_PORT: u64 = 22;

/// What an export holds, matched against the saved profiles.
struct Plan {
    encrypted: bool,
    candidates: Vec<Candidate>,
    /// Parents before children.
    folders: Vec<Folder>,
    /// Connections of a database type Lithe does not support.
    unsupported: usize,
}

/// A connection of a supported type.
struct Candidate {
    /// The same on every read of the file: DBX's own connection ID, else
    /// one made from its position.
    id: String,
    /// The saved profile without its `id`, `folderID` still unset.
    profile: Value,
    password: String,
    warnings: Vec<&'static str>,
    /// The same connection as a saved profile.
    duplicate: bool,
    /// The DBX group it sits in.
    group: Option<String>,
}

/// A DBX group.
struct Folder {
    group: String,
    name: String,
    parent: Option<String>,
}

/// `connections.previewDBX { path, password? }`: what importing the file
/// would add, as `{ encrypted, connections: [{ id, name, kind, host, port,
/// duplicate, warnings }], unsupported, folders }`. A SQLite connection's
/// `host` is its file path.
///
/// An encrypted file without a `password` fails with
/// `database.dbxPasswordRequired`, a wrong one with
/// `database.dbxPasswordInvalid`.
pub fn preview(store: &Store, params: &Value) -> Result<Value, FunctionError> {
    let plan = read_plan(store, params)?;
    let connections: Vec<_> = plan
        .candidates
        .iter()
        .map(|candidate| {
            let profile = &candidate.profile;
            let host = if profile["kind"] == "sqlite" {
                &profile["path"]
            } else {
                &profile["host"]
            };
            json!({
                "id": candidate.id,
                "name": profile["name"],
                "kind": profile["kind"],
                "host": host,
                "port": profile["port"],
                "duplicate": candidate.duplicate,
                "warnings": candidate.warnings,
            })
        })
        .collect();
    Ok(json!({
        "encrypted": plan.encrypted,
        "connections": connections,
        "unsupported": plan.unsupported,
        "folders": plan.folders.len(),
    }))
}

/// `connections.importDBX { path, password?, selected }`: saves the
/// connections whose preview IDs are in `selected`, except duplicates, with
/// the folders they sit in, and stores their passwords to keep forever.
/// Answers `{ imported }`.
pub fn import(
    store: &Store,
    params: &Value,
    credentials: &Credentials,
) -> Result<Value, FunctionError> {
    let selected = params["selected"]
        .as_array()
        .and_then(|ids| {
            ids.iter()
                .map(Value::as_str)
                .collect::<Option<HashSet<_>>>()
        })
        .ok_or_else(|| invalid("\"selected\" must be a list of connection IDs."))?;
    let plan = read_plan(store, params)?;
    let (profiles, folders) = prepare(&plan, &selected);
    if profiles.is_empty() {
        return Ok(json!({ "imported": 0 }));
    }

    // Passwords are placed before the profiles are written, so a saved
    // profile never points at a password that failed to store.
    let mut stored = Vec::new();
    for (profile, password) in &profiles {
        let id = profile["id"].as_str().unwrap_or_default();
        if password.is_empty() {
            continue;
        }
        if let Err(error) = credentials.set(&password_key(id), password) {
            forget(credentials, &stored);
            return Err(credential_failure(error));
        }
        stored.push(id.to_string());
    }
    let added = match store.import_profiles(
        profiles
            .iter()
            .map(|(profile, _)| profile.clone())
            .collect(),
        folders,
    ) {
        Ok(added) => added,
        Err(error) => {
            forget(credentials, &stored);
            return Err(error.into());
        }
    };
    // A profile saved meanwhile may have made one a duplicate after all.
    let skipped: Vec<_> = stored
        .into_iter()
        .filter(|id| !added.contains(id))
        .collect();
    forget(credentials, &skipped);
    Ok(json!({ "imported": added.len() }))
}

/// Removes passwords stored for profiles that were not saved after all.
/// Best effort: the failure being reported matters more.
fn forget(credentials: &Credentials, ids: &[String]) {
    for id in ids {
        let _ = credentials.delete(&password_key(id));
    }
}

/// The profiles to save, with new IDs and their passwords, and the folders
/// they sit in: only the folders holding a selected connection, and their
/// ancestors, so deselected connections leave no empty folders behind.
fn prepare(plan: &Plan, selected: &HashSet<&str>) -> (Vec<(Value, String)>, Vec<Value>) {
    let folder_ids: HashMap<&str, String> = plan
        .folders
        .iter()
        .map(|folder| (folder.group.as_str(), new_id()))
        .collect();
    let parents: HashMap<&str, Option<&str>> = plan
        .folders
        .iter()
        .map(|folder| (folder.group.as_str(), folder.parent.as_deref()))
        .collect();
    let mut used = HashSet::new();
    let mut profiles = Vec::new();
    for candidate in &plan.candidates {
        if candidate.duplicate || !selected.contains(candidate.id.as_str()) {
            continue;
        }
        let mut profile = candidate.profile.clone();
        profile["id"] = json!(new_id());
        profile["folderID"] = json!(candidate
            .group
            .as_deref()
            .and_then(|group| folder_ids.get(group)));
        let mut group = candidate.group.as_deref();
        while let Some(current) = group {
            if !used.insert(current) {
                break;
            }
            group = parents.get(current).copied().flatten();
        }
        profiles.push((profile, candidate.password.clone()));
    }
    let folders = plan
        .folders
        .iter()
        .filter(|folder| used.contains(folder.group.as_str()))
        .map(|folder| {
            json!({
                "id": folder_ids[folder.group.as_str()],
                "name": folder.name,
                "parentID": folder.parent.as_deref().and_then(|parent| folder_ids.get(parent)),
            })
        })
        .collect();
    (profiles, folders)
}

fn read_plan(store: &Store, params: &Value) -> Result<Plan, FunctionError> {
    let path = chosen_path(&params["path"])?;
    let password = match &params["password"] {
        Value::Null => None,
        Value::String(password) => Some(password.as_str()),
        _ => return Err(invalid("\"password\" must be a string.").into()),
    };
    let bytes = read_file(path).map_err(|error| file_failure(path, error))?;
    let saved = store.connections()?;
    let saved_profiles = saved["profiles"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    Ok(parse(&bytes, password, saved_profiles)?)
}

fn read_file(path: &Path) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(MAXIMUM_FILE_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAXIMUM_FILE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "the file is larger than 16 MiB",
        ));
    }
    Ok(bytes)
}

/// Reads an export, decrypting it with `password` when it is sealed, and
/// marks the connections that duplicate one of `saved_profiles`.
fn parse(
    bytes: &[u8],
    password: Option<&str>,
    saved_profiles: &[Value],
) -> Result<Plan, PluginError> {
    let document: Value = serde_json::from_slice(bytes).map_err(|_| invalid_file())?;
    let encrypted = document["format"] == ENCRYPTED_FORMAT;
    let export = if encrypted {
        let password = password
            .filter(|password| !password.is_empty())
            .ok_or_else(|| {
                PluginError::new(
                    "database.dbxPasswordRequired",
                    "Enter the DBX export password to read this file.",
                )
            })?;
        serde_json::from_slice(&decrypt(&document, password)?).map_err(|_| invalid_file())?
    } else {
        document
    };
    let (connections, layout) = match &export {
        Value::Array(connections) => (connections, &Value::Null),
        Value::Object(object) => match object.get("connections") {
            Some(Value::Array(connections)) => (connections, &export["layout"]),
            _ => return Err(invalid_file()),
        },
        _ => return Err(invalid_file()),
    };
    if !connections.iter().all(Value::is_object) {
        return Err(invalid_file());
    }

    let (folders, connection_groups) = resolve_layout(layout);
    let ids = preview_ids(connections);
    let mut candidates = Vec::new();
    let mut unsupported = 0;
    for (connection, id) in connections.iter().zip(ids) {
        let Some(kind) = kind(text(connection, "db_type")) else {
            unsupported += 1;
            continue;
        };
        let profile = profile(connection, kind);
        let duplicate = saved_profiles
            .iter()
            .any(|saved| is_same_connection(saved, &profile));
        candidates.push(Candidate {
            id,
            warnings: warnings(connection, kind),
            password: text(connection, "password").to_string(),
            duplicate,
            group: connection_groups.get(text(connection, "id")).cloned(),
            profile,
        });
    }
    Ok(Plan {
        encrypted,
        candidates,
        folders,
        unsupported,
    })
}

fn decrypt(envelope: &Value, password: &str) -> Result<Vec<u8>, PluginError> {
    if envelope["version"].as_u64() != Some(1) {
        return Err(PluginError::new(
            "database.dbxUnsupportedVersion",
            "This DBX encrypted export version is not supported.",
        ));
    }
    let decode = |key: &str| {
        envelope[key]
            .as_str()
            .and_then(|encoded| BASE64.decode(encoded).ok())
    };
    let (Some(salt), Some(nonce), Some(sealed)) = (decode("salt"), decode("iv"), decode("data"))
    else {
        return Err(invalid_file());
    };
    if nonce.len() != NONCE_BYTES || sealed.len() < TAG_BYTES {
        return Err(invalid_file());
    }
    // AES-GCM opens the ciphertext with its tag appended, as DBX writes it.
    Aes256Gcm::new(&derive_key(password, &salt).into())
        .decrypt(Nonce::from_slice(&nonce), sealed.as_slice())
        .map_err(|_| {
            PluginError::new(
                "database.dbxPasswordInvalid",
                "The DBX export password is incorrect.",
            )
        })
}

fn derive_key(password: &str, salt: &[u8]) -> [u8; 32] {
    let mut key = [0; 32];
    pbkdf2::pbkdf2::<Hmac<Sha256>>(password.as_bytes(), salt, KEY_ITERATIONS, &mut key);
    key
}

/// The folders of DBX's layout, in the order its tree lists them, and the
/// group of each connection by DBX connection ID.
fn resolve_layout(layout: &Value) -> (Vec<Folder>, HashMap<String, String>) {
    let names: HashMap<&str, &str> = list(&layout["groups"])
        .iter()
        .map(|group| (text(group, "id"), text(group, "name")))
        .collect();
    let mut folders = Vec::new();
    let mut connection_groups = HashMap::new();
    visit(
        list(&layout["order"]),
        None,
        &names,
        &mut folders,
        &mut connection_groups,
    );
    (folders, connection_groups)
}

/// A group listed twice keeps its first place in the tree.
fn visit(
    entries: &[Value],
    parent: Option<&str>,
    names: &HashMap<&str, &str>,
    folders: &mut Vec<Folder>,
    connection_groups: &mut HashMap<String, String>,
) {
    for entry in entries {
        let id = text(entry, "id");
        match text(entry, "type") {
            "connection" => {
                if let Some(parent) = parent {
                    connection_groups.insert(id.to_string(), parent.to_string());
                }
            }
            "group" => {
                if !folders.iter().any(|folder| folder.group == id) {
                    let name = names.get(id).copied().unwrap_or_default();
                    folders.push(Folder {
                        group: id.to_string(),
                        name: if name.trim().is_empty() {
                            "Imported Group".to_string()
                        } else {
                            name.to_string()
                        },
                        parent: parent.map(str::to_string),
                    });
                }
                for connection in list(&entry["connectionIds"]) {
                    if let Some(connection) = connection.as_str() {
                        connection_groups.insert(connection.to_string(), id.to_string());
                    }
                }
                visit(
                    list(&entry["children"]),
                    Some(id),
                    names,
                    folders,
                    connection_groups,
                );
            }
            _ => {}
        }
    }
}

/// Each connection's preview ID: its DBX ID when present and unique, else
/// `#<position>`, made unique against the DBX IDs.
fn preview_ids(connections: &[Value]) -> Vec<String> {
    let mut taken: HashSet<String> = HashSet::new();
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for connection in connections {
        *counts.entry(text(connection, "id")).or_default() += 1;
    }
    let mut ids = Vec::with_capacity(connections.len());
    for connection in connections {
        let own = text(connection, "id");
        if !own.is_empty() && counts[own] == 1 {
            taken.insert(own.to_string());
            ids.push(Some(own.to_string()));
        } else {
            ids.push(None);
        }
    }
    ids.into_iter()
        .enumerate()
        .map(|(index, id)| {
            id.unwrap_or_else(|| {
                let mut id = format!("#{index}");
                while taken.contains(&id) {
                    id.push('#');
                }
                taken.insert(id.clone());
                id
            })
        })
        .collect()
}

/// The profile of a supported DBX connection, in the store's JSON shape.
fn profile(connection: &Value, kind: &'static str) -> Value {
    let sqlite = kind == "sqlite";
    let ssh = first_layer(connection, "ssh");
    let name = [
        text(connection, "name"),
        text(connection, "id"),
        text(connection, "host"),
        text(connection, "db_type"),
    ]
    .into_iter()
    .find(|name| !name.trim().is_empty())
    .unwrap_or(kind);
    let database = match text(connection, "database") {
        _ if sqlite => "",
        "" => default_database(kind),
        database => database,
    };
    let path = match kind {
        "sqlite" => text(connection, "host"),
        "nacos" => "/nacos",
        _ => "",
    };
    let port = match port_number(&connection["port"]) {
        _ if sqlite => 0,
        0 => default_port(kind),
        port => port,
    };
    let ssh_port = match ssh.map(|layer| port_number(&layer["port"])) {
        Some(port) if port > 0 => port,
        _ => SSH_PORT,
    };
    let ssh_text = |key: &str| ssh.map(|layer| text(layer, key)).unwrap_or_default();
    json!({
        "name": name,
        "kind": kind,
        "host": if sqlite { "" } else { text(connection, "host") },
        "port": port,
        "passwordPersistence": "forever",
        "username": text(connection, "username"),
        "database": database,
        "visibleDatabases": null,
        "path": path,
        "ssl": !sqlite && flag(connection, "ssl"),
        "folderID": null,
        "colorHex": text(connection, "color"),
        "readOnly": flag(connection, "read_only"),
        "productionProtection": flag(connection, "is_production"),
        "maskSensitiveFields": false,
        "sensitiveColumnPatterns": SENSITIVE_COLUMN_PATTERNS,
        "caCertificatePath": text(connection, "ca_cert_path"),
        "serverName": "",
        "sshHost": ssh_text("host"),
        "sshPort": ssh_port,
        "sshUsername": ssh_text("user"),
        "sshKeyPath": ssh_text("key_path"),
        "sshLocalPort": 0,
        "proxyURL": "",
    })
}

/// Settings of `connection` the profile does not carry, for the user to
/// review after importing.
fn warnings(connection: &Value, kind: &str) -> Vec<&'static str> {
    let active: Vec<&Value> = active_layers(connection).collect();
    let count = |kind: &str| {
        active
            .iter()
            .filter(|layer| text(layer, "type") == kind)
            .count()
    };
    let mut warnings = Vec::new();
    if count("ssh") > 1 {
        warnings.push("multipleSSH");
    }
    if first_layer(connection, "ssh").is_some_and(|layer| present(&layer["password"])) {
        warnings.push("sshPassword");
    }
    if count("http_tunnel") > 0 {
        warnings.push("httpTunnel");
    }
    if count("proxy") > 0 {
        warnings.push("proxy");
    }
    if present(&connection["connection_string"]) {
        warnings.push("connectionString");
    }
    if present(&connection["client_cert_path"]) || present(&connection["client_key_path"]) {
        warnings.push("clientCertificates");
    }
    if present(&connection["url_params"]) {
        warnings.push("urlParameters");
    }
    if kind == "redis"
        && connection["redis_connection_mode"]
            .as_str()
            .is_some_and(|mode| mode != "standalone")
    {
        warnings.push("redisSentinelOrCluster");
    }
    warnings
}

/// Transport layers not switched off, in DBX's order.
fn active_layers(connection: &Value) -> impl Iterator<Item = &Value> {
    list(&connection["transport_layers"])
        .iter()
        .filter(|layer| layer["enabled"].as_bool() != Some(false))
}

fn first_layer<'a>(connection: &'a Value, kind: &str) -> Option<&'a Value> {
    active_layers(connection).find(|layer| text(layer, "type") == kind)
}

/// The profile kind of a DBX `db_type`.
fn kind(db_type: &str) -> Option<&'static str> {
    Some(match db_type.to_lowercase().as_str() {
        "mysql" => "mysql",
        "mariadb" => "mariadb",
        "postgres" | "postgresql" => "postgresql",
        "sqlite" => "sqlite",
        "sqlserver" | "sql-server" => "sqlserver",
        "mongodb" | "mongo" => "mongodb",
        "redis" => "redis",
        "nacos" => "nacos",
        _ => return None,
    })
}

fn default_port(kind: &str) -> u64 {
    match kind {
        "mysql" | "mariadb" => 3306,
        "postgresql" => 5432,
        "sqlserver" => 1433,
        "mongodb" => 27017,
        "redis" => 6379,
        "nacos" => 8848,
        _ => 0,
    }
}

fn default_database(kind: &str) -> &'static str {
    match kind {
        "sqlserver" => "master",
        "mongodb" => "admin",
        "redis" => "0",
        _ => "",
    }
}

/// A port as DBX writes it, a number or a numeric string, within 0-65535.
fn port_number(value: &Value) -> u64 {
    let port = match value {
        Value::Number(number) => number.as_f64().unwrap_or_default(),
        Value::String(text) => text.trim().parse().unwrap_or_default(),
        _ => 0.0,
    };
    port.clamp(0.0, 65535.0) as u64
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or_default()
}

fn flag(value: &Value, key: &str) -> bool {
    value[key].as_bool().unwrap_or_default()
}

fn list(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or_default()
}

/// A setting that is set: a non-empty string, list, or object.
fn present(value: &Value) -> bool {
    match value {
        Value::String(text) => !text.trim().is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(fields) => !fields.is_empty(),
        _ => false,
    }
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string().to_uppercase()
}

fn invalid_file() -> PluginError {
    PluginError::new(
        "database.dbxInvalidFile",
        "The selected file is not a valid DBX connection export.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const PLAIN_EXPORT: &str = r##"{
      "connections": [
        {
          "id": "mysql-1", "name": "Production MySQL", "db_type": "mysql",
          "host": "db.example.com", "port": 3306, "username": "root",
          "password": "db-secret", "database": "app", "color": "#ff5500",
          "read_only": true, "is_production": true, "ssl": true,
          "ca_cert_path": "/tmp/ca.pem",
          "transport_layers": [{"type":"ssh","enabled":true,"host":"jump.example.com","port":22,"user":"deploy","key_path":"/tmp/id_ed25519"}]
        },
        { "id": "sqlite-1", "name": "Local SQLite", "db_type": "sqlite", "host": "/tmp/local.sqlite", "port": 0, "username": "", "password": "", "database": "" },
        { "id": "oracle-1", "name": "Oracle", "db_type": "oracle", "host": "oracle.example.com", "port": 1521, "username": "scott", "password": "tiger" }
      ],
      "layout": {
        "groups": [{"id":"g1","name":"Production","collapsed":false},{"id":"g2","name":"Local","collapsed":false}],
        "order": [{"type":"group","id":"g1","connectionIds":["mysql-1"],"children":[{"type":"group","id":"g2","connectionIds":["sqlite-1"]}]}]
      }
    }"##;

    /// Written by DBX's web export with the password "migration-pass"; the
    /// former built-in module's tests read the same file.
    const DBX_ENCRYPTED_EXPORT: &str = r#"{"format":"dbx-encrypted","version":1,"salt":"AAECAwQFBgcICQoLDA0ODw==","iv":"EBESExQVFhcYGRob","data":"fdwV5NDM/8LXPJqMyQgoQVkuOwMe+0VDPFR8HsEWD1AMIhPz1sHRRkmzd6ZLcBqnfcA57xCJz3Jtnbf+djnYI83EiNkr6iukZq1Ahd8aGy/r61/JdThx/NTaUgzn0mwAIcpxDl9uyBDwI0PO8WAaXbZyWbFumsLn3SJSEb8d"}"#;

    struct TemporaryDirectory(PathBuf);

    impl TemporaryDirectory {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir()
                .join(format!("lithe-database-dbx-{label}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&path);
            Self(path)
        }
    }

    impl Drop for TemporaryDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn candidate<'a>(plan: &'a Plan, id: &str) -> &'a Candidate {
        plan.candidates
            .iter()
            .find(|candidate| candidate.id == id)
            .unwrap()
    }

    fn encrypt(plaintext: &str, password: &str, version: u64) -> Vec<u8> {
        let salt = [7u8; 16];
        let nonce = [9u8; NONCE_BYTES];
        let sealed = Aes256Gcm::new(&derive_key(password, &salt).into())
            .encrypt(Nonce::from_slice(&nonce), plaintext.as_bytes())
            .unwrap();
        serde_json::to_vec(&json!({
            "format": ENCRYPTED_FORMAT, "version": version,
            "salt": BASE64.encode(salt), "iv": BASE64.encode(nonce), "data": BASE64.encode(sealed),
        }))
        .unwrap()
    }

    #[test]
    fn plain_exports_map_fields_and_layout_groups_to_folders() {
        let plan = parse(PLAIN_EXPORT.as_bytes(), None, &[]).unwrap();
        assert!(!plan.encrypted);
        assert_eq!(plan.candidates.len(), 2);
        assert_eq!(plan.unsupported, 1);

        let mysql = candidate(&plan, "mysql-1");
        assert_eq!(mysql.password, "db-secret");
        assert!(mysql.warnings.is_empty());
        assert_eq!(
            mysql.profile,
            json!({
                "name": "Production MySQL", "kind": "mysql", "host": "db.example.com", "port": 3306,
                "passwordPersistence": "forever", "username": "root", "database": "app",
                "visibleDatabases": null, "path": "", "ssl": true, "folderID": null,
                "colorHex": "#ff5500", "readOnly": true, "productionProtection": true,
                "maskSensitiveFields": false,
                "sensitiveColumnPatterns": ["password", "secret", "token", "api_key"],
                "caCertificatePath": "/tmp/ca.pem", "serverName": "",
                "sshHost": "jump.example.com", "sshPort": 22, "sshUsername": "deploy",
                "sshKeyPath": "/tmp/id_ed25519", "sshLocalPort": 0, "proxyURL": "",
            })
        );

        assert_eq!(
            plan.folders
                .iter()
                .map(|folder| (
                    folder.group.as_str(),
                    folder.name.as_str(),
                    folder.parent.as_deref()
                ))
                .collect::<Vec<_>>(),
            [("g1", "Production", None), ("g2", "Local", Some("g1"))]
        );
        assert_eq!(mysql.group.as_deref(), Some("g1"));
        assert_eq!(candidate(&plan, "sqlite-1").group.as_deref(), Some("g2"));
    }

    #[test]
    fn sqlite_hosts_become_file_paths() {
        let plan = parse(PLAIN_EXPORT.as_bytes(), None, &[]).unwrap();
        let sqlite = &candidate(&plan, "sqlite-1").profile;
        assert_eq!(sqlite["kind"], "sqlite");
        assert_eq!(sqlite["path"], "/tmp/local.sqlite");
        assert_eq!(sqlite["host"], "");
        assert_eq!(sqlite["port"], 0);
        assert_eq!(sqlite["database"], "");
        assert_eq!(sqlite["ssl"], false);
    }

    #[test]
    fn bare_lists_import_without_folders_and_ids_fall_back_to_positions() {
        let export = r##"[
          { "name": "Cache", "db_type": "Redis", "host": "cache", "port": "6380", "username": "", "password": "" },
          { "id": "pg", "name": "", "db_type": "postgres", "host": "pg.example.com", "port": 0 },
          { "id": "pg", "name": "Twin", "db_type": "postgresql", "host": "pg2", "port": 5433 },
          { "id": "#0", "name": "Clash", "db_type": "nacos", "host": "nacos", "port": 8848 }
        ]"##;
        let plan = parse(export.as_bytes(), None, &[]).unwrap();
        assert!(plan.folders.is_empty());
        let ids: Vec<_> = plan
            .candidates
            .iter()
            .map(|candidate| candidate.id.as_str())
            .collect();
        // Repeated DBX IDs fall back to positions too, never clashing with a DBX ID.
        assert_eq!(ids, ["#0#", "#1", "#2", "#0"]);
        let cache = &plan.candidates[0].profile;
        assert_eq!(cache["kind"], "redis");
        assert_eq!(cache["port"], 6380);
        assert_eq!(cache["database"], "0");
        let postgres = &plan.candidates[1].profile;
        assert_eq!(postgres["name"], "pg");
        assert_eq!(postgres["port"], 5432);
        assert_eq!(plan.candidates[3].profile["path"], "/nacos");
        assert!(plan
            .candidates
            .iter()
            .all(|candidate| candidate.group.is_none()));
    }

    #[test]
    fn encrypted_exports_need_the_right_password() {
        let sealed = encrypt(PLAIN_EXPORT, "correct horse", 1);
        assert_eq!(
            parse(&sealed, None, &[]).err().unwrap().code(),
            "database.dbxPasswordRequired"
        );
        assert_eq!(
            parse(&sealed, Some(""), &[]).err().unwrap().code(),
            "database.dbxPasswordRequired"
        );
        assert_eq!(
            parse(&sealed, Some("wrong"), &[]).err().unwrap().code(),
            "database.dbxPasswordInvalid"
        );
        let plan = parse(&sealed, Some("correct horse"), &[]).unwrap();
        assert!(plan.encrypted);
        assert_eq!(plan.candidates.len(), 2);
        assert_eq!(candidate(&plan, "mysql-1").password, "db-secret");

        let future = encrypt(PLAIN_EXPORT, "correct horse", 2);
        assert_eq!(
            parse(&future, Some("correct horse"), &[])
                .err()
                .unwrap()
                .code(),
            "database.dbxUnsupportedVersion"
        );
    }

    #[test]
    fn exports_sealed_by_dbx_open() {
        let bytes = DBX_ENCRYPTED_EXPORT.as_bytes();
        let plan = parse(bytes, Some("migration-pass"), &[]).unwrap();
        assert!(plan.encrypted);
        assert_eq!(plan.candidates.len(), 1);
        assert_eq!(plan.candidates[0].profile["name"], "M");
        assert_eq!(plan.candidates[0].password, "p");
        assert_eq!(
            parse(bytes, Some("wrong"), &[]).err().unwrap().code(),
            "database.dbxPasswordInvalid"
        );
    }

    #[test]
    fn other_files_are_refused() {
        for bytes in [&b"{"[..], b"{}", b"42", br#"{"connections": [1]}"#] {
            assert_eq!(
                parse(bytes, None, &[]).err().unwrap().code(),
                "database.dbxInvalidFile"
            );
        }
        let truncated =
            br#"{"format":"dbx-encrypted","version":1,"salt":"AA==","iv":"AA==","data":"AA=="}"#;
        assert_eq!(
            parse(truncated, Some("x"), &[]).err().unwrap().code(),
            "database.dbxInvalidFile"
        );
    }

    #[test]
    fn saved_connections_are_marked_duplicate_and_never_imported() {
        let saved = json!({ "name": "Production MySQL", "host": "db.example.com", "port": 3306, "path": "" });
        let plan = parse(PLAIN_EXPORT.as_bytes(), None, &[saved]).unwrap();
        assert!(candidate(&plan, "mysql-1").duplicate);
        assert!(!candidate(&plan, "sqlite-1").duplicate);

        let selected = HashSet::from(["mysql-1", "sqlite-1"]);
        let (profiles, folders) = prepare(&plan, &selected);
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].0["name"], "Local SQLite");
        // The SQLite connection's folder is imported with its parent.
        assert_eq!(folders.len(), 2);
    }

    #[test]
    fn unsupported_types_are_counted_not_listed() {
        let export = r#"[
          { "id": "a", "name": "A", "db_type": "oracle", "host": "h", "port": 1 },
          { "id": "b", "name": "B", "db_type": "clickhouse", "host": "h", "port": 1 },
          { "id": "c", "name": "C", "host": "h", "port": 1 }
        ]"#;
        let plan = parse(export.as_bytes(), None, &[]).unwrap();
        assert!(plan.candidates.is_empty());
        assert_eq!(plan.unsupported, 3);
    }

    #[test]
    fn settings_a_profile_cannot_carry_become_warnings() {
        let export = r#"[{
          "id": "r", "name": "R", "db_type": "redis", "host": "h", "port": 6379,
          "connection_string": "redis://h", "client_cert_path": "/c.pem", "url_params": "a=1",
          "redis_connection_mode": "sentinel",
          "transport_layers": [
            {"type": "ssh", "host": "first", "port": 2222, "user": "u", "password": "pw"},
            {"type": "ssh", "enabled": true, "host": "second", "port": 22},
            {"type": "ssh", "enabled": false, "host": "off", "port": 22},
            {"type": "http_tunnel", "host": "t", "port": 80},
            {"type": "proxy", "host": "p", "port": 1080, "proxy_type": "socks5"}
          ]
        }, {
          "id": "q", "name": "Q", "db_type": "mysql", "host": "h", "port": 3306,
          "transport_layers": [{"type": "proxy", "enabled": false, "host": "p", "port": 1}],
          "redis_connection_mode": "cluster"
        }]"#;
        let plan = parse(export.as_bytes(), None, &[]).unwrap();
        let redis = candidate(&plan, "r");
        assert_eq!(
            redis.warnings,
            [
                "multipleSSH",
                "sshPassword",
                "httpTunnel",
                "proxy",
                "connectionString",
                "clientCertificates",
                "urlParameters",
                "redisSentinelOrCluster",
            ]
        );
        // Only the first enabled SSH layer is kept.
        assert_eq!(redis.profile["sshHost"], "first");
        assert_eq!(redis.profile["sshPort"], 2222);
        assert!(candidate(&plan, "q").warnings.is_empty());
    }

    #[test]
    fn imports_reach_the_store_with_folders_merged_by_name() {
        let directory = TemporaryDirectory::new("import");
        let store = Store::new(directory.0.clone());
        store
            .save_organization(
                Vec::new(),
                vec![json!({ "id": "SAVED", "name": "production", "parentID": null })],
            )
            .unwrap();
        let plan = parse(PLAIN_EXPORT.as_bytes(), None, &[]).unwrap();
        let (profiles, folders) = prepare(&plan, &HashSet::from(["mysql-1", "sqlite-1"]));
        let ids: Vec<_> = profiles
            .iter()
            .map(|(profile, _)| profile["id"].as_str().unwrap().to_string())
            .collect();
        for id in &ids {
            let parsed = uuid::Uuid::parse_str(id).unwrap();
            assert_eq!(parsed.get_version_num(), 4);
            assert_eq!(id, &id.to_uppercase());
        }
        let added = store
            .import_profiles(
                profiles.into_iter().map(|(profile, _)| profile).collect(),
                folders,
            )
            .unwrap();
        assert_eq!(added, ids);

        let connections = store.connections().unwrap();
        let saved_folders = connections["folders"].as_array().unwrap();
        assert_eq!(saved_folders.len(), 2);
        let local = &saved_folders[1];
        assert_eq!(local["name"], "Local");
        assert_eq!(local["parentID"], "SAVED");
        let saved_profiles = connections["profiles"].as_array().unwrap();
        assert_eq!(saved_profiles[0]["folderID"], "SAVED");
        assert_eq!(saved_profiles[1]["folderID"], local["id"]);
        // Passwords never reach the state directory.
        let text = fs::read_to_string(directory.0.join("connections.json")).unwrap();
        assert!(!text.contains("db-secret"), "{text}");

        // Selecting only some connections leaves out folders nobody uses.
        let (profiles, folders) = prepare(&plan, &HashSet::from(["mysql-1"]));
        assert_eq!(profiles.len(), 1);
        assert_eq!(folders.len(), 1);
        assert_eq!(folders[0]["name"], "Production");
        let (profiles, folders) = prepare(&plan, &HashSet::new());
        assert!(profiles.is_empty() && folders.is_empty());
    }

    #[test]
    fn files_past_the_limit_are_refused() {
        let directory = TemporaryDirectory::new("limit");
        fs::create_dir_all(&directory.0).unwrap();
        let path = directory.0.join("big.json");
        let file = fs::File::create(&path).unwrap();
        file.set_len(MAXIMUM_FILE_BYTES + 1).unwrap();
        drop(file);
        assert_eq!(
            read_file(&path).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        fs::write(&path, PLAIN_EXPORT).unwrap();
        assert_eq!(read_file(&path).unwrap(), PLAIN_EXPORT.as_bytes());
    }
}
