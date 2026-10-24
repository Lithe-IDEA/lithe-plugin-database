//! End-to-end check of the database plugin's packaged backend against Rust
//! Core, through the same JSON commands a host sends.
//!
//! The test plays the host: Core validates the manifest and expands the
//! backend launch plan, the backend starts under the plugin's backend
//! provider ID, and Core's `hostRequest` events are answered from an
//! in-memory credential store, as the macOS host answers them from the
//! Keychain. The scenario drives a SQLite connection through the functions
//! the page calls: saving it with a password, testing it, running SQL,
//! production protection, read-only, CSV export and import, history, a
//! restart, and deletion. The package must be unchanged afterwards and the
//! state directory must never hold the password.
//!
//! This file lives in lithe-plugin-database. `scripts/e2e.mjs` copies it into
//! `rust/lithe-core/tests/` of a Lithe checkout and runs it there, with
//! `LITHE_DATABASE_PLUGIN_PACKAGE` naming the package `scripts/package.mjs`
//! staged in `dist/`.

use lithe_core::execute_json;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Bound for any single wait; a broken backend fails here instead of hanging CI.
const WAIT: Duration = Duration::from_secs(20);
const PASSWORD: &str = "s3cr3t-e2e";

#[test]
fn the_database_plugin_backend_serves_a_sqlite_connection() {
    let Some(package) = std::env::var_os("LITHE_DATABASE_PLUGIN_PACKAGE") else {
        eprintln!("skipped: set LITHE_DATABASE_PLUGIN_PACKAGE to run the database plugin end-to-end check");
        return;
    };
    let package = PathBuf::from(package).canonicalize().expect("package path");
    let manifest: Value =
        serde_json::from_slice(&fs::read(package.join("plugin.json")).expect("plugin.json"))
            .expect("plugin.json is JSON");
    let plugin_id = manifest["id"].as_str().expect("plugin ID").to_string();
    let package_before = listing(&package);
    let validated = core("plugins.declarative.validate", json!({ "manifest": manifest }));
    assert_eq!(validated["status"], "ok", "{validated}");

    let fixture = Fixture::new();
    let state = fixture.root.join("state");
    fs::create_dir_all(&state).expect("state directory");
    let database = fixture.root.join("people.sqlite");
    let csv = fixture.root.join("people.csv");
    let plan = launch_plan(&manifest, &package, &state);
    assert_eq!(plan["backend"]["hostServices"], json!(["credentials"]));
    let mut credentials = BTreeMap::new();

    let mut host = Host::start(&plugin_id, &package, &plan, &state);
    assert_eq!(
        host.functions(),
        [
            "connection.test",
            "connections.importDBX",
            "connections.previewDBX",
            "database.call",
            "file.export",
            "file.import",
            "history.append",
            "history.list",
            "organization.save",
            "profile.delete",
            "profile.duplicate",
            "profile.save",
            "workspace.load",
        ]
    );
    let loaded = host.value(&mut credentials, "workspace.load", json!({}));
    assert_eq!(loaded["profiles"], json!([]));
    assert!(loaded["capabilities"].is_object(), "{loaded}");

    // Saving puts the password in the host's credential store, not the state.
    let profile = json!({ "kind": "sqlite", "name": "People", "path": database });
    let saved = host.value(
        &mut credentials,
        "profile.save",
        json!({ "profile": profile, "password": PASSWORD }),
    );
    let id = saved["id"].as_str().expect("saved profile ID").to_string();
    assert_eq!(
        credentials,
        BTreeMap::from([(format!("connection:{id}:password"), PASSWORD.to_string())])
    );
    let tested = host.value(&mut credentials, "connection.test", json!({ "profile": saved }));
    assert_eq!(tested["connected"], true, "{tested}");

    let sql = |method: &str, sql: &str, confirmed: bool| {
        json!({ "profileID": id, "method": method, "params": { "sql": sql, "confirmed": confirmed } })
    };
    for statement in [
        "CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
        "INSERT INTO people (id, name) VALUES (1, 'Ada'), (2, 'Grace')",
    ] {
        host.value(&mut credentials, "database.call", sql("execute", statement, false));
    }
    let count = |host: &mut Host, credentials: &mut BTreeMap<String, String>| {
        host.value(credentials, "database.call", sql("query", "SELECT id, name FROM people ORDER BY id", false))["rows"]
            .as_array()
            .expect("rows")
            .len()
    };
    assert_eq!(count(&mut host, &mut credentials), 2);

    // Export writes the chosen file in the backend; nothing crosses to the page.
    let exported = host.value(
        &mut credentials,
        "file.export",
        json!({ "profileID": id, "method": "exportCsv", "params": { "sql": "SELECT id, name FROM people ORDER BY id" }, "path": csv }),
    );
    let text = fs::read_to_string(&csv).expect("exported CSV");
    assert_eq!(exported["bytes"], json!(text.len()), "{exported}");
    assert!(text.contains("Ada") && text.contains("Grace"), "{text}");

    // Production protection: dangerous SQL waits for confirmation, also
    // when it is sent as a query.
    let mut protected = saved.clone();
    protected["productionProtection"] = json!(true);
    host.value(&mut credentials, "profile.save", json!({ "profile": protected }));
    for method in ["execute", "query"] {
        let refused = host.call(&mut credentials, "database.call", sql(method, "DELETE FROM people", false));
        assert_eq!(refused["error"]["pluginErrorCode"], "confirmation_required", "{refused}");
    }
    assert_eq!(count(&mut host, &mut credentials), 2);
    host.value(&mut credentials, "database.call", sql("execute", "DELETE FROM people", true));
    assert_eq!(count(&mut host, &mut credentials), 0);

    // Read-only refuses every write, whatever the params claim.
    let mut read_only = saved.clone();
    read_only["readOnly"] = json!(true);
    host.value(&mut credentials, "profile.save", json!({ "profile": read_only }));
    let mut bypass = sql("execute", "INSERT INTO people (id, name) VALUES (3, 'Linus')", true);
    bypass["params"]["allowWrite"] = json!(true);
    let refused = host.call(&mut credentials, "database.call", bypass);
    assert_eq!(refused["error"]["pluginErrorCode"], "read_only", "{refused}");
    let refused = host.call(
        &mut credentials,
        "file.import",
        json!({ "profileID": id, "method": "importCsv", "params": { "table": "people" }, "path": csv }),
    );
    assert_eq!(refused["error"]["pluginErrorCode"], "read_only", "{refused}");
    let refused = host.call(
        &mut credentials,
        "file.export",
        json!({ "profileID": id, "method": "exportCsv", "params": { "sql": "DELETE FROM people RETURNING *" }, "path": csv }),
    );
    assert_eq!(refused["error"]["pluginErrorCode"], "read_only", "{refused}");

    // Import reads the chosen file back in the backend.
    host.value(&mut credentials, "profile.save", json!({ "profile": saved }));
    host.value(
        &mut credentials,
        "file.import",
        json!({ "profileID": id, "method": "importCsv", "params": { "table": "people" }, "path": csv }),
    );
    assert_eq!(count(&mut host, &mut credentials), 2);

    let entry = json!({ "id": "e2e-1", "profileID": id, "sql": "SELECT 1", "executedAt": 1_760_000_000_000_u64 });
    host.value(&mut credentials, "history.append", json!({ "entry": entry }));
    assert_eq!(host.value(&mut credentials, "history.list", json!({})), json!([entry]));

    // A restart keeps the profile, its history, and its stored password.
    host.stop();
    drop(host);
    let mut host = Host::start(&plugin_id, &package, &plan, &state);
    let loaded = host.value(&mut credentials, "workspace.load", json!({}));
    assert_eq!(loaded["profiles"][0]["id"], json!(id), "{loaded}");
    assert_eq!(count(&mut host, &mut credentials), 2);
    for entry in fs::read_dir(&state).expect("state directory") {
        let path = entry.expect("state entry").path();
        let text = fs::read_to_string(&path).unwrap_or_default();
        assert!(!text.contains(PASSWORD), "{} holds the password", path.display());
    }

    // Deleting forgets the password and the history with the profile.
    let deleted = host.value(&mut credentials, "profile.delete", json!({ "id": id }));
    assert_eq!(deleted, json!({ "deleted": true }));
    assert!(credentials.is_empty(), "{credentials:?}");
    assert_eq!(host.value(&mut credentials, "history.list", json!({})), json!([]));
    host.stop();
    drop(host);

    assert!(listing(&package) == package_before, "the plugin package changed at runtime");
    let left: BTreeSet<_> = fs::read_dir(&state)
        .expect("state directory")
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        left,
        BTreeSet::from(["connections.json".to_string(), "sql-history.json".to_string()])
    );
}

