//! MySQL, MariaDB, PostgreSQL, and SQLite through sqlx: metadata, paged
//! and filtered table data, queries, keyed changes, schema changes,
//! explain, diagnostics, and transactions.

use crate::*;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use futures_util::TryStreamExt;
use serde_json::{json, Map, Value};
use sqlx::{
    any::AnyPoolOptions,
    mysql::{MySqlPoolOptions, MySqlRow},
    postgres::{PgPoolOptions, PgRow},
    sqlite::{SqlitePoolOptions, SqliteRow},
    AnyPool, Column, MySql, MySqlPool, PgPool, Postgres, Row, Sqlite, SqlitePool, TypeInfo,
    ValueRef,
};
use std::time::Duration;

pub(crate) async fn sql_database_method(method: &str, params: Params) -> DbResult {
    let tunnel = open_ssh_tunnel(&params.connection).await?;
    let connection = if tunnel.is_some() {
        params.connection.with_tunnel()?
    } else {
        params.connection.clone()
    };
    let kind = normalized_kind(&connection.kind)?;
    let needs_direct = matches!(
        method,
        "query"
            | "pageTable"
            | "applyChanges"
            | "importCsv"
            | "importJson"
            | "exportCsv"
            | "exportJson"
            | "exportSql"
            | "exportSqlToFile"
            | "schemaChange"
            | "transaction"
    );
    let direct = if needs_direct {
        Some(connect_direct(&connection).await?)
    } else {
        None
    };
    let pool = connect(&connection).await?;
    let result = match method {
        "testConnection" => Ok(json!({"connected": true})),
        "listDatabases" => list_databases(&pool, kind).await,
        "listTables" => list_tables(&pool, kind, &params.schema).await,
        "describeTable" => describe_table(&pool, kind, &params.schema, &params.table).await,
        "listIndexes" => list_indexes(&pool, kind, &params.schema, &params.table).await,
        "listForeignKeys" => list_foreign_keys(&pool, kind, &params.schema, &params.table).await,
        "listObjects" => list_objects(&pool, kind, &params.schema, &params.object_kind).await,
        "query" => {
            ensure_query_allowed(&connection, &params.sql, params.confirmed)?;
            query_direct(
                direct.as_ref().unwrap(),
                &params.sql,
                &params.values,
                params.limit,
            )
            .await
        }
        "pageTable" => page_table(&pool, direct.as_ref().unwrap(), kind, &params).await,
        "execute" => {
            ensure_write_allowed(&connection, &params.sql, params.confirmed)?;
            execute(&pool, &params.sql, &params.values).await
        }
        "applyChanges" => {
            ensure_mutations_allowed(&connection, &params.mutations, params.confirmed)?;
            apply_changes(
                direct.as_ref().unwrap(),
                kind,
                &params.schema,
                &params.mutations,
            )
            .await
        }
        "schemaChange" => {
            ensure_write_allowed(&connection, "ALTER TABLE", params.confirmed)?;
            schema_change(direct.as_ref().unwrap(), kind, &params).await
        }
        "explain" => {
            ensure_query_allowed(&connection, &params.sql, params.confirmed)?;
            explain(&pool, kind, &params.sql, &params.explain_format).await
        }
        "diagnostics" => diagnostics(&pool, kind, &params).await,
        "transaction" => {
            ensure_transaction_allowed(&connection, &params.statements, params.confirmed)?;
            run_transaction(direct.as_ref().unwrap(), kind, &params.statements).await
        }
        "exportCsv" => {
            export_csv(
                direct.as_ref().unwrap(),
                &params.sql,
                &params.values,
                params.limit,
            )
            .await
        }
        "exportJson" => {
            export_json(
                direct.as_ref().unwrap(),
                &params.sql,
                &params.values,
                params.limit,
            )
            .await
        }
        "importCsv" => {
            ensure_write_allowed(&connection, "INSERT", params.confirmed)?;
            import_data(
                direct.as_ref().unwrap(),
                kind,
                &params.schema,
                &params.table,
                &params.data,
                "csv",
            )
            .await
        }
        "importJson" => {
            ensure_write_allowed(&connection, "INSERT", params.confirmed)?;
            import_data(
                direct.as_ref().unwrap(),
                kind,
                &params.schema,
                &params.table,
                &params.data,
                "json",
            )
            .await
        }
        "exportSql" => {
            export_sql(
                &pool,
                direct.as_ref().unwrap(),
                &SqlBackup::new(kind, &params),
            )
            .await
        }
        "exportSqlToFile" => {
            export_sql_to_file(
                &pool,
                direct.as_ref().unwrap(),
                &SqlBackup::new(kind, &params),
                &params.output_path,
            )
            .await
        }
        "importSql" => {
            ensure_write_allowed(&connection, "RESTORE", params.confirmed)?;
            import_sql(&pool, &params.data).await
        }
        "importSqlFile" => {
            ensure_write_allowed(&connection, "RESTORE", params.confirmed)?;
            import_sql_file(&pool, &params.output_path).await
        }
        "restoreSql" => {
            ensure_write_allowed(&connection, "RESTORE", params.confirmed)?;
            restore_sql(&pool, kind, &params.schema, &params.data).await
        }
        "restoreSqlFile" => {
            ensure_write_allowed(&connection, "RESTORE", params.confirmed)?;
            restore_sql_file(&pool, kind, &params.schema, &params.output_path).await
        }
        _ => Err(("unknown_method".into(), format!("Unknown method: {method}"))),
    };
    pool.close().await;
    if let Some(direct) = direct {
        direct.close().await;
    }
    drop(tunnel);
    result
}

pub(crate) enum DirectPool {
    MySql(MySqlPool),
    Postgres(PgPool),
    Sqlite(SqlitePool),
}

impl DirectPool {
    pub(crate) async fn close(self) {
        match self {
            Self::MySql(pool) => pool.close().await,
            Self::Postgres(pool) => pool.close().await,
            Self::Sqlite(pool) => pool.close().await,
        }
    }
}

pub(crate) async fn connect_direct(
    connection: &Connection,
) -> Result<DirectPool, (String, String)> {
    let url = connection.url()?;
    let error = |error: sqlx::Error| {
        (
            "connection_failed".into(),
            redact(error.to_string(), &connection.password),
        )
    };
    match normalized_kind(&connection.kind)? {
        "mysql" => MySqlPoolOptions::new()
            .max_connections(2)
            .acquire_timeout(Duration::from_secs(8))
            .connect(&url)
            .await
            .map(DirectPool::MySql)
            .map_err(error),
        "postgresql" => PgPoolOptions::new()
            .max_connections(2)
            .acquire_timeout(Duration::from_secs(8))
            .connect(&url)
            .await
            .map(DirectPool::Postgres)
            .map_err(error),
        _ => SqlitePoolOptions::new()
            .max_connections(1)
            .acquire_timeout(Duration::from_secs(8))
            .connect(&url)
            .await
            .map(DirectPool::Sqlite)
            .map_err(error),
    }
}

pub(crate) fn normalized_kind(kind: &str) -> Result<&str, (String, String)> {
    match kind {
        "mysql" | "mariadb" => Ok("mysql"),
        "postgres" | "postgresql" => Ok("postgresql"),
        "sqlite" => Ok("sqlite"),
        _ => Err((
            "unsupported_database".into(),
            format!("Unsupported database type: {kind}"),
        )),
    }
}

pub(crate) async fn connect(connection: &Connection) -> Result<AnyPool, (String, String)> {
    AnyPoolOptions::new()
        .max_connections(2)
        .acquire_timeout(Duration::from_secs(8))
        .connect(&connection.url()?)
        .await
        .map_err(|e| {
            (
                "connection_failed".into(),
                redact(e.to_string(), &connection.password),
            )
        })
}

