//! Database drivers and SQL rules of the Lithe database plugin: connects to
//! MySQL, MariaDB, PostgreSQL, SQLite, SQL Server, MongoDB, Redis, and
//! Nacos, and runs one method per call. The backend owns connection storage
//! and secrets; the engine receives a complete connection with every call.

mod mongodb_adapter;
mod nacos_adapter;
mod redis_adapter;
mod sql_adapter;
mod sqlserver_adapter;
mod ssh_tunnel;
mod transfer;
mod write_guard;

use nacos_adapter::*;
use redis_adapter::*;
use sql_adapter::*;
use ssh_tunnel::*;
use transfer::*;
use write_guard::*;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sqlx::{Any, Column, Row, TypeInfo, ValueRef};

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Connection {
    kind: String,
    #[serde(default)]
    host: String,
    #[serde(default)]
    port: u16,
    #[serde(default)]
    username: String,
    #[serde(default)]
    password: String,
    #[serde(default)]
    database: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    ssl: bool,
    #[serde(default)]
    ca_certificate_path: String,
    #[serde(default)]
    server_name: String,
    #[serde(default)]
    ssh_host: String,
    #[serde(default)]
    ssh_port: u16,
    #[serde(default)]
    ssh_username: String,
    #[serde(default)]
    ssh_key_path: String,
    #[serde(default)]
    ssh_local_port: u16,
    /// Lithe's clients send `proxyURL`; `proxyUrl` is the serde default
    /// this field was once read as, kept so neither spelling is dropped.
    #[serde(default, rename = "proxyURL", alias = "proxyUrl")]
    proxy_url: String,
    #[serde(default)]
    read_only: bool,
    #[serde(default)]
    production_protection: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Params {
    connection: Connection,
    #[serde(default)]
    schema: String,
    #[serde(default)]
    table: String,
    #[serde(default)]
    sql: String,
    #[serde(default)]
    values: Vec<Value>,
    #[serde(default = "default_limit")]
    limit: u32,
    #[serde(default)]
    offset: u32,
    #[serde(default)]
    mutations: Vec<Mutation>,
    #[serde(default)]
    data: String,
    #[serde(default)]
    output_path: String,
    #[serde(default)]
    filters: Vec<Filter>,
    #[serde(default)]
    sort: Vec<Sort>,
    #[serde(default)]
    selected_tables: Vec<String>,
    #[serde(default = "default_true")]
    include_structure: bool,
    #[serde(default = "default_true")]
    include_data: bool,
    #[serde(default)]
    allow_write: bool,
    #[serde(default)]
    confirmed: bool,
    #[serde(default)]
    operation: String,
    #[serde(default)]
    object_kind: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    old_name: String,
    #[serde(default)]
    data_type: String,
    #[serde(default)]
    nullable: bool,
    #[serde(default)]
    default_value: String,
    #[serde(default)]
    index_name: String,
    #[serde(default)]
    index_columns: Vec<String>,
    #[serde(default)]
    constraint_name: String,
    #[serde(default)]
    referenced_table: String,
    #[serde(default)]
    referenced_columns: Vec<String>,
    #[serde(default)]
    explain_format: String,
    #[serde(default)]
    diagnostic_kind: String,
    #[serde(default)]
    statements: Vec<Statement>,
    #[serde(default)]
    cursor: String,
    #[serde(default)]
    pattern: String,
    #[serde(default)]
    count: usize,
    #[serde(default = "default_true")]
    include_size: bool,
    #[serde(default)]
    key: String,
    #[serde(default)]
    value: String,
    #[serde(default)]
    new_key: String,
    #[serde(default)]
    ttl: Option<i64>,
    #[serde(default)]
    entries: Vec<RedisHashEntry>,
    #[serde(default)]
    data_id: String,
    #[serde(default)]
    group: String,
    #[serde(default)]
    content: String,
    #[serde(default)]
    r#type: String,
    #[serde(default)]
    service_name: String,
    #[serde(default)]
    page: u32,
    #[serde(default)]
    page_size: u32,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RedisHashEntry {
    field: String,
    value: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Statement {
    sql: String,
    #[serde(default)]
    values: Vec<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Filter {
    column: String,
    operator: String,
    #[serde(default)]
    value: Value,
    #[serde(default = "default_filter_join")]
    join: String,
}

#[derive(Deserialize)]
struct Sort {
    column: String,
    #[serde(default)]
    descending: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Mutation {
    action: String,
    table: String,
    #[serde(default)]
    values: Map<String, Value>,
    #[serde(default)]
    key: Map<String, Value>,
}

pub type DbResult = Result<Value, (String, String)>;
fn default_limit() -> u32 {
    200
}
fn default_true() -> bool {
    true
}
fn default_filter_join() -> String {
    "and".into()
}

/// Registers sqlx's concrete drivers for its `Any` driver. Call it once,
/// before the first method.
pub fn install_drivers() {
    sqlx::any::install_default_drivers();
}

/// What this engine supports: the database kinds and the feature flags the
/// interface uses to show or hide views.
pub fn capabilities() -> Value {
    json!({
        "protocolVersion": 1,
        "databaseTypes": ["mysql", "mariadb", "postgresql", "sqlite", "sqlserver", "mongodb", "redis", "nacos"],
        "features": ["testConnection", "schema", "indexes", "foreignKeys", "objects", "schemaChanges", "pagedFilterSort", "transactionalCrud", "query", "explain", "diagnostics", "csvImportExport", "jsonImportExport", "sqlBackupRestore", "writeProtection", "sqlServerDataGrid", "mongoCollections", "mongoDocumentEditor", "redisScan", "redisStringHashEditor", "redisTTL", "redisFlushDatabase", "nacosConfigManagement", "nacosServiceDiscovery"]
    })
}

/// Runs one engine method. `params` carries the complete connection,
/// including its secrets, and the method's own arguments. Errors are
/// `(code, message)` pairs whose message never contains the password.
pub async fn dispatch(method: &str, params: Value) -> DbResult {
    match method {
        "capabilities" => Ok(capabilities()),
        "checkWriteProtection" => check_write_protection(params),
        _ => database_method(method, params).await,
    }
}

/// Reports whether `execute` would reject `sql` until the user confirms, without
/// connecting. Clients ask before running a batch so a statement rejected by
/// production protection cannot stop it after earlier statements were applied.
fn check_write_protection(value: Value) -> DbResult {
    let params: Params =
        serde_json::from_value(value).map_err(|e| ("invalid_params".into(), e.to_string()))?;
    let requires_confirmation = params.connection.production_protection
        && is_dangerous_sql(&params.connection.kind, &params.sql);
    Ok(json!({"requiresConfirmation": requires_confirmation}))
}

async fn database_method(method: &str, value: Value) -> DbResult {
    let params: Params =
        serde_json::from_value(value).map_err(|e| ("invalid_params".into(), e.to_string()))?;
    match params.connection.kind.as_str() {
        "redis" => redis_method(method, params).await,
        "nacos" => nacos_method(method, params).await,
        "sqlserver" => sqlserver_adapter::method(method, params).await,
        "mongodb" => mongodb_adapter::method(method, params).await,
        _ => sql_database_method(method, params).await,
    }
}

fn normalized_page(page: u32) -> u32 {
    page.max(1)
}
fn normalized_page_size(page_size: u32) -> u32 {
    if page_size == 0 {
        100
    } else {
        page_size.clamp(1, 500)
    }
}
fn nonempty_or<'a>(value: &'a str, fallback: &'a str) -> &'a str {
    if value.trim().is_empty() {
        fallback
    } else {
        value.trim()
    }
}
fn require_nonempty(value: &str, label: &str) -> Result<(), (String, String)> {
    if value.trim().is_empty() {
        Err(("invalid_params".into(), format!("{label} is required")))
    } else {
        Ok(())
    }
}

fn ensure_specialized_write(
    connection: &Connection,
    action: &str,
    confirmed: bool,
    allow_write: bool,
) -> Result<(), (String, String)> {
    if connection.read_only && !allow_write {
        return Err(("read_only".into(), "This connection is read-only".into()));
    }
    if connection.production_protection && !confirmed {
        return Err((
            "write_confirmation_required".into(),
            format!("{action} requires confirmation because production protection is enabled"),
        ));
    }
    Ok(())
}

impl Connection {
    fn url(&self) -> Result<String, (String, String)> {
        match normalized_kind(&self.kind)? {
            "sqlite" if self.path.is_empty() => Err((
                "invalid_connection".into(),
                "SQLite path is required".into(),
            )),
            "sqlite" => Ok(format!("sqlite://{}?mode=rwc", self.path)),
            kind if self.host.is_empty() || self.username.is_empty() => Err((
                "invalid_connection".into(),
                format!("Host and username are required for {kind}"),
            )),
            kind => {
                let port = if self.port > 0 {
                    self.port
                } else if kind == "mysql" {
                    3306
                } else {
                    5432
                };
                let scheme = if kind == "mysql" { "mysql" } else { "postgres" };
                if !self.proxy_url.is_empty() && self.ssh_host.is_empty() {
                    return Err((
                        "unsupported_proxy".into(),
                        "A proxy URL requires an SSH tunnel in the current database driver".into(),
                    ));
                }
                let mut query = Vec::new();
                if kind == "postgresql" {
                    query.push(if self.ssl {
                        "sslmode=require".to_string()
                    } else {
                        "sslmode=disable".to_string()
                    });
                    if !self.ca_certificate_path.is_empty() {
                        query.push(format!(
                            "sslrootcert={}",
                            urlencoding::encode(&self.ca_certificate_path)
                        ));
                    }
                    if !self.server_name.is_empty() {
                        query.push(format!("host={}", urlencoding::encode(&self.server_name)));
                    }
                } else if self.ssl {
                    query.push("ssl-mode=REQUIRED".to_string());
                    if !self.ca_certificate_path.is_empty() {
                        query.push(format!(
                            "ssl-ca={}",
                            urlencoding::encode(&self.ca_certificate_path)
                        ));
                    }
                }
                let suffix = if query.is_empty() {
                    String::new()
                } else {
                    format!("?{}", query.join("&"))
                };
                Ok(format!(
                    "{scheme}://{}:{}@{}:{port}/{}{suffix}",
                    urlencoding::encode(&self.username),
                    urlencoding::encode(&self.password),
                    self.host,
                    self.database
                ))
            }
        }
    }

    fn with_tunnel(&self) -> Result<Self, (String, String)> {
        if self.ssh_local_port == 0 {
            return Err((
                "invalid_ssh_tunnel".into(),
                "SSH local port is required when using a tunnel".into(),
            ));
        }
        let mut connection = self.clone();
        connection.host = "127.0.0.1".into();
        connection.port = self.ssh_local_port;
        Ok(connection)
    }
}

fn row_string(row: &sqlx::any::AnyRow, index: usize) -> Result<String, (String, String)> {
    row.try_get::<String, _>(index).map_err(db_error)
}

fn bind_values<'q>(
    mut query: sqlx::query::Query<'q, Any, sqlx::any::AnyArguments<'q>>,
    values: &'q [Value],
) -> Result<sqlx::query::Query<'q, Any, sqlx::any::AnyArguments<'q>>, (String, String)> {
    for value in values {
        query = match value {
            Value::Null => query.bind(Option::<String>::None),
            Value::Bool(v) => query.bind(*v),
            Value::Number(v) if v.is_i64() => query.bind(v.as_i64().unwrap()),
            Value::Number(v) if v.is_u64() => query.bind(v.as_u64().unwrap() as i64),
            Value::Number(v) => query.bind(v.as_f64().unwrap()),
            Value::String(v) => query.bind(v),
            other => query.bind(other.to_string()),
        };
    }
    Ok(query)
}

fn rows_value(rows: Vec<sqlx::any::AnyRow>) -> DbResult {
    Ok(Value::Array(
        rows.iter().map(row_json).collect::<Result<_, _>>()?,
    ))
}

fn metadata_rows_value(rows: Vec<sqlx::any::AnyRow>) -> DbResult {
    let mut values = Vec::with_capacity(rows.len());
    for row in &rows {
        let mut value = row_json(row)?;
        if let Value::Object(object) = &mut value {
            for key in ["data_type", "is_nullable", "column_key", "column_default"] {
                let Some(Value::Object(binary)) = object.get(key) else {
                    continue;
                };
                let Some(encoded) = binary_input(binary) else {
                    continue;
                };
                let Ok(bytes) = BASE64.decode(encoded) else {
                    continue;
                };
                let Ok(text) = String::from_utf8(bytes) else {
                    continue;
                };
                object.insert(key.to_string(), Value::String(text));
            }
        }
        values.push(value);
    }
    Ok(Value::Array(values))
}

fn row_json(row: &sqlx::any::AnyRow) -> Result<Value, (String, String)> {
    let mut object = Map::new();
    for (index, column) in row.columns().iter().enumerate() {
        let raw = row.try_get_raw(index).map_err(db_error)?;
        let value = if raw.is_null() {
            Value::Null
        } else {
            // SQLite PRAGMA/expression columns may declare NULL despite a typed value.
            typed_value(row, index, raw.type_info().name())
        };
        object.insert(column.name().to_string(), value);
    }
    Ok(Value::Object(object))
}

fn typed_value(row: &sqlx::any::AnyRow, index: usize, kind: &str) -> Value {
    match kind.to_ascii_uppercase().as_str() {
        "BOOL" | "BOOLEAN" => row
            .try_get::<bool, _>(index)
            .map(Value::Bool)
            .unwrap_or_else(|_| text_value(row, index)),
        "INT" | "INT2" | "INT4" | "INT8" | "INT16" | "INT32" | "INT64" | "INTEGER" | "BIGINT"
        | "SMALLINT" | "TINYINT" => row
            .try_get::<i64, _>(index)
            .map(|v| json!(v))
            .unwrap_or_else(|_| text_value(row, index)),
        "FLOAT" | "FLOAT4" | "FLOAT8" | "REAL" | "DOUBLE" | "DOUBLE PRECISION" => row
            .try_get::<f64, _>(index)
            .map(|v| json!(v))
            .unwrap_or_else(|_| text_value(row, index)),
        "BLOB" | "BYTEA" | "BINARY" | "VARBINARY" => row
            .try_get::<Vec<u8>, _>(index)
            .map(tagged_binary)
            .unwrap_or_else(|_| text_value(row, index)),
        _ => text_value(row, index),
    }
}

fn text_value(row: &sqlx::any::AnyRow, index: usize) -> Value {
    row.try_get::<String, _>(index)
        .map(Value::String)
        .unwrap_or_else(|_| Value::String("<unsupported>".into()))
}

fn validate_identifier(value: &str) -> Result<(), (String, String)> {
    if !value.is_empty() && !value.contains('\0') {
        Ok(())
    } else {
        Err((
            "invalid_identifier".into(),
            format!("Invalid SQL identifier: {value}"),
        ))
    }
}
fn quote_identifier(kind: &str, value: &str) -> Result<String, (String, String)> {
    validate_identifier(value)?;
    Ok(if kind == "mysql" {
        format!("`{}`", value.replace('`', "``"))
    } else {
        format!("\"{}\"", value.replace('"', "\"\""))
    })
}
fn require_sql(sql: &str) -> Result<(), (String, String)> {
    if sql.trim().is_empty() {
        Err(("invalid_query".into(), "SQL is required".into()))
    } else {
        Ok(())
    }
}
fn csv_value(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(v) => v.clone(),
        other => other.to_string(),
    }
}
fn db_error(error: sqlx::Error) -> (String, String) {
    ("database_error".into(), error.to_string())
}
fn csv_error(error: csv::Error) -> (String, String) {
    ("export_failed".into(), error.to_string())
}
fn redact(mut message: String, password: &str) -> String {
    if !password.is_empty() {
        message = message.replace(password, "***");
    }
    message
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::any::AnyPoolOptions;
    use std::time::Duration;

    #[test]
    fn connections_read_the_proxy_url_lithe_sends() {
        for key in ["proxyURL", "proxyUrl"] {
            let connection: Connection = serde_json::from_value(json!({
                "kind": "mysql",
                key: "ssh -W %h:%p bastion",
            }))
            .unwrap();
            assert_eq!(connection.proxy_url, "ssh -W %h:%p bastion", "{key}");
        }
    }

    #[tokio::test]
    async fn sqlite_metadata_preserves_primary_key_ordinals() {
        sqlx::any::install_default_drivers();
        // In-memory metadata protects both the grid icon and keyed mutations.
        tokio::time::timeout(Duration::from_secs(5), async {
            let pool = AnyPoolOptions::new()
                .max_connections(1)
                .connect("sqlite::memory:")
                .await
                .unwrap();
            sqlx::query("CREATE TABLE single_key (id INTEGER PRIMARY KEY, label TEXT)")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query(
                "CREATE TABLE composite_key (a INTEGER, b INTEGER, label TEXT, PRIMARY KEY (a, b))",
            )
            .execute(&pool)
            .await
            .unwrap();
            let single = describe_table(&pool, "sqlite", "", "single_key")
                .await
                .unwrap();
            let composite = describe_table(&pool, "sqlite", "", "composite_key")
                .await
                .unwrap();
            pool.close().await;
            assert_eq!(single[0]["pk"], json!(1));
            assert_eq!(single[1]["pk"], json!(0));
            assert_eq!(single[0]["cid"], json!(0));
            assert_eq!(single[1]["notnull"], json!(0));
            assert_eq!(single[1]["dflt_value"], Value::Null);
            assert_eq!(composite[0]["pk"], json!(1));
            assert_eq!(composite[1]["pk"], json!(2));
            assert_eq!(composite[2]["pk"], json!(0));
        })
        .await
        .expect("SQLite metadata test exceeded its local deadline");
    }

    #[test]
    fn rejects_update_without_key() {
        let mutation = Mutation {
            action: "update".into(),
            table: "items".into(),
            values: Map::from_iter([("name".into(), json!("changed"))]),
            key: Map::new(),
        };
        assert_eq!(
            mutation_sql("mysql", "", &mutation).unwrap_err().0,
            "unsafe_mutation"
        );
    }

    #[test]
    fn postgres_mutations_use_numbered_placeholders() {
        let mutation = Mutation {
            action: "update".into(),
            table: "items".into(),
            values: Map::from_iter([("name".into(), json!("changed"))]),
            key: Map::from_iter([("id".into(), json!(7))]),
        };
        let (sql, values) = mutation_sql("postgresql", "public", &mutation).unwrap();
        assert_eq!(
            sql,
            "UPDATE \"public\".\"items\" SET \"name\" = $1 WHERE \"id\" = $2"
        );
        assert_eq!(values, vec![json!("changed"), json!(7)]);
    }

    #[test]
    fn empty_inserts_use_database_defaults() {
        let mutation = Mutation {
            action: "insert".into(),
            table: "items".into(),
            values: Map::new(),
            key: Map::new(),
        };
        assert_eq!(
            mutation_sql("mysql", "", &mutation).unwrap().0,
            "INSERT INTO `items` () VALUES ()"
        );
        assert_eq!(
            mutation_sql("postgresql", "public", &mutation).unwrap().0,
            "INSERT INTO \"public\".\"items\" DEFAULT VALUES"
        );
        assert_eq!(
            mutation_sql("sqlite", "", &mutation).unwrap().0,
            "INSERT INTO \"items\" DEFAULT VALUES"
        );
    }

    #[test]
    fn filters_quote_identifiers_and_bind_values() {
        let filters = vec![Filter {
            column: "name".into(),
            operator: "contains".into(),
            value: json!("lit"),
            join: "and".into(),
        }];
        let (sql, values) = filter_clause("sqlite", &filters).unwrap();
        assert_eq!(sql, " WHERE (\"name\" LIKE ?)");
        assert_eq!(values, vec![json!("%lit%")]);
        let unusual = vec![Filter {
            column: "显示 \"名称\"".into(),
            operator: "equals".into(),
            value: json!(1),
            join: "and".into(),
        }];
        assert_eq!(
            filter_clause("sqlite", &unusual).unwrap().0,
            " WHERE (\"显示 \"\"名称\"\"\" = ?)"
        );
        assert_eq!(quote_identifier("mysql", "a`b").unwrap(), "`a``b`");
        assert_eq!(quote_identifier("sqlite", "a\"b").unwrap(), "\"a\"\"b\"");
        assert_eq!(
            quote_identifier("sqlite", "bad\0name").unwrap_err().0,
            "invalid_identifier"
        );
    }

    #[test]
    fn filters_support_or_join() {
        let filters = vec![
            Filter {
                column: "name".into(),
                operator: "equals".into(),
                value: json!("missing"),
                join: "and".into(),
            },
            Filter {
                column: "score".into(),
                operator: "equals".into(),
                value: json!(1),
                join: "or".into(),
            },
        ];
        let (sql, values) = filter_clause("sqlite", &filters).unwrap();
        assert_eq!(sql, " WHERE (\"name\" = ? OR \"score\" = ?)");
        assert_eq!(values, vec![json!("missing"), json!(1)]);
    }

    #[test]
    fn sql_literals_preserve_quotes_and_binary_values() {
        assert_eq!(
            sql_literal("mysql", &json!("O'Reilly")).unwrap(),
            "'O''Reilly'"
        );
        assert_eq!(
            sql_literal("sqlite", &json!({"base64":"AP8="})).unwrap(),
            "X'00ff'"
        );
        assert_eq!(
            sql_literal("sqlite", &json!({"binary":"AP8="})).unwrap(),
            "X'00ff'"
        );
        assert_eq!(
            sql_literal("postgresql", &json!({"base64":"AP8="})).unwrap(),
            "decode('00ff','hex')"
        );
    }

    #[test]
    fn binary_values_use_an_explicit_tag_without_accepting_mixed_objects() {
        assert_eq!(tagged_binary([0, 255]), json!({"binary":"AP8="}));
        let explicit = json!({"binary":"AP8="});
        assert_eq!(binary_input(explicit.as_object().unwrap()), Some("AP8="));
        let legacy = json!({"base64":"AP8="});
        assert_eq!(binary_input(legacy.as_object().unwrap()), Some("AP8="));
        let mixed = json!({"binary":"AP8=","label":"payload"});
        assert_eq!(binary_input(mixed.as_object().unwrap()), None);
    }

    #[test]
    fn mysql_text_fallback_preserves_utf8_names_and_binary_payloads() {
        assert_eq!(mysql_bytes_value(b"analytics"), json!("analytics"));
        assert_eq!(mysql_bytes_value(&[0, 255]), json!({"binary":"AP8="}));
    }

    #[test]
    fn restore_drops_existing_objects_before_replaying_snapshot() {
        assert_eq!(
            object_drop_sql("sqlite", "", "records", "table").unwrap(),
            Some("DROP TABLE IF EXISTS \"records\"".into())
        );
        assert_eq!(
            object_drop_sql("mysql", "", "orders", "BASE TABLE").unwrap(),
            Some("DROP TABLE IF EXISTS `orders`".into())
        );
        assert_eq!(
            object_drop_sql("postgresql", "public", "active_users", "view").unwrap(),
            Some("DROP VIEW IF EXISTS \"public\".\"active_users\"".into())
        );
        assert_eq!(
            object_drop_sql("postgresql", "public", "users", "base table").unwrap(),
            Some("DROP TABLE IF EXISTS \"public\".\"users\" CASCADE".into())
        );
    }

    #[test]
    fn write_protection_classifies_dangerous_sql() {
        for sql in [
            "RESTORE",
            "DROP TABLE users",
            "drop table users",
            "TRUNCATE users",
            "ALTER TABLE users DROP COLUMN email",
            "UPDATE users SET active = 0",
            "DELETE FROM users",
            "DELETE\nFROM users",
            // Comments must not hide the verb from the check.
            "-- cleanup\nDELETE FROM users",
            "/* cleanup */ DELETE FROM users",
            // A WHERE in a comment, literal or subquery does not bound the write.
            "DELETE FROM users -- WHERE id = 1",
            "UPDATE users SET note = 'WHERE id = 1'",
            "UPDATE users SET rank = (SELECT max(rank) FROM ranks WHERE ranks.id = 1)",
            "DELETE FROM \"where\"",
            "WITH stale AS (SELECT id FROM users WHERE active = 0) DELETE FROM users",
            "WITH gone AS (DELETE FROM users RETURNING id) SELECT count(*) FROM gone",
            "SELECT 1; DELETE FROM users",
            "UPDATE users SET active = 0 WHERE id = 1; DELETE FROM users",
        ] {
            assert!(is_dangerous_sql("postgresql", sql), "{sql}");
        }
        for sql in [
            "SELECT * FROM users",
            "INSERT INTO users (name) VALUES ('drop table')",
            // Regression: a WHERE on its own line or after a tab used to be missed.
            "UPDATE users SET active = 0 WHERE id = 1",
            "UPDATE users\nSET active = 0\nWHERE id = 1",
            "DELETE FROM users\tWHERE id = 1",
            "DELETE FROM users\nwhere id = 1;",
            "WITH stale AS (SELECT id FROM users) DELETE FROM users WHERE id IN (SELECT id FROM stale)",
            "SELECT * FROM users FOR UPDATE",
            "CREATE TABLE posts (author_id INT REFERENCES users(id) ON DELETE CASCADE)",
            "INSERT INTO users (id) VALUES (1) ON DUPLICATE KEY UPDATE id = id",
            "GRANT UPDATE, DELETE ON users TO app",
            "SELECT TRUNCATE(1.25, 1)",
            "SELECT $$DELETE FROM users$$",
            "SELECT $body$ DROP TABLE users $body$",
            "SELECT * FROM users WHERE id = $1",
            "/* outer /* nested */ DROP TABLE users */ SELECT 1",
            "",
            "-- only a comment",
        ] {
            assert!(!is_dangerous_sql("postgresql", sql), "{sql}");
        }
    }

    #[test]
    fn write_protection_check_matches_execute_guard_without_connecting() {
        let request = |production_protection: bool, sql: &str| {
            json!({
                "connection": {"kind": "postgresql", "productionProtection": production_protection},
                "sql": sql,
            })
        };
        let requires = |value: Value| {
            check_write_protection(value).unwrap()["requiresConfirmation"]
                .as_bool()
                .unwrap()
        };
        assert!(requires(request(true, "UPDATE users SET active = 0")));
        assert!(!requires(request(
            true,
            "UPDATE users SET active = 0\nWHERE id = 1"
        )));
        assert!(!requires(request(false, "DROP TABLE users")));
    }

    #[test]
    fn write_protection_lexes_quotes_per_dialect() {
        // MySQL backslash-escapes quotes, so the WHERE stays inside the literal.
        let sql = r"UPDATE users SET note = 'it\' WHERE 1 = 1 --'";
        assert!(is_dangerous_sql("mysql", sql));
        assert!(is_dangerous_sql("mariadb", sql));
        // Standard strings end at the first quote; E'' strings escape like MySQL.
        assert!(!is_dangerous_sql(
            "postgresql",
            r"UPDATE users SET path = 'C:\' WHERE id = 1"
        ));
        assert!(is_dangerous_sql(
            "postgresql",
            r"UPDATE users SET note = E'it\' WHERE 1 = 1 --'"
        ));
        // SQL Server bracket identifiers can contain keywords.
        assert!(is_dangerous_sql("sqlserver", "DELETE FROM [where]"));
        assert!(!is_dangerous_sql(
            "sqlserver",
            "DELETE FROM [users] WHERE [id] = 1"
        ));
    }

    #[test]
    fn tls_url_contains_requested_postgres_options_without_password_leakage() {
        let connection = Connection {
            kind: "postgresql".into(),
            host: "db.example".into(),
            port: 5432,
            username: "alice".into(),
            password: "secret".into(),
            database: "app".into(),
            path: String::new(),
            ssl: true,
            ca_certificate_path: "/tmp/ca.pem".into(),
            server_name: "db.example".into(),
            ssh_host: String::new(),
            ssh_port: 0,
            ssh_username: String::new(),
            ssh_key_path: String::new(),
            ssh_local_port: 0,
            proxy_url: String::new(),
            read_only: false,
            production_protection: false,
        };
        let url = connection.url().unwrap();
        assert!(url.contains("sslmode=require"));
        assert!(url.contains("sslrootcert=%2Ftmp%2Fca.pem"));
        assert!(redact("connection failed: secret".to_string(), "secret").contains("***"));
    }
}