fn core(command: &str, payload: Value) -> Value {
    let request = json!({ "id": format!("database-e2e-{command}"), "command": command, "payload": payload });
    let response: Value = serde_json::from_str(&execute_json(&request.to_string()))
        .expect("Core response should be JSON");
    assert_eq!(response["ok"], true, "{command} failed: {response}");
    response["data"].clone()
}

fn launch_plan(manifest: &Value, package: &Path, state: &Path) -> Value {
    let plan = core(
        "plugins.declarative.languageServerLaunchPlan",
        json!({
            "manifest": manifest,
            "backend": true,
            "request": {
                "pluginDirectory": package,
                "stateDirectory": state,
                "architecture": if cfg!(target_arch = "aarch64") { "arm64" } else { "x86_64" },
            }
        }),
    );
    assert_eq!(plan["status"], "ok", "{plan}");
    assert_eq!(plan["plan"]["launch"]["kind"], "packaged");
    plan["plan"].clone()
}

/// Every file of a directory with its contents, to prove the package is unchanged.
fn listing(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut files = BTreeMap::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory).expect("readable directory") {
            let path = entry.expect("directory entry").path();
            if path.is_dir() {
                pending.push(path);
            } else {
                let contents = fs::read(&path).expect("readable file");
                files.insert(path.strip_prefix(root).unwrap().to_path_buf(), contents);
            }
        }
    }
    files
}