pub(crate) async fn list_tables(pool: &AnyPool, kind: &str, schema: &str) -> DbResult {
    let sql = match kind {
        "mysql" => "SELECT table_name AS table_name, CAST(table_type AS CHAR) AS table_type FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name",
        "postgresql" => "SELECT CAST(table_name AS TEXT) AS table_name, CAST(table_type AS TEXT) AS table_type FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
        _ => "SELECT name AS table_name, type AS table_type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
    };
    let mut q = sqlx::query(sql);
    if kind == "postgresql" {
        q = q.bind(if schema.is_empty() { "public" } else { schema });
    }
    rows_value(q.fetch_all(pool).await.map_err(db_error)?)
}

pub(crate) async fn list_databases(pool: &AnyPool, kind: &str) -> DbResult {
    let sql = match kind {
        "mysql" => "SELECT SCHEMA_NAME AS name FROM information_schema.schemata ORDER BY SCHEMA_NAME",
        "postgresql" => "SELECT schema_name AS name FROM information_schema.schemata WHERE catalog_name = current_database() ORDER BY schema_name",
        _ => return Ok(json!([])),
    };
    let rows = rows_value(sqlx::query(sql).fetch_all(pool).await.map_err(db_error)?)?;
    let names = rows
        .as_array()
        .into_iter()
        .flat_map(|rows| rows.iter())
        .filter_map(|row| row.get("name").and_then(Value::as_str))
        .map(|name| Value::String(name.to_string()))
        .collect();
    Ok(Value::Array(names))
}

pub(crate) async fn describe_table(
    pool: &AnyPool,
    kind: &str,
    schema: &str,
    table: &str,
) -> DbResult {
    validate_identifier(table)?;
    let sql = match kind {
        "mysql" => "SELECT column_name AS column_name, CAST(data_type AS CHAR) AS data_type, CAST(is_nullable AS CHAR) AS is_nullable, CAST(column_default AS CHAR) AS column_default, CAST(column_key AS CHAR) AS column_key FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position".to_string(),
        "postgresql" => r#"SELECT CAST(c.column_name AS TEXT) AS column_name, CAST(c.data_type AS TEXT) AS data_type,
            CAST(c.is_nullable AS TEXT) AS is_nullable, CAST(c.column_default AS TEXT) AS column_default,
            CASE WHEN EXISTS (
                SELECT 1 FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage kcu
                  ON tc.constraint_name=kcu.constraint_name AND tc.constraint_schema=kcu.constraint_schema
                WHERE tc.constraint_type='PRIMARY KEY' AND tc.table_schema=c.table_schema
                  AND tc.table_name=c.table_name AND kcu.column_name=c.column_name
            ) THEN 'PRI' ELSE '' END AS column_key
            FROM information_schema.columns c
            WHERE c.table_schema=$1 AND c.table_name=$2 ORDER BY c.ordinal_position"#.to_string(),
        _ => format!("PRAGMA table_info({})", quote_identifier(kind, table)?),
    };
    let mut q = sqlx::query(&sql);
    if kind == "mysql" {
        q = q.bind(table);
    }
    if kind == "postgresql" {
        q = q
            .bind(if schema.is_empty() { "public" } else { schema })
            .bind(table);
    }
    metadata_rows_value(q.fetch_all(pool).await.map_err(db_error)?)
}

pub(crate) async fn list_indexes(
    pool: &AnyPool,
    kind: &str,
    schema: &str,
    table: &str,
) -> DbResult {
    validate_identifier(table)?;
    let sql = match kind {
        "mysql" => "SELECT CAST(index_name AS CHAR) AS index_name, CAST(CONCAT('CREATE ', CASE WHEN index_type = 'FULLTEXT' THEN 'FULLTEXT ' WHEN index_type = 'SPATIAL' THEN 'SPATIAL ' WHEN non_unique = 0 THEN 'UNIQUE ' ELSE '' END, 'INDEX `', REPLACE(index_name, '`', '``'), '` ON `', REPLACE(table_name, '`', '``'), '` (', GROUP_CONCAT(CONCAT('`', REPLACE(column_name, '`', '``'), '`', CASE WHEN sub_part IS NULL THEN '' ELSE CONCAT('(', sub_part, ')') END, CASE WHEN collation = 'D' THEN ' DESC' ELSE '' END) ORDER BY seq_in_index SEPARATOR ', '), ')') AS CHAR) AS definition FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name <> 'PRIMARY' GROUP BY index_name, index_type, non_unique, table_name ORDER BY index_name".to_string(),
        "postgresql" => "SELECT CAST(indexname AS TEXT) AS index_name, CAST(indexdef AS TEXT) AS definition FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname".to_string(),
        _ => "SELECT name AS index_name, sql AS definition FROM sqlite_master WHERE type='index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name".to_string(),
    };
    let mut q = sqlx::query(&sql);
    if kind == "mysql" {
        q = q.bind(table);
    }
    if kind == "sqlite" {
        q = q.bind(table);
    }
    if kind == "postgresql" {
        q = q
            .bind(if schema.is_empty() { "public" } else { schema })
            .bind(table);
    }
    rows_value(q.fetch_all(pool).await.map_err(db_error)?)
}

pub(crate) async fn list_foreign_keys(
    pool: &AnyPool,
    kind: &str,
    schema: &str,
    table: &str,
) -> DbResult {
    validate_identifier(table)?;
    let sql = match kind {
        "mysql" => "SELECT constraint_name, column_name, referenced_table_name, referenced_column_name FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND table_name = ? AND referenced_table_name IS NOT NULL ORDER BY constraint_name, ordinal_position".to_string(),
        "postgresql" => "SELECT CAST(tc.constraint_name AS TEXT) AS constraint_name, CAST(kcu.column_name AS TEXT) AS column_name, CAST(ccu.table_name AS TEXT) AS referenced_table_name, CAST(ccu.column_name AS TEXT) AS referenced_column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name AND tc.constraint_schema=kcu.constraint_schema JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name=tc.constraint_name AND ccu.constraint_schema=tc.constraint_schema WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema=$1 AND tc.table_name=$2 ORDER BY tc.constraint_name, kcu.ordinal_position".to_string(),
        _ => format!("PRAGMA foreign_key_list({})", quote_identifier(kind, table)?),
    };
    let mut q = sqlx::query(&sql);
    if kind == "mysql" {
        q = q.bind(table);
    }
    if kind == "postgresql" {
        q = q
            .bind(if schema.is_empty() { "public" } else { schema })
            .bind(table);
    }
    rows_value(q.fetch_all(pool).await.map_err(db_error)?)
}

pub(crate) async fn list_objects(
    pool: &AnyPool,
    kind: &str,
    schema: &str,
    object_kind: &str,
) -> DbResult {
    let requested = if object_kind.is_empty() {
        "all"
    } else {
        object_kind
    };
    let sql = match (kind, requested) {
        ("mysql", "views") => "SELECT table_name AS object_name, 'view' AS object_kind, view_definition AS definition FROM information_schema.views WHERE table_schema=DATABASE() ORDER BY table_name".to_string(),
        ("mysql", "routines" | "procedures" | "functions") => "SELECT routine_name AS object_name, routine_type AS object_kind, routine_definition AS definition FROM information_schema.routines WHERE routine_schema=DATABASE() ORDER BY routine_name".to_string(),
        ("mysql", "triggers") => "SELECT trigger_name AS object_name, 'trigger' AS object_kind, action_statement AS definition FROM information_schema.triggers WHERE trigger_schema=DATABASE() ORDER BY trigger_name".to_string(),
        ("mysql", "sequences") => "SELECT CAST(NULL AS CHAR) AS object_name, 'sequence' AS object_kind, CAST(NULL AS CHAR) AS definition WHERE 1=0".to_string(),
        ("mysql", _) => "SELECT table_name AS object_name, table_type AS object_kind, CAST(NULL AS CHAR) AS definition FROM information_schema.tables WHERE table_schema=DATABASE() ORDER BY table_name".to_string(),
        ("postgresql", "views") => "SELECT CAST(viewname AS TEXT) AS object_name, 'view' AS object_kind, CAST(definition AS TEXT) AS definition FROM pg_views WHERE schemaname=$1 ORDER BY viewname".to_string(),
        ("postgresql", "routines" | "procedures" | "functions") => "SELECT CAST(p.proname AS TEXT) AS object_name, CASE WHEN p.prokind='p' THEN 'procedure' ELSE 'function' END AS object_kind, CAST(pg_get_functiondef(p.oid) AS TEXT) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 ORDER BY p.proname".to_string(),
        ("postgresql", "triggers") => "SELECT CAST(t.tgname AS TEXT) AS object_name, 'trigger' AS object_kind, CAST(pg_get_triggerdef(t.oid) AS TEXT) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND NOT t.tgisinternal ORDER BY t.tgname".to_string(),
        ("postgresql", "sequences") => "SELECT CAST(c.relname AS TEXT) AS object_name, 'sequence' AS object_kind, CAST(NULL AS TEXT) AS definition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='S' ORDER BY c.relname".to_string(),
        ("postgresql", _) => "SELECT CAST(c.relname AS TEXT) AS object_name, CASE c.relkind WHEN 'r' THEN 'table' WHEN 'v' THEN 'view' WHEN 'S' THEN 'sequence' ELSE c.relkind::TEXT END AS object_kind, CAST(NULL AS TEXT) AS definition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','v','S') ORDER BY c.relname".to_string(),
        ("sqlite", "views") => "SELECT name AS object_name, 'view' AS object_kind, sql AS definition FROM sqlite_master WHERE type='view' ORDER BY name".to_string(),
        ("sqlite", "triggers") => "SELECT name AS object_name, 'trigger' AS object_kind, sql AS definition FROM sqlite_master WHERE type='trigger' ORDER BY name".to_string(),
        ("sqlite", "sequences" | "routines" | "procedures" | "functions") => "SELECT NULL AS object_name, 'unsupported' AS object_kind, NULL AS definition WHERE 1=0".to_string(),
        ("sqlite", _) => "SELECT name AS object_name, type AS object_kind, sql AS definition FROM sqlite_master WHERE type IN ('table','view','trigger') AND name NOT LIKE 'sqlite_%' ORDER BY name".to_string(),
        _ => return Err(("unsupported_database".into(), "Unsupported database type".into())),
    };
    let mut query = sqlx::query(&sql);
    if kind == "postgresql" {
        query = query.bind(if schema.is_empty() { "public" } else { schema });
    }
    rows_value(query.fetch_all(pool).await.map_err(db_error)?)
}

pub(crate) async fn schema_change(direct: &DirectPool, kind: &str, params: &Params) -> DbResult {
    let table = params.table.trim();
    validate_identifier(table)?;
    let qualified = if !params.schema.is_empty() && kind != "mysql" {
        format!(
            "{}.{}",
            quote_identifier(kind, &params.schema)?,
            quote_identifier(kind, table)?
        )
    } else {
        quote_identifier(kind, table)?
    };
    let operation = params.operation.as_str();
    let sql = match operation {
        "addColumn" => {
            validate_identifier(&params.name)?;
            let data_type = safe_sql_fragment(&params.data_type, "column type")?;
            let mut sql = format!(
                "ALTER TABLE {qualified} ADD COLUMN {} {data_type}",
                quote_identifier(kind, &params.name)?
            );
            if !params.nullable {
                sql.push_str(" NOT NULL");
            }
            if !params.default_value.is_empty() {
                sql.push_str(&format!(
                    " DEFAULT {}",
                    safe_sql_fragment(&params.default_value, "default")?
                ));
            }
            sql
        }
        "renameColumn" => {
            validate_identifier(&params.old_name)?;
            validate_identifier(&params.name)?;
            format!(
                "ALTER TABLE {qualified} RENAME COLUMN {} TO {}",
                quote_identifier(kind, &params.old_name)?,
                quote_identifier(kind, &params.name)?
            )
        }
        "dropColumn" => {
            validate_identifier(&params.name)?;
            format!(
                "ALTER TABLE {qualified} DROP COLUMN {}",
                quote_identifier(kind, &params.name)?
            )
        }
        "createIndex" => {
            validate_identifier(&params.index_name)?;
            let columns = quoted_columns(kind, &params.index_columns)?;
            if columns.is_empty() {
                return Err((
                    "invalid_schema_change".into(),
                    "At least one index column is required".into(),
                ));
            }
            format!(
                "CREATE INDEX {} ON {qualified} ({})",
                quote_identifier(kind, &params.index_name)?,
                columns.join(", ")
            )
        }
        "dropIndex" => {
            validate_identifier(&params.index_name)?;
            if kind == "mysql" {
                format!(
                    "DROP INDEX {} ON {qualified}",
                    quote_identifier(kind, &params.index_name)?
                )
            } else {
                format!("DROP INDEX {}", quote_identifier(kind, &params.index_name)?)
            }
        }
        "addForeignKey" => {
            validate_identifier(&params.constraint_name)?;
            validate_identifier(&params.referenced_table)?;
            let columns = quoted_columns(kind, &params.index_columns)?;
            let referenced = quoted_columns(kind, &params.referenced_columns)?;
            if columns.is_empty() || referenced.is_empty() || columns.len() != referenced.len() {
                return Err((
                    "invalid_schema_change".into(),
                    "Foreign-key columns must be paired".into(),
                ));
            }
            format!(
                "ALTER TABLE {qualified} ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({})",
                quote_identifier(kind, &params.constraint_name)?,
                columns.join(", "),
                quote_identifier(kind, &params.referenced_table)?,
                referenced.join(", ")
            )
        }
        "dropForeignKey" => {
            validate_identifier(&params.constraint_name)?;
            if kind == "mysql" {
                format!(
                    "ALTER TABLE {qualified} DROP FOREIGN KEY {}",
                    quote_identifier(kind, &params.constraint_name)?
                )
            } else {
                format!(
                    "ALTER TABLE {qualified} DROP CONSTRAINT {}",
                    quote_identifier(kind, &params.constraint_name)?
                )
            }
        }
        "createView" => {
            validate_identifier(&params.name)?;
            if params.sql.trim().is_empty() {
                return Err((
                    "invalid_schema_change".into(),
                    "View SQL is required".into(),
                ));
            }
            format!(
                "CREATE VIEW {} AS {}",
                quote_identifier(kind, &params.name)?,
                require_single_sql(&params.sql)?
            )
        }
        "dropView" => {
            validate_identifier(&params.name)?;
            format!("DROP VIEW {}", quote_identifier(kind, &params.name)?)
        }
        _ => {
            return Err((
                "invalid_schema_change".into(),
                format!("Unsupported schema operation: {operation}"),
            ))
        }
    };
    execute_direct(direct, &sql, &[]).await
}

pub(crate) fn quoted_columns(
    kind: &str,
    columns: &[String],
) -> Result<Vec<String>, (String, String)> {
    columns
        .iter()
        .map(|column| {
            validate_identifier(column)?;
            quote_identifier(kind, column)
        })
        .collect()
}