/// The temporary state directory and database, removed even when an assertion fails.
struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("lithe-database-plugin-e2e-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("fixture directory");
        // The backend sees canonical paths (macOS /var is /private/var).
        Self { root: root.canonicalize().expect("fixture path") }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

/// One running backend session. Dropping it stops the process and removes
/// the session, so a failed assertion leaves no backend behind.
struct Host {
    session: String,
    plugin_id: String,
    events: Vec<Value>,
    answered: BTreeSet<String>,
    operations: usize,
}

impl Host {
    /// Starts the backend as the host does: the packaged executable, under
    /// the plugin's backend provider ID, with the state directory as root and
    /// working directory and the plan's host services.
    fn start(plugin_id: &str, package: &Path, plan: &Value, state: &Path) -> Self {
        let executable = package.join(plan["launch"]["path"].as_str().expect("packaged path"));
        let started = core(
            "lsp.startServer",
            json!({
                "providerId": format!("pluginBackend:{plugin_id}"),
                "pluginId": plugin_id,
                "executablePath": executable,
                "arguments": plan["arguments"],
                "rootUri": format!("file://{}/", state.display()),
                "workingDirectory": state,
                "hostServices": plan["backend"]["hostServices"],
                "initializeTimeoutMilliseconds": WAIT.as_millis() as u64,
                "requestTimeoutMilliseconds": WAIT.as_millis() as u64,
                "shutdownTimeoutMilliseconds": 5000,
            }),
        );
        let mut host = Self {
            session: started["sessionId"].as_str().expect("session ID").to_string(),
            plugin_id: plugin_id.to_string(),
            events: Vec::new(),
            answered: BTreeSet::new(),
            operations: 0,
        };
        host.await_event("the backend to become ready", |event| {
            event["type"] == "stateChanged" && event["state"] == "ready"
        });
        host
    }

    fn await_event(&mut self, description: &str, matches: impl Fn(&Value) -> bool) -> Value {
        let deadline = Instant::now() + WAIT;
        loop {
            if let Some(event) = self.events.iter().find(|event| matches(event)) {
                return event.clone();
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(!remaining.is_zero(), "timed out waiting for {description}; events: {:#?}", self.events);
            self.drain(remaining);
        }
    }

    fn drain(&mut self, remaining: Duration) {
        let drained = core(
            "lsp.waitEvents",
            json!({ "sessionId": self.session, "timeoutMilliseconds": remaining.as_millis().min(200) as u64 }),
        );
        self.events.extend(drained["events"].as_array().cloned().unwrap_or_default());
    }

    /// The registry after the latest `functionsChanged` event.
    fn functions(&mut self) -> Vec<String> {
        let latest = self
            .events
            .iter()
            .rev()
            .find(|event| event["type"] == "functionsChanged")
            .expect("a functionsChanged event");
        serde_json::from_value(latest["result"]["functions"].clone()).expect("function IDs")
    }

    /// Invokes `function` as the page does, answering the call's credential
    /// requests from `store` until it ends; returns `requestCompleted`.
    fn call(&mut self, store: &mut BTreeMap<String, String>, function: &str, params: Value) -> Value {
        self.operations += 1;
        let operation = format!("{function}-{}", self.operations);
        core(
            "lsp.functionRequest",
            json!({
                "sessionId": self.session,
                "operationId": operation,
                "function": { "pluginID": self.plugin_id, "functionID": function },
                "params": params,
            }),
        );
        let deadline = Instant::now() + WAIT;
        loop {
            let pending: Vec<_> = self
                .events
                .iter()
                .filter(|event| {
                    event["type"] == "hostRequest"
                        && !self.answered.contains(&event["result"]["hostRequestID"].to_string())
                })
                .cloned()
                .collect();
            for request in pending {
                let id = request["result"]["hostRequestID"].clone();
                let params = &request["result"]["params"];
                let key = params["key"].as_str().expect("credential key").to_string();
                let result = match request["method"].as_str() {
                    Some("lithe/host/credentials/get") => json!({ "secret": store.get(&key) }),
                    Some("lithe/host/credentials/set") => {
                        store.insert(key, params["secret"].as_str().expect("secret").to_string());
                        Value::Null
                    }
                    Some("lithe/host/credentials/delete") => {
                        store.remove(&key);
                        Value::Null
                    }
                    other => panic!("unexpected host request {other:?}"),
                };
                core(
                    "lsp.hostResponse",
                    json!({ "sessionId": self.session, "hostRequestID": id, "result": result }),
                );
                self.answered.insert(id.to_string());
            }
            if let Some(completed) = self
                .events
                .iter()
                .find(|event| event["operationId"] == operation && event["type"] == "requestCompleted")
            {
                return completed.clone();
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(!remaining.is_zero(), "timed out waiting for {operation}; events: {:#?}", self.events);
            self.drain(remaining);
        }
    }

    /// `call` that must succeed; returns the function's value.
    fn value(&mut self, store: &mut BTreeMap<String, String>, function: &str, params: Value) -> Value {
        let completed = self.call(store, function, params);
        assert!(completed.get("error").is_none(), "{function} failed: {completed}");
        completed["result"]["value"].clone()
    }

    fn stop(&mut self) {
        core("lsp.stopServer", json!({ "sessionId": self.session }));
        self.await_event("the backend to stop", |event| {
            event["type"] == "stateChanged" && event["state"] == "stopped"
        });
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        let request = json!({ "id": "database-e2e-cleanup", "command": "lsp.stopServer", "payload": { "sessionId": self.session } });
        let _ = execute_json(&request.to_string());
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            let destroy = json!({ "id": "database-e2e-cleanup", "command": "lsp.destroyServer", "payload": { "sessionId": self.session } });
            let response: Value = serde_json::from_str(&execute_json(&destroy.to_string())).unwrap_or(Value::Null);
            if response["ok"] == true {
                return;
            }
            let wait = json!({ "id": "database-e2e-cleanup", "command": "lsp.waitEvents", "payload": { "sessionId": self.session, "timeoutMilliseconds": 200 } });
            let _ = execute_json(&wait.to_string());
        }
    }
}