pub(crate) fn safe_sql_fragment(value: &str, label: &str) -> Result<String, (String, String)> {
    let value = value.trim();
    if value.is_empty()
        || value.contains(';')
        || value.contains("--")
        || value.contains("/*")
        || value.contains("*/")
        || value.chars().any(|character| character.is_control())
    {
        return Err(("invalid_schema_change".into(), format!("Invalid {label}")));
    }
    Ok(value.to_string())
}

pub(crate) fn require_single_sql(sql: &str) -> Result<String, (String, String)> {
    let trimmed = sql.trim();
    if trimmed.is_empty() || trimmed.contains(';') {
        return Err((
            "invalid_query".into(),
            "A single SQL statement is required".into(),
        ));
    }
    Ok(trimmed.to_string())
}

/// One page of `params.table` with `params`' filters, sort, limit, and offset.
pub(crate) async fn page_table(
    pool: &AnyPool,
    direct: &DirectPool,
    kind: &str,
    params: &Params,
) -> DbResult {
    let (schema, table) = (params.schema.as_str(), params.table.as_str());
    let (limit, offset) = (params.limit, params.offset);
    let (filters, sort) = (params.filters.as_slice(), params.sort.as_slice());
    validate_identifier(table)?;
    let qualified = if !schema.is_empty() && kind != "mysql" {
        format!(
            "{}.{}",
            quote_identifier(kind, schema)?,
            quote_identifier(kind, table)?
        )
    } else {
        quote_identifier(kind, table)?
    };
    let (where_sql, values) = filter_clause(kind, filters)?;
    let order_sql = sort_clause(kind, sort)?;
    let limit = limit.clamp(1, 1000);
    let sql =
        format!("SELECT * FROM {qualified}{where_sql}{order_sql} LIMIT {limit} OFFSET {offset}");
    let count_sql = format!("SELECT COUNT(*) AS total_rows FROM {qualified}{where_sql}");
    let mut result = query_direct(direct, &sql, &values, limit).await?;
    let count = bind_values(sqlx::query(&count_sql), &values)?
        .fetch_one(pool)
        .await
        .map_err(db_error)?;
    let total = count.try_get::<i64, _>(0).map_err(db_error)?;
    result
        .as_object_mut()
        .expect("query result object")
        .insert("totalRows".into(), json!(total));
    Ok(result)
}

pub(crate) fn filter_clause(
    kind: &str,
    filters: &[Filter],
) -> Result<(String, Vec<Value>), (String, String)> {
    let mut predicates = Vec::new();
    let mut values = Vec::new();
    for filter in filters {
        let column = quote_identifier(kind, &filter.column)?;
        let index = values.len() + 1;
        let predicate = match filter.operator.as_str() {
            "equals" => {
                values.push(filter.value.clone());
                format!("{column} = {}", placeholder(kind, index))
            }
            "notEquals" => {
                values.push(filter.value.clone());
                format!("{column} <> {}", placeholder(kind, index))
            }
            "greaterThan" => {
                values.push(filter.value.clone());
                format!("{column} > {}", placeholder(kind, index))
            }
            "lessThan" => {
                values.push(filter.value.clone());
                format!("{column} < {}", placeholder(kind, index))
            }
            "contains" => {
                values.push(Value::String(format!(
                    "%{}%",
                    scalar_string(&filter.value)?
                )));
                format!("{column} LIKE {}", placeholder(kind, index))
            }
            "startsWith" => {
                values.push(Value::String(format!("{}%", scalar_string(&filter.value)?)));
                format!("{column} LIKE {}", placeholder(kind, index))
            }
            "isNull" => format!("{column} IS NULL"),
            "isNotNull" => format!("{column} IS NOT NULL"),
            value => {
                return Err((
                    "invalid_filter".into(),
                    format!("Unsupported filter operator: {value}"),
                ))
            }
        };
        let join = match filter.join.as_str() {
            "and" => "AND",
            "or" => "OR",
            value => {
                return Err((
                    "invalid_filter".into(),
                    format!("Unsupported filter join: {value}"),
                ))
            }
        };
        predicates.push((join, predicate));
    }
    Ok((
        if predicates.is_empty() {
            String::new()
        } else {
            let mut clause = predicates[0].1.clone();
            for (join, predicate) in predicates.iter().skip(1) {
                clause.push_str(&format!(" {join} {predicate}"));
            }
            format!(" WHERE ({clause})")
        },
        values,
    ))
}

pub(crate) fn sort_clause(kind: &str, sort: &[Sort]) -> Result<String, (String, String)> {
    let mut items = Vec::new();
    for item in sort {
        items.push(format!(
            "{} {}",
            quote_identifier(kind, &item.column)?,
            if item.descending { "DESC" } else { "ASC" }
        ));
    }
    Ok(if items.is_empty() {
        String::new()
    } else {
        format!(" ORDER BY {}", items.join(", "))
    })
}

pub(crate) fn scalar_string(value: &Value) -> Result<String, (String, String)> {
    match value {
        Value::String(value) => Ok(value.clone()),
        Value::Number(value) => Ok(value.to_string()),
        Value::Bool(value) => Ok(value.to_string()),
        _ => Err((
            "invalid_filter".into(),
            "Text filters require a scalar value".into(),
        )),
    }
}

pub(crate) async fn query_direct(
    pool: &DirectPool,
    sql: &str,
    values: &[Value],
    limit: u32,
) -> DbResult {
    require_sql(sql)?;
    let maximum = limit.clamp(1, 100_000) as usize;
    let mut rows = Vec::with_capacity(maximum.min(200));
    let (truncated, columns) = match pool {
        DirectPool::MySql(pool) => {
            let mut stream = bind_mysql(sqlx::query(sql), values)?.fetch(pool);
            collect_query_rows(&mut stream, maximum, &mut rows, mysql_row_json).await?
        }
        DirectPool::Postgres(pool) => {
            let mut stream = bind_postgres(sqlx::query(sql), values)?.fetch(pool);
            collect_query_rows(&mut stream, maximum, &mut rows, postgres_row_json).await?
        }
        DirectPool::Sqlite(pool) => {
            let mut stream = bind_sqlite(sqlx::query(sql), values)?.fetch(pool);
            collect_query_rows(&mut stream, maximum, &mut rows, sqlite_row_json).await?
        }
    };
    Ok(json!({"columns": columns, "truncated": truncated, "rows": rows}))
}

pub(crate) async fn collect_query_rows<R, S>(
    stream: &mut S,
    maximum: usize,
    destination: &mut Vec<Value>,
    decode: fn(&R) -> Result<Value, (String, String)>,
) -> Result<(bool, Vec<String>), (String, String)>
where
    S: futures_util::TryStream<Ok = R, Error = sqlx::Error> + Unpin,
    R: Row,
{
    let mut columns = Vec::new();
    while let Some(row) = stream.try_next().await.map_err(db_error)? {
        if columns.is_empty() {
            columns = row
                .columns()
                .iter()
                .map(|column| column.name().to_string())
                .collect();
        }
        if destination.len() == maximum {
            return Ok((true, columns));
        }
        destination.push(decode(&row)?);
    }
    Ok((false, columns))
}

pub(crate) fn bind_mysql<'q>(
    mut query: sqlx::query::Query<'q, MySql, sqlx::mysql::MySqlArguments>,
    values: &'q [Value],
) -> Result<sqlx::query::Query<'q, MySql, sqlx::mysql::MySqlArguments>, (String, String)> {
    for value in values {
        query = bind_mysql_value(query, value);
    }
    Ok(query)
}
pub(crate) fn bind_postgres<'q>(
    mut query: sqlx::query::Query<'q, Postgres, sqlx::postgres::PgArguments>,
    values: &'q [Value],
) -> Result<sqlx::query::Query<'q, Postgres, sqlx::postgres::PgArguments>, (String, String)> {
    for value in values {
        query = bind_postgres_value(query, value);
    }
    Ok(query)
}
pub(crate) fn bind_sqlite<'q>(
    mut query: sqlx::query::Query<'q, Sqlite, sqlx::sqlite::SqliteArguments<'q>>,
    values: &'q [Value],
) -> Result<sqlx::query::Query<'q, Sqlite, sqlx::sqlite::SqliteArguments<'q>>, (String, String)> {
    for value in values {
        query = bind_sqlite_value(query, value);
    }
    Ok(query)
}

pub(crate) fn binary_input(object: &Map<String, Value>) -> Option<&str> {
    if object.len() != 1 {
        return None;
    }
    object
        .get("binary")
        .or_else(|| object.get("base64"))
        .and_then(Value::as_str)
}

pub(crate) fn tagged_binary(bytes: impl AsRef<[u8]>) -> Value {
    json!({"binary": BASE64.encode(bytes.as_ref())})
}

macro_rules! bind_value_fn {
    ($name:ident, $db:ty, $args:ty) => {
        fn $name<'q>(
            query: sqlx::query::Query<'q, $db, $args>,
            value: &'q Value,
        ) -> sqlx::query::Query<'q, $db, $args> {
            match value {
                Value::Null => query.bind(Option::<String>::None),
                Value::Bool(v) => query.bind(*v),
                Value::Number(v) if v.is_i64() => query.bind(v.as_i64().unwrap()),
                Value::Number(v) if v.is_u64() => query.bind(v.as_u64().unwrap() as i64),
                Value::Number(v) => query.bind(v.as_f64().unwrap()),
                Value::String(v) => query.bind(v),
                Value::Object(v) if v.get("decimal").and_then(Value::as_str).is_some() => {
                    match v["decimal"]
                        .as_str()
                        .unwrap()
                        .parse::<rust_decimal::Decimal>()
                    {
                        Ok(value) => query.bind(value),
                        Err(_) => query.bind(v["decimal"].as_str().unwrap()),
                    }
                }
                Value::Object(v) if v.get("date").and_then(Value::as_str).is_some() => {
                    match v["date"].as_str().unwrap().parse::<chrono::NaiveDate>() {
                        Ok(value) => query.bind(value),
                        Err(_) => query.bind(v["date"].as_str().unwrap()),
                    }
                }
                Value::Object(v) if v.get("time").and_then(Value::as_str).is_some() => {
                    match v["time"].as_str().unwrap().parse::<chrono::NaiveTime>() {
                        Ok(value) => query.bind(value),
                        Err(_) => query.bind(v["time"].as_str().unwrap()),
                    }
                }
                Value::Object(v) if v.get("datetime").and_then(Value::as_str).is_some() => {
                    match v["datetime"]
                        .as_str()
                        .unwrap()
                        .parse::<chrono::NaiveDateTime>()
                    {
                        Ok(value) => query.bind(value),
                        Err(_) => query.bind(v["datetime"].as_str().unwrap()),
                    }
                }
                Value::Object(v)
                    if v.get("timestampWithTimeZone")
                        .and_then(Value::as_str)
                        .is_some() =>
                {
                    match chrono::DateTime::parse_from_rfc3339(
                        v["timestampWithTimeZone"].as_str().unwrap(),
                    ) {
                        Ok(value) => query.bind(value.with_timezone(&chrono::Utc)),
                        Err(_) => query.bind(v["timestampWithTimeZone"].as_str().unwrap()),
                    }
                }
                Value::Object(v) if v.get("uuid").and_then(Value::as_str).is_some() => {
                    match v["uuid"].as_str().unwrap().parse::<uuid::Uuid>() {
                        Ok(value) => query.bind(value),
                        Err(_) => query.bind(v["uuid"].as_str().unwrap()),
                    }
                }
                Value::Object(v) if v.get("json").is_some() => {
                    query.bind(sqlx::types::Json(v["json"].clone()))
                }
                Value::Object(v) if binary_input(v).is_some() => {
                    match BASE64.decode(binary_input(v).unwrap()) {
                        Ok(value) => query.bind(value),
                        Err(_) => query.bind(Vec::<u8>::new()),
                    }
                }
                other => query.bind(other.to_string()),
            }
        }
    };
}
bind_value_fn!(bind_mysql_value, MySql, sqlx::mysql::MySqlArguments);
bind_value_fn!(bind_postgres_value, Postgres, sqlx::postgres::PgArguments);

pub(crate) fn bind_sqlite_value<'q>(
    query: sqlx::query::Query<'q, Sqlite, sqlx::sqlite::SqliteArguments<'q>>,
    value: &'q Value,
) -> sqlx::query::Query<'q, Sqlite, sqlx::sqlite::SqliteArguments<'q>> {
    match value {
        Value::Null => query.bind(Option::<String>::None),
        Value::Bool(v) => query.bind(*v),
        Value::Number(v) if v.is_i64() => query.bind(v.as_i64().unwrap()),
        Value::Number(v) if v.is_u64() => query.bind(v.as_u64().unwrap() as i64),
        Value::Number(v) => query.bind(v.as_f64().unwrap()),
        Value::String(v) => query.bind(v),
        Value::Object(v) if binary_input(v).is_some() => {
            query.bind(BASE64.decode(binary_input(v).unwrap()).unwrap_or_default())
        }
        Value::Object(v) if v.get("json").is_some() => query.bind(v["json"].to_string()),
        Value::Object(v) => {
            let tagged = [
                "decimal",
                "date",
                "time",
                "datetime",
                "timestampWithTimeZone",
                "uuid",
            ]
            .iter()
            .find_map(|key| v.get(*key).and_then(Value::as_str));
            query.bind(tagged.unwrap_or(""))
        }
        other => query.bind(other.to_string()),
    }
}

pub(crate) fn mysql_row_json(row: &MySqlRow) -> Result<Value, (String, String)> {
    typed_row_json(row, mysql_value)
}
pub(crate) fn postgres_row_json(row: &PgRow) -> Result<Value, (String, String)> {
    typed_row_json(row, postgres_value)
}
pub(crate) fn sqlite_row_json(row: &SqliteRow) -> Result<Value, (String, String)> {
    typed_row_json(row, sqlite_value)
}

pub(crate) fn typed_row_json<R>(
    row: &R,
    decode: fn(&R, usize, &str) -> Value,
) -> Result<Value, (String, String)>
where
    R: Row,
    usize: sqlx::ColumnIndex<R>,
{
    let mut object = Map::new();
    for (index, column) in row.columns().iter().enumerate() {
        let raw = row
            .try_get_raw(index)
            .map_err(|e| ("database_error".into(), e.to_string()))?;
        let value = if raw.is_null() {
            Value::Null
        } else {
            decode(row, index, column.type_info().name())
        };
        object.insert(column.name().to_string(), value);
    }
    Ok(Value::Object(object))
}

pub(crate) fn mysql_value(row: &MySqlRow, index: usize, kind: &str) -> Value {
    match kind.to_ascii_uppercase().as_str() {
        "DECIMAL" | "NEWDECIMAL" => row
            .try_get::<rust_decimal::Decimal, _>(index)
            .map(|v| json!({"decimal": v.to_string()}))
            .unwrap_or_else(|_| mysql_text(row, index)),
        "DATE" => row
            .try_get::<chrono::NaiveDate, _>(index)
            .map(|v| Value::String(v.to_string()))
            .unwrap_or_else(|_| mysql_text(row, index)),
        "TIME" => row
            .try_get::<chrono::NaiveTime, _>(index)
            .map(|v| Value::String(v.to_string()))
            .unwrap_or_else(|_| mysql_text(row, index)),
        "DATETIME" => row
            .try_get::<chrono::NaiveDateTime, _>(index)
            .map(|v| Value::String(v.to_string()))
            .or_else(|_| {
                row.try_get::<chrono::DateTime<chrono::Utc>, _>(index)
                    .map(|v| Value::String(v.to_rfc3339()))
            })
            .unwrap_or_else(|_| mysql_text(row, index)),
        "TIMESTAMP" => row
            .try_get::<chrono::DateTime<chrono::Utc>, _>(index)
            .map(|v| Value::String(v.to_rfc3339()))
            .or_else(|_| {
                row.try_get::<chrono::NaiveDateTime, _>(index)
                    .map(|v| Value::String(v.to_string()))
            })
            .or_else(|_| {
                row.try_get::<chrono::DateTime<chrono::Local>, _>(index)
                    .map(|v| Value::String(v.to_rfc3339()))
            })
            .unwrap_or_else(|_| mysql_text(row, index)),
        "BOOLEAN" | "BOOL" => row
            .try_get::<bool, _>(index)
            .map(Value::Bool)
            .or_else(|_| row.try_get::<i8, _>(index).map(|v| Value::Bool(v != 0)))
            .or_else(|_| row.try_get::<u8, _>(index).map(|v| Value::Bool(v != 0)))
            .or_else(|_| row.try_get::<i64, _>(index).map(|v| Value::Bool(v != 0)))
            .unwrap_or_else(|_| mysql_text(row, index)),
        "JSON" => row
            .try_get::<Value, _>(index)
            .unwrap_or_else(|_| mysql_text(row, index)),
        "BLOB" | "BINARY" | "VARBINARY" => row
            .try_get::<Vec<u8>, _>(index)
            .map(tagged_binary)
            .unwrap_or_else(|_| mysql_text(row, index)),
        "FLOAT" | "DOUBLE" => row
            .try_get::<f64, _>(index)
            .map(|v| json!(v))
            .unwrap_or_else(|_| mysql_text(row, index)),
        "TINYINT" => row
            .try_get::<i8, _>(index)
            .map(|v| json!(v))
            .or_else(|_| row.try_get::<u8, _>(index).map(|v| json!(v)))
            .or_else(|_| row.try_get::<i16, _>(index).map(|v| json!(v)))
            .or_else(|_| row.try_get::<i64, _>(index).map(|v| json!(v)))
            .or_else(|_| row.try_get::<u64, _>(index).map(|v| json!(v)))
            .unwrap_or_else(|_| mysql_text(row, index)),
        value if value.contains("INT") || value == "YEAR" => row
            .try_get::<i64, _>(index)
            .map(|v| json!(v))
            .or_else(|_| row.try_get::<u64, _>(index).map(|v| json!(v)))
            .unwrap_or_else(|_| mysql_text(row, index)),
        _ => mysql_text(row, index),
    }
}
pub(crate) fn mysql_text(row: &MySqlRow, index: usize) -> Value {
    row.try_get::<String, _>(index)
        .map(Value::String)
        .or_else(|_| row.try_get_unchecked::<String, _>(index).map(Value::String))
        .or_else(|_| {
            row.try_get::<Vec<u8>, _>(index)
                .map(|value| mysql_bytes_value(&value))
        })
        .or_else(|_| {
            row.try_get_unchecked::<Vec<u8>, _>(index)
                .map(|value| mysql_bytes_value(&value))
        })
        .or_else(|_| row.try_get::<i64, _>(index).map(|value| json!(value)))
        .or_else(|_| row.try_get::<u64, _>(index).map(|value| json!(value)))
        .or_else(|_| row.try_get::<f64, _>(index).map(|value| json!(value)))
        .unwrap_or_else(|_| Value::String("<unsupported>".into()))
}

pub(crate) fn mysql_bytes_value(value: &[u8]) -> Value {
    match String::from_utf8(value.to_vec()) {
        Ok(text) => Value::String(text),
        Err(_) => tagged_binary(value),
    }
}

pub(crate) fn postgres_value(row: &PgRow, index: usize, kind: &str) -> Value {
    match kind.to_ascii_uppercase().as_str() {
        "NUMERIC" => row
            .try_get::<rust_decimal::Decimal, _>(index)
            .map(|v| json!({"decimal": v.to_string()}))
            .unwrap_or_else(|_| pg_text(row, index)),
        "DATE" => row
            .try_get::<chrono::NaiveDate, _>(index)
            .map(|v| Value::String(v.to_string()))
            .unwrap_or_else(|_| pg_text(row, index)),
        "TIME" => row
            .try_get::<chrono::NaiveTime, _>(index)
            .map(|v| Value::String(v.to_string()))
            .unwrap_or_else(|_| pg_text(row, index)),
        "TIMESTAMP" => row
            .try_get::<chrono::NaiveDateTime, _>(index)
            .map(|v| Value::String(v.to_string()))
            .unwrap_or_else(|_| pg_text(row, index)),
        "TIMESTAMPTZ" => row
            .try_get::<chrono::DateTime<chrono::Utc>, _>(index)
            .map(|v| Value::String(v.to_rfc3339()))
            .unwrap_or_else(|_| pg_text(row, index)),
        "UUID" => row
            .try_get::<uuid::Uuid, _>(index)
            .map(|v| Value::String(v.to_string()))
            .unwrap_or_else(|_| pg_text(row, index)),
        "JSON" | "JSONB" => row
            .try_get::<Value, _>(index)
            .unwrap_or_else(|_| pg_text(row, index)),
        "BYTEA" => row
            .try_get::<Vec<u8>, _>(index)
            .map(tagged_binary)
            .unwrap_or_else(|_| pg_text(row, index)),
        "BOOL" => row
            .try_get::<bool, _>(index)
            .map(Value::Bool)
            .unwrap_or_else(|_| pg_text(row, index)),
        "INT2" => row
            .try_get::<i16, _>(index)
            .map(|v| json!(v))
            .unwrap_or_else(|_| pg_text(row, index)),
        "INT4" => row
            .try_get::<i32, _>(index)
            .map(|v| json!(v))
            .unwrap_or_else(|_| pg_text(row, index)),
        "INT8" => row
            .try_get::<i64, _>(index)
            .map(|v| json!(v))
            .unwrap_or_else(|_| pg_text(row, index)),
        "FLOAT4" => row
            .try_get::<f32, _>(index)
            .map(|v| json!(v))
            .unwrap_or_else(|_| pg_text(row, index)),
        "FLOAT8" => row
            .try_get::<f64, _>(index)
            .map(|v| json!(v))
            .unwrap_or_else(|_| pg_text(row, index)),
        _ => pg_text(row, index),
    }
}
pub(crate) fn pg_text(row: &PgRow, index: usize) -> Value {
    row.try_get::<String, _>(index)
        .map(Value::String)
        .unwrap_or_else(|_| Value::String("<unsupported>".into()))
}

pub(crate) fn sqlite_value(row: &SqliteRow, index: usize, kind: &str) -> Value {
    match kind.to_ascii_uppercase().as_str() {
        "INTEGER" | "INT" | "INT64" => row
            .try_get::<i64, _>(index)
            .map(|v| json!(v))
            .unwrap_or_else(|_| sqlite_text(row, index)),
        "REAL" | "FLOAT" | "DOUBLE" => row
            .try_get::<f64, _>(index)
            .map(|v| json!(v))
            .unwrap_or_else(|_| sqlite_text(row, index)),
        "BLOB" => row
            .try_get::<Vec<u8>, _>(index)
            .map(tagged_binary)
            .unwrap_or_else(|_| sqlite_text(row, index)),
        "BOOL" | "BOOLEAN" => row
            .try_get::<bool, _>(index)
            .map(Value::Bool)
            .unwrap_or_else(|_| sqlite_text(row, index)),
        _ => sqlite_text(row, index),
    }
}
pub(crate) fn sqlite_text(row: &SqliteRow, index: usize) -> Value {
    row.try_get::<String, _>(index)
        .map(Value::String)
        .unwrap_or_else(|_| Value::String("<unsupported>".into()))
}

pub(crate) async fn execute(pool: &AnyPool, sql: &str, values: &[Value]) -> DbResult {
    require_sql(sql)?;
    let result = bind_values(sqlx::query(sql), values)?
        .execute(pool)
        .await
        .map_err(db_error)?;
    Ok(json!({"rowsAffected": result.rows_affected()}))
}

pub(crate) async fn execute_direct(pool: &DirectPool, sql: &str, values: &[Value]) -> DbResult {
    require_sql(sql)?;
    let affected = match pool {
        DirectPool::MySql(pool) => bind_mysql(sqlx::query(sql), values)?
            .execute(pool)
            .await
            .map_err(db_error)?
            .rows_affected(),
        DirectPool::Postgres(pool) => bind_postgres(sqlx::query(sql), values)?
            .execute(pool)
            .await
            .map_err(db_error)?
            .rows_affected(),
        DirectPool::Sqlite(pool) => bind_sqlite(sqlx::query(sql), values)?
            .execute(pool)
            .await
            .map_err(db_error)?
            .rows_affected(),
    };
    Ok(json!({"rowsAffected": affected}))
}

pub(crate) async fn explain(pool: &AnyPool, kind: &str, sql: &str, format: &str) -> DbResult {
    let sql = require_single_sql(sql)?;
    let explain_sql = match kind {
        "postgresql" if format.eq_ignore_ascii_case("json") || format.is_empty() => {
            format!("EXPLAIN (FORMAT JSON) {sql}")
        }
        "postgresql" => format!("EXPLAIN {sql}"),
        "sqlite" => format!("EXPLAIN QUERY PLAN {sql}"),
        _ => format!("EXPLAIN {sql}"),
    };
    let rows = sqlx::query(&explain_sql)
        .fetch_all(pool)
        .await
        .map_err(db_error)?;
    Ok(
        json!({"format": if kind == "postgresql" && (format.is_empty() || format.eq_ignore_ascii_case("json")) { "json" } else { "rows" }, "rows": rows_value(rows)?, "truncated": false}),
    )
}

pub(crate) async fn diagnostics(pool: &AnyPool, kind: &str, params: &Params) -> DbResult {
    let diagnostic_kind = if params.diagnostic_kind.is_empty() {
        "tableSize"
    } else {
        params.diagnostic_kind.as_str()
    };
    if diagnostic_kind == "indexes" {
        let rows = list_indexes(pool, kind, &params.schema, &params.table).await?;
        return Ok(json!({"rows": rows, "truncated": false}));
    }
    let sql = match (kind, diagnostic_kind) {
        ("mysql", "tableSize") => "SELECT table_name, table_rows, data_length, index_length, (data_length + index_length) AS total_bytes FROM information_schema.tables WHERE table_schema=DATABASE() AND (? = '' OR table_name = ?) ORDER BY total_bytes DESC".to_string(),
        ("postgresql", "tableSize") => "SELECT c.relname AS table_name, c.reltuples AS estimated_rows, pg_total_relation_size(c.oid) AS total_bytes, pg_relation_size(c.oid) AS table_bytes FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND ($2='' OR c.relname=$2) AND c.relkind IN ('r','m') ORDER BY total_bytes DESC".to_string(),
        ("sqlite", "tableSize") => "SELECT name AS table_name, (SELECT page_count * page_size FROM pragma_page_count, pragma_page_size) AS total_bytes FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND (?='' OR name=?) ORDER BY name".to_string(),
        ("mysql", "locks") => "SELECT trx_id, trx_started, trx_state, trx_mysql_thread_id, trx_query FROM information_schema.innodb_trx ORDER BY trx_started".to_string(),
        ("postgresql", "locks") => "SELECT pid, locktype, mode, granted, relation::regclass AS relation, transactionid, query FROM pg_locks l LEFT JOIN pg_stat_activity a ON a.pid=l.pid WHERE NOT granted OR l.relation IS NOT NULL ORDER BY granted, pid".to_string(),
        ("sqlite", "locks") => "SELECT 'SQLite uses file-level locking; active lock state is not exposed by the driver' AS message".to_string(),
        ("mysql", "slowQueries") => "SELECT DIGEST_TEXT AS query, COUNT_STAR AS executions, AVG_TIMER_WAIT/1000000 AS avg_ms, SUM_TIMER_WAIT/1000000 AS total_ms, SUM_ROWS_AFFECTED AS rows_affected FROM performance_schema.events_statements_summary_by_digest WHERE DIGEST_TEXT IS NOT NULL ORDER BY SUM_TIMER_WAIT DESC LIMIT 100".to_string(),
        ("postgresql", "slowQueries") => "SELECT query, calls AS executions, mean_exec_time AS avg_ms, total_exec_time AS total_ms, rows FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 100".to_string(),
        ("sqlite", "slowQueries") => "SELECT NULL AS query, 0 AS executions, 0 AS avg_ms, 0 AS total_ms WHERE 1=0".to_string(),
        ("mysql", "schemaImpact") => "SELECT TABLE_NAME AS table_name, CONSTRAINT_NAME AS constraint_name, REFERENCED_TABLE_NAME AS referenced_table_name FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL AND (?='' OR REFERENCED_TABLE_NAME=?) ORDER BY TABLE_NAME".to_string(),
        ("postgresql", "schemaImpact") => "SELECT CAST(tc.table_name AS TEXT) AS table_name, CAST(tc.constraint_name AS TEXT) AS constraint_name, CAST(ccu.table_name AS TEXT) AS referenced_table_name FROM information_schema.table_constraints tc JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name=tc.constraint_name AND ccu.constraint_schema=tc.constraint_schema WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema=$1 AND ($2='' OR ccu.table_name=$2) ORDER BY tc.table_name".to_string(),
        ("sqlite", "schemaImpact") => "SELECT m.name AS table_name, f.id AS foreign_key_id, f.table AS referenced_table_name FROM sqlite_master m, pragma_foreign_key_list(m.name) f WHERE m.type='table' AND (?='' OR f.table=?) ORDER BY m.name".to_string(),
        (_, "dataQuality") => return data_quality(pool, kind, params).await,
        _ => return Err(("unsupported_diagnostic".into(), format!("Unsupported diagnostic: {diagnostic_kind}"))),
    };
    let mut query = sqlx::query(&sql);
    match (kind, diagnostic_kind) {
        ("postgresql", "tableSize" | "locks" | "slowQueries") => {}
        ("postgresql", "schemaImpact") => {
            query = query
                .bind(if params.schema.is_empty() {
                    "public"
                } else {
                    params.schema.as_str()
                })
                .bind(&params.table);
        }
        ("mysql" | "sqlite", "tableSize" | "schemaImpact") => {
            query = query.bind(&params.table).bind(&params.table);
        }
        _ => {}
    }
    if kind == "postgresql" && diagnostic_kind == "tableSize" {
        query = query
            .bind(if params.schema.is_empty() {
                "public"
            } else {
                params.schema.as_str()
            })
            .bind(&params.table);
    }
    rows_value(query.fetch_all(pool).await.map_err(db_error)?)
}

pub(crate) async fn data_quality(pool: &AnyPool, kind: &str, params: &Params) -> DbResult {
    validate_identifier(&params.table)?;
    let description = describe_table(pool, kind, &params.schema, &params.table).await?;
    let rows = description.as_array().cloned().unwrap_or_default();
    let mut results = Vec::new();
    for row in rows {
        let column = row
            .get("column_name")
            .and_then(Value::as_str)
            .or_else(|| row.get("name").and_then(Value::as_str))
            .unwrap_or_default();
        if column.is_empty() {
            continue;
        }
        let qualified = if !params.schema.is_empty() && kind != "mysql" {
            format!(
                "{}.{}",
                quote_identifier(kind, &params.schema)?,
                quote_identifier(kind, &params.table)?
            )
        } else {
            quote_identifier(kind, &params.table)?
        };
        let sql = format!("SELECT COUNT(*) AS total_rows, SUM(CASE WHEN {} IS NULL THEN 1 ELSE 0 END) AS null_rows FROM {qualified}", quote_identifier(kind, column)?);
        let values = rows_value(sqlx::query(&sql).fetch_all(pool).await.map_err(db_error)?)?;
        if let Some(value) = values.as_array().and_then(|items| items.first()) {
            results.push(json!({"column": column, "metrics": value}));
        }
    }
    Ok(json!({"rows": results, "truncated": false}))
}

pub(crate) async fn run_transaction(
    pool: &DirectPool,
    _kind: &str,
    statements: &[Statement],
) -> DbResult {
    if statements.is_empty() {
        return Ok(json!({"rowsAffected": 0}));
    }
    let mut affected = 0_u64;
    match pool {
        DirectPool::MySql(pool) => {
            let mut transaction = pool.begin().await.map_err(db_error)?;
            for statement in statements {
                affected += bind_mysql(sqlx::query(&statement.sql), &statement.values)?
                    .execute(&mut *transaction)
                    .await
                    .map_err(db_error)?
                    .rows_affected();
            }
            transaction.commit().await.map_err(db_error)?;
        }
        DirectPool::Postgres(pool) => {
            let mut transaction = pool.begin().await.map_err(db_error)?;
            for statement in statements {
                affected += bind_postgres(sqlx::query(&statement.sql), &statement.values)?
                    .execute(&mut *transaction)
                    .await
                    .map_err(db_error)?
                    .rows_affected();
            }
            transaction.commit().await.map_err(db_error)?;
        }
        DirectPool::Sqlite(pool) => {
            let mut transaction = pool.begin().await.map_err(db_error)?;
            for statement in statements {
                affected += bind_sqlite(sqlx::query(&statement.sql), &statement.values)?
                    .execute(&mut *transaction)
                    .await
                    .map_err(db_error)?
                    .rows_affected();
            }
            transaction.commit().await.map_err(db_error)?;
        }
    }
    Ok(json!({"rowsAffected": affected}))
}

pub(crate) async fn apply_changes(
    pool: &DirectPool,
    kind: &str,
    schema: &str,
    mutations: &[Mutation],
) -> DbResult {
    if mutations.is_empty() {
        return Ok(json!({"rowsAffected": 0}));
    }
    let mut affected = 0_u64;
    match pool {
        DirectPool::MySql(pool) => {
            let mut transaction = pool.begin().await.map_err(db_error)?;
            for mutation in mutations {
                let (sql, values) = mutation_sql(kind, schema, mutation)?;
                affected += bind_mysql(sqlx::query(&sql), &values)?
                    .execute(&mut *transaction)
                    .await
                    .map_err(db_error)?
                    .rows_affected();
            }
            transaction.commit().await.map_err(db_error)?;
        }
        DirectPool::Postgres(pool) => {
            let mut transaction = pool.begin().await.map_err(db_error)?;
            for mutation in mutations {
                let (sql, values) = mutation_sql(kind, schema, mutation)?;
                affected += bind_postgres(sqlx::query(&sql), &values)?
                    .execute(&mut *transaction)
                    .await
                    .map_err(db_error)?
                    .rows_affected();
            }
            transaction.commit().await.map_err(db_error)?;
        }
        DirectPool::Sqlite(pool) => {
            let mut transaction = pool.begin().await.map_err(db_error)?;
            for mutation in mutations {
                let (sql, values) = mutation_sql(kind, schema, mutation)?;
                affected += bind_sqlite(sqlx::query(&sql), &values)?
                    .execute(&mut *transaction)
                    .await
                    .map_err(db_error)?
                    .rows_affected();
            }
            transaction.commit().await.map_err(db_error)?;
        }
    }
    Ok(json!({"rowsAffected": affected}))
}

pub(crate) fn mutation_sql(
    kind: &str,
    schema: &str,
    mutation: &Mutation,
) -> Result<(String, Vec<Value>), (String, String)> {
    validate_identifier(&mutation.table)?;
    let table = if !schema.is_empty() && kind != "mysql" {
        format!(
            "{}.{}",
            quote_identifier(kind, schema)?,
            quote_identifier(kind, &mutation.table)?
        )
    } else {
        quote_identifier(kind, &mutation.table)?
    };
    let columns = |map: &Map<String, Value>| -> Result<Vec<String>, (String, String)> {
        map.keys().map(|key| quote_identifier(kind, key)).collect()
    };
    match mutation.action.as_str() {
        "insert" => {
            if mutation.values.is_empty() {
                let sql = if kind == "mysql" {
                    format!("INSERT INTO {table} () VALUES ()")
                } else {
                    format!("INSERT INTO {table} DEFAULT VALUES")
                };
                return Ok((sql, Vec::new()));
            }
            let names = columns(&mutation.values)?;
            let placeholders = placeholders(kind, 1, names.len());
            Ok((
                format!(
                    "INSERT INTO {table} ({}) VALUES ({})",
                    names.join(", "),
                    placeholders.join(", ")
                ),
                mutation.values.values().cloned().collect(),
            ))
        }
        "update" => {
            require_key(&mutation.key)?;
            if mutation.values.is_empty() {
                return Err((
                    "invalid_mutation".into(),
                    "Update values cannot be empty".into(),
                ));
            }
            let names = columns(&mutation.values)?;
            let key_names = columns(&mutation.key)?;
            let assignments: Vec<String> = names
                .iter()
                .enumerate()
                .map(|(index, name)| format!("{name} = {}", placeholder(kind, index + 1)))
                .collect();
            let predicates: Vec<String> = key_names
                .iter()
                .enumerate()
                .map(|(index, name)| {
                    format!("{name} = {}", placeholder(kind, names.len() + index + 1))
                })
                .collect();
            let mut values: Vec<Value> = mutation.values.values().cloned().collect();
            values.extend(mutation.key.values().cloned());
            Ok((
                format!(
                    "UPDATE {table} SET {} WHERE {}",
                    assignments.join(", "),
                    predicates.join(" AND ")
                ),
                values,
            ))
        }
        "delete" => {
            require_key(&mutation.key)?;
            let names = columns(&mutation.key)?;
            let predicates: Vec<String> = names
                .iter()
                .enumerate()
                .map(|(index, name)| format!("{name} = {}", placeholder(kind, index + 1)))
                .collect();
            Ok((
                format!("DELETE FROM {table} WHERE {}", predicates.join(" AND ")),
                mutation.key.values().cloned().collect(),
            ))
        }
        action => Err((
            "invalid_mutation".into(),
            format!("Unsupported mutation action: {action}"),
        )),
    }
}

pub(crate) fn require_key(key: &Map<String, Value>) -> Result<(), (String, String)> {
    if key.is_empty() {
        Err((
            "unsafe_mutation".into(),
            "Update and delete require a primary key".into(),
        ))
    } else {
        Ok(())
    }
}

pub(crate) fn placeholders(kind: &str, start: usize, count: usize) -> Vec<String> {
    (start..start + count)
        .map(|index| placeholder(kind, index))
        .collect()
}

pub(crate) fn placeholder(kind: &str, index: usize) -> String {
    if kind == "postgresql" {
        format!("${index}")
    } else {
        "?".into()
    }
}
