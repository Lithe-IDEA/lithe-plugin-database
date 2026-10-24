//! CSV and JSON import and export, and SQL backups and restores.

use crate::*;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use futures_util::TryStreamExt;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use sqlx::AnyPool;
use std::{
    fs::File,
    io::{self, BufReader, BufWriter, Read, Write},
};

pub(crate) async fn export_csv(
    pool: &DirectPool,
    sql: &str,
    values: &[Value],
    limit: u32,
) -> DbResult {
    let result = query_direct(pool, sql, values, limit).await?;
    let rows = result["rows"].as_array().cloned().unwrap_or_default();
    let headers: Vec<String> = result["columns"]
        .as_array()
        .map(|columns| {
            columns
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .filter(|columns: &Vec<String>| !columns.is_empty())
        .unwrap_or_else(|| {
            rows.first()
                .and_then(Value::as_object)
                .map(|row| row.keys().cloned().collect())
                .unwrap_or_default()
        });
    let mut writer = csv::Writer::from_writer(Vec::new());
    writer.write_record(&headers).map_err(csv_error)?;
    for row in rows {
        let object = row
            .as_object()
            .ok_or_else(|| ("export_failed".into(), "Invalid row".into()))?;
        writer
            .write_record(
                headers
                    .iter()
                    .map(|key| csv_value(object.get(key).unwrap_or(&Value::Null))),
            )
            .map_err(csv_error)?;
    }
    let bytes = writer
        .into_inner()
        .map_err(|e| ("export_failed".into(), e.to_string()))?;
    Ok(json!({"encoding": "base64", "data": BASE64.encode(bytes)}))
}

pub(crate) async fn export_json(
    pool: &DirectPool,
    sql: &str,
    values: &[Value],
    limit: u32,
) -> DbResult {
    let result = query_direct(pool, sql, values, limit).await?;
    let bytes = serde_json::to_vec_pretty(&result["rows"])
        .map_err(|e| ("export_failed".into(), e.to_string()))?;
    Ok(json!({"encoding": "base64", "data": BASE64.encode(bytes)}))
}

pub(crate) async fn import_data(
    pool: &DirectPool,
    kind: &str,
    schema: &str,
    table: &str,
    data: &str,
    format: &str,
) -> DbResult {
    let bytes = BASE64
        .decode(data)
        .map_err(|e| ("invalid_import".into(), format!("Invalid base64 data: {e}")))?;
    let rows = if format == "csv" {
        parse_csv(&bytes)?
    } else {
        parse_json(&bytes)?
    };
    if rows.is_empty() {
        return Ok(json!({"rowsAffected": 0}));
    }
    if rows.len() > 100_000 {
        return Err((
            "import_too_large".into(),
            "A single import is limited to 100000 rows".into(),
        ));
    }
    let mutations: Vec<Mutation> = rows
        .into_iter()
        .map(|values| Mutation {
            action: "insert".into(),
            table: table.into(),
            values,
            key: Map::new(),
        })
        .collect();
    apply_changes(pool, kind, schema, &mutations).await
}

pub(crate) fn parse_csv(bytes: &[u8]) -> Result<Vec<Map<String, Value>>, (String, String)> {
    let mut reader = csv::ReaderBuilder::new().flexible(false).from_reader(bytes);
    let headers: Vec<String> = reader
        .headers()
        .map_err(csv_error)?
        .iter()
        .map(str::to_string)
        .collect();
    for header in &headers {
        validate_identifier(header)?;
    }
    reader
        .records()
        .map(|record| {
            let record = record.map_err(csv_error)?;
            Ok(headers
                .iter()
                .zip(record.iter())
                .map(|(key, value)| (key.clone(), Value::String(value.into())))
                .collect())
        })
        .collect()
}

pub(crate) fn parse_json(bytes: &[u8]) -> Result<Vec<Map<String, Value>>, (String, String)> {
    let rows: Vec<Map<String, Value>> = serde_json::from_slice(bytes).map_err(|e| {
        (
            "invalid_import".into(),
            format!("Expected an array of JSON objects: {e}"),
        )
    })?;
    for row in &rows {
        for key in row.keys() {
            validate_identifier(key)?;
        }
    }
    Ok(rows)
}

pub(crate) async fn import_sql(pool: &AnyPool, data: &str) -> DbResult {
    let bytes = BASE64
        .decode(data)
        .map_err(|e| ("invalid_import".into(), format!("Invalid base64 data: {e}")))?;
    import_sql_bytes(pool, &bytes).await
}

pub(crate) async fn import_sql_file(pool: &AnyPool, path: &str) -> DbResult {
    if path.trim().is_empty() {
        return Err(("invalid_import".into(), "SQL file path is required".into()));
    }
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|error| ("invalid_import".into(), error.to_string()))?;
    import_sql_bytes(pool, &bytes).await
}

pub(crate) async fn restore_sql(pool: &AnyPool, kind: &str, schema: &str, data: &str) -> DbResult {
    let bytes = BASE64
        .decode(data)
        .map_err(|e| ("invalid_import".into(), format!("Invalid base64 data: {e}")))?;
    restore_sql_bytes(pool, kind, schema, &bytes).await
}

pub(crate) async fn restore_sql_file(
    pool: &AnyPool,
    kind: &str,
    schema: &str,
    path: &str,
) -> DbResult {
    if path.trim().is_empty() {
        return Err(("invalid_import".into(), "SQL file path is required".into()));
    }
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|error| ("invalid_import".into(), error.to_string()))?;
    restore_sql_bytes(pool, kind, schema, &bytes).await
}

pub(crate) async fn restore_sql_bytes(
    pool: &AnyPool,
    kind: &str,
    schema: &str,
    bytes: &[u8],
) -> DbResult {
    let script = validated_sql_script(bytes)?;
    if script.trim().is_empty() {
        return Err((
            "invalid_import".into(),
            "SQL restore file cannot be empty".into(),
        ));
    }
    drop_database_objects(pool, kind, schema).await?;
    execute_sql_script(pool, script).await
}

pub(crate) async fn import_sql_bytes(pool: &AnyPool, bytes: &[u8]) -> DbResult {
    let script = validated_sql_script(bytes)?;
    execute_sql_script(pool, script).await
}

pub(crate) fn validated_sql_script(bytes: &[u8]) -> Result<&str, (String, String)> {
    if bytes.len() > 256 * 1024 * 1024 {
        return Err((
            "import_too_large".into(),
            "SQL import is limited to 256 MB per request".into(),
        ));
    }
    let script = std::str::from_utf8(bytes).map_err(|e| {
        (
            "invalid_import".into(),
            format!("SQL file must be UTF-8: {e}"),
        )
    })?;
    Ok(script)
}

pub(crate) async fn execute_sql_script(pool: &AnyPool, script: &str) -> DbResult {
    if script.trim().is_empty() {
        return Ok(json!({"rowsAffected": 0}));
    }
    let result = sqlx::raw_sql(script)
        .execute(pool)
        .await
        .map_err(db_error)?;
    Ok(json!({"rowsAffected": result.rows_affected()}))
}

/// What a SQL backup covers: `selected` tables of `schema` (all when
/// empty), their structure and data, and at most `limit` rows per table.
pub(crate) struct SqlBackup<'a> {
    pub(crate) kind: &'a str,
    pub(crate) schema: &'a str,
    pub(crate) selected: &'a [String],
    pub(crate) include_structure: bool,
    pub(crate) include_data: bool,
    pub(crate) limit: u32,
}

impl<'a> SqlBackup<'a> {
    pub(crate) fn new(kind: &'a str, params: &'a Params) -> Self {
        Self {
            kind,
            schema: &params.schema,
            selected: &params.selected_tables,
            include_structure: params.include_structure,
            include_data: params.include_data,
            limit: params.limit,
        }
    }
}

pub(crate) async fn export_sql(
    pool: &AnyPool,
    direct: &DirectPool,
    backup: &SqlBackup<'_>,
) -> DbResult {
    let mut output = Vec::new();
    write_sql_backup(&mut output, pool, direct, backup).await?;
    Ok(json!({"encoding": "base64", "data": BASE64.encode(output)}))
}

pub(crate) async fn write_sql_backup<W: Write>(
    output: &mut W,
    pool: &AnyPool,
    direct: &DirectPool,
    backup: &SqlBackup<'_>,
) -> Result<(), (String, String)> {
    let SqlBackup {
        kind,
        schema,
        selected,
        include_structure,
        include_data,
        limit,
    } = *backup;
    let schema = if schema.is_empty() && kind == "postgresql" {
        "public"
    } else {
        schema
    };
    let objects = database_objects(pool, kind, schema).await?;
    let selected_set: std::collections::HashSet<&str> =
        selected.iter().map(String::as_str).collect();
    for name in selected {
        validate_identifier(name)?;
    }
    let objects: Vec<(String, String)> = objects
        .into_iter()
        .filter(|(name, _)| selected_set.is_empty() || selected_set.contains(name.as_str()))
        .collect();
    write_export(
        output,
        "-- Lithe SQL backup\n-- Generated by the Lithe database plugin\n\n",
    )?;
    match kind {
        "mysql" => write_export(output, "SET FOREIGN_KEY_CHECKS=0;\n\n")?,
        "sqlite" => write_export(output, "PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n\n")?,
        "postgresql" => write_export(output, "BEGIN;\n\n")?,
        _ => {}
    }
    if include_structure {
        write_export(output, "-- Remove existing objects before restore\n")?;
        for (name, object_type) in objects.iter().rev() {
            if let Some(statement) = object_drop_sql(kind, schema, name, object_type)? {
                write_export(output, &statement)?;
                write_export(output, ";\n")?;
            }
        }
        write_export(output, "\n")?;
        for (name, object_type) in &objects {
            let ddl = object_ddl(pool, kind, schema, name, object_type).await?;
            if !ddl.trim().is_empty() {
                write_export(
                    output,
                    &format!(
                        "-- Structure for {name}\n{};\n\n",
                        ddl.trim().trim_end_matches(';')
                    ),
                )?;
            }
        }
        if kind == "postgresql" {
            let table_names: Vec<&str> = objects
                .iter()
                .filter(|(_, object_type)| object_type.eq_ignore_ascii_case("base table"))
                .map(|(name, _)| name.as_str())
                .collect();
            let foreign_keys = postgres_foreign_key_ddls(pool, schema, &table_names).await?;
            if !foreign_keys.is_empty() {
                write_export(output, "-- Foreign key constraints\n")?;
                for statement in foreign_keys {
                    write_export(output, &statement)?;
                    write_export(output, ";\n")?;
                }
                write_export(output, "\n")?;
            }
        }
    }
    if include_data {
        for (name, object_type) in &objects {
            if !object_type.eq_ignore_ascii_case("table")
                && !object_type.eq_ignore_ascii_case("base table")
            {
                continue;
            }
            write_export(output, &format!("-- Data for {name}\n"))?;
            write_table_insert_sql(output, direct, kind, schema, name, limit).await?;
            if kind == "postgresql" {
                write_export(output, &postgres_sequence_sql(pool, schema, name).await?)?;
            }
            write_export(output, "\n")?;
        }
    }
    match kind {
        "mysql" => write_export(output, "SET FOREIGN_KEY_CHECKS=1;\n")?,
        "sqlite" => write_export(output, "COMMIT;\nPRAGMA foreign_keys=ON;\n")?,
        "postgresql" => write_export(output, "COMMIT;\n")?,
        _ => {}
    }
    Ok(())
}

pub(crate) async fn export_sql_to_file(
    pool: &AnyPool,
    direct: &DirectPool,
    backup: &SqlBackup<'_>,
    path: &str,
) -> DbResult {
    if path.trim().is_empty() {
        return Err((
            "invalid_export".into(),
            "Output file path is required".into(),
        ));
    }
    let file = File::create(path).map_err(export_io_error)?;
    let mut output = BufWriter::new(file);
    write_sql_backup(&mut output, pool, direct, backup).await?;
    output.flush().map_err(export_io_error)?;
    drop(output);
    let (byte_count, sha256) = sha256_file(path)?;
    Ok(json!({
        "path": path,
        "byteCount": byte_count,
        "sha256": sha256
    }))
}

pub(crate) fn write_export<W: Write>(output: &mut W, text: &str) -> Result<(), (String, String)> {
    output.write_all(text.as_bytes()).map_err(export_io_error)
}

pub(crate) fn export_io_error(error: io::Error) -> (String, String) {
    ("export_failed".into(), error.to_string())
}

pub(crate) fn sha256_file(path: &str) -> Result<(u64, String), (String, String)> {
    let file = File::open(path).map_err(export_io_error)?;
    let mut reader = BufReader::new(file);
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut byte_count = 0u64;
    loop {
        let bytes_read = reader.read(&mut buffer).map_err(export_io_error)?;
        if bytes_read == 0 {
            break;
        }
        digest.update(&buffer[..bytes_read]);
        byte_count += bytes_read as u64;
    }
    Ok((byte_count, hex::encode(digest.finalize())))
}

pub(crate) async fn database_objects(
    pool: &AnyPool,
    kind: &str,
    schema: &str,
) -> Result<Vec<(String, String)>, (String, String)> {
    let (sql, bind_schema) = match kind {
        "mysql" => ("SELECT table_name, table_type FROM information_schema.tables WHERE table_schema=DATABASE() ORDER BY CASE WHEN table_type='BASE TABLE' THEN 0 ELSE 1 END, table_name", false),
        "postgresql" => ("SELECT CAST(table_name AS TEXT), CAST(table_type AS TEXT) FROM information_schema.tables WHERE table_schema=$1 ORDER BY CASE WHEN table_type='BASE TABLE' THEN 0 ELSE 1 END, table_name", true),
        _ => ("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name", false),
    };
    let mut query = sqlx::query(sql);
    if bind_schema {
        query = query.bind(schema);
    }
    let rows = query.fetch_all(pool).await.map_err(db_error)?;
    rows.iter()
        .map(|row| Ok((row_string(row, 0)?, row_string(row, 1)?)))
        .collect()
}

pub(crate) async fn drop_database_objects(
    pool: &AnyPool,
    kind: &str,
    schema: &str,
) -> Result<(), (String, String)> {
    let schema = if schema.is_empty() && kind == "postgresql" {
        "public"
    } else {
        schema
    };
    match kind {
        "mysql" => {
            sqlx::query("SET FOREIGN_KEY_CHECKS=0")
                .execute(pool)
                .await
                .map_err(db_error)?;
        }
        "sqlite" => {
            sqlx::query("PRAGMA foreign_keys=OFF")
                .execute(pool)
                .await
                .map_err(db_error)?;
        }
        _ => {}
    }
    let objects = database_objects(pool, kind, schema).await?;
    for (name, object_type) in objects.iter().rev() {
        if let Some(statement) = object_drop_sql(kind, schema, name, object_type)? {
            sqlx::query(&statement)
                .execute(pool)
                .await
                .map_err(db_error)?;
        }
    }
    Ok(())
}

pub(crate) fn object_drop_sql(
    kind: &str,
    schema: &str,
    name: &str,
    object_type: &str,
) -> Result<Option<String>, (String, String)> {
    let qualified = if kind == "postgresql" {
        format!(
            "{}.{}",
            quote_identifier(kind, schema)?,
            quote_identifier(kind, name)?
        )
    } else {
        quote_identifier(kind, name)?
    };
    if object_type.eq_ignore_ascii_case("view") {
        return Ok(Some(format!("DROP VIEW IF EXISTS {qualified}")));
    }
    if object_type.eq_ignore_ascii_case("table") || object_type.eq_ignore_ascii_case("base table") {
        return Ok(Some(format!(
            "DROP TABLE IF EXISTS {qualified}{}",
            if kind == "postgresql" { " CASCADE" } else { "" }
        )));
    }
    Ok(None)
}

pub(crate) async fn object_ddl(
    pool: &AnyPool,
    kind: &str,
    schema: &str,
    name: &str,
    object_type: &str,
) -> Result<String, (String, String)> {
    validate_identifier(name)?;
    match kind {
        "sqlite" => {
            let row = sqlx::query(
                "SELECT sql FROM sqlite_master WHERE name=? AND type IN ('table','view')",
            )
            .bind(name)
            .fetch_one(pool)
            .await
            .map_err(db_error)?;
            let mut ddl = row_string(&row, 0)?;
            if object_type.eq_ignore_ascii_case("table") {
                let indexes = sqlx::query("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL ORDER BY name").bind(name).fetch_all(pool).await.map_err(db_error)?;
                for index in indexes {
                    ddl.push_str(";\n");
                    ddl.push_str(&row_string(&index, 0)?);
                }
            }
            Ok(ddl)
        }
        "mysql" => {
            let sql = format!(
                "SHOW CREATE {} {}",
                if object_type.eq_ignore_ascii_case("view") {
                    "VIEW"
                } else {
                    "TABLE"
                },
                quote_identifier(kind, name)?
            );
            let row = sqlx::query(&sql).fetch_one(pool).await.map_err(db_error)?;
            row_string(&row, 1)
        }
        "postgresql" if object_type.eq_ignore_ascii_case("view") => {
            let row = sqlx::query("SELECT 'CREATE OR REPLACE VIEW ' || quote_ident($1) || '.' || quote_ident($2) || ' AS ' || pg_get_viewdef((quote_ident($1)||'.'||quote_ident($2))::regclass, true)")
                .bind(schema).bind(name).fetch_one(pool).await.map_err(db_error)?;
            row_string(&row, 0)
        }
        "postgresql" => postgres_table_ddl(pool, schema, name).await,
        _ => Err(("unsupported_database".into(), kind.into())),
    }
}

pub(crate) async fn postgres_table_ddl(
    pool: &AnyPool,
    schema: &str,
    table: &str,
) -> Result<String, (String, String)> {
    let column_sql = r#"SELECT quote_ident(a.attname) || ' ' || pg_catalog.format_type(a.atttypid,a.atttypmod) ||
        CASE WHEN a.attidentity='a' THEN ' GENERATED ALWAYS AS IDENTITY' WHEN a.attidentity='d' THEN ' GENERATED BY DEFAULT AS IDENTITY'
             WHEN d.adbin IS NOT NULL THEN ' DEFAULT ' || pg_get_expr(d.adbin,d.adrelid) ELSE '' END ||
        CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END
        FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE n.nspname=$1 AND c.relname=$2 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum"#;
    let rows = sqlx::query(column_sql)
        .bind(schema)
        .bind(table)
        .fetch_all(pool)
        .await
        .map_err(db_error)?;
    let mut definitions: Vec<String> = rows
        .iter()
        .map(|row| row_string(row, 0))
        .collect::<Result<_, _>>()?;
    let constraints = sqlx::query("SELECT 'CONSTRAINT '||quote_ident(con.conname)||' '||pg_get_constraintdef(con.oid,true) FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 AND con.contype <> 'f' ORDER BY con.conname")
        .bind(schema).bind(table).fetch_all(pool).await.map_err(db_error)?;
    definitions.extend(
        constraints
            .iter()
            .map(|row| row_string(row, 0))
            .collect::<Result<Vec<_>, _>>()?,
    );
    let qualified = format!(
        "{}.{}",
        quote_identifier("postgresql", schema)?,
        quote_identifier("postgresql", table)?
    );
    let sequence_ddl = postgres_table_sequence_ddl(pool, schema, table).await?;
    let mut ddl = String::new();
    if !sequence_ddl.is_empty() {
        ddl.push_str(&sequence_ddl);
        ddl.push_str(";\n");
    }
    ddl.push_str(&format!(
        "CREATE TABLE {qualified} (\n  {}\n)",
        definitions.join(",\n  ")
    ));
    let indexes = sqlx::query("SELECT pg_get_indexdef(i.indexrelid) FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=$1 AND t.relname=$2 AND NOT i.indisprimary AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid=i.indexrelid) ORDER BY i.indexrelid")
        .bind(schema).bind(table).fetch_all(pool).await.map_err(db_error)?;
    for index in indexes {
        ddl.push_str(";\n");
        ddl.push_str(&row_string(&index, 0)?);
    }
    Ok(ddl)
}

pub(crate) async fn postgres_table_sequence_ddl(
    pool: &AnyPool,
    schema: &str,
    table: &str,
) -> Result<String, (String, String)> {
    // Identity columns create their own sequence as part of CREATE TABLE. For
    // legacy serial columns PostgreSQL stores a nextval() default that refers
    // to a separate, owned sequence, so restore must recreate it first.
    let rows = sqlx::query("SELECT quote_ident(sn.nspname)||'.'||quote_ident(seq.relname), quote_ident(a.attname) FROM pg_attribute a JOIN pg_class t ON t.oid=a.attrelid JOIN pg_namespace tn ON tn.oid=t.relnamespace JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum JOIN pg_depend dep ON dep.refobjid=a.attrelid AND dep.refobjsubid=a.attnum AND dep.deptype='a' JOIN pg_class seq ON seq.oid=dep.objid AND seq.relkind='S' JOIN pg_namespace sn ON sn.oid=seq.relnamespace WHERE tn.nspname=$1 AND t.relname=$2 AND a.attnum>0 AND NOT a.attisdropped AND a.attidentity='' ORDER BY a.attnum")
        .bind(schema)
        .bind(table)
        .fetch_all(pool)
        .await
        .map_err(db_error)?;
    let qualified_table = format!(
        "{}.{}",
        quote_identifier("postgresql", schema)?,
        quote_identifier("postgresql", table)?
    );
    let mut statements = Vec::new();
    for row in rows {
        let sequence = row_string(&row, 0)?;
        let column = row_string(&row, 1)?;
        statements.push(format!(
            "CREATE SEQUENCE {sequence};\nALTER SEQUENCE {sequence} OWNED BY {qualified_table}.{column}"
        ));
    }
    Ok(statements.join(";\n"))
}

pub(crate) async fn postgres_foreign_key_ddls(
    pool: &AnyPool,
    schema: &str,
    selected_tables: &[&str],
) -> Result<Vec<String>, (String, String)> {
    if selected_tables.is_empty() {
        return Ok(Vec::new());
    }
    let selected: std::collections::HashSet<&str> = selected_tables.iter().copied().collect();
    let table_rows = sqlx::query("SELECT CAST(c.relname AS TEXT), 'ALTER TABLE '||quote_ident(n.nspname)||'.'||quote_ident(c.relname)||' ADD CONSTRAINT '||quote_ident(con.conname)||' '||pg_get_constraintdef(con.oid,true) FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND con.contype='f' ORDER BY c.relname, con.conname")
        .bind(schema).fetch_all(pool).await.map_err(db_error)?;
    let mut statements = Vec::new();
    for row in &table_rows {
        let table = row_string(row, 0)?;
        if selected.contains(table.as_str()) {
            statements.push(row_string(row, 1)?);
        }
    }
    Ok(statements)
}

pub(crate) async fn postgres_sequence_sql(
    pool: &AnyPool,
    schema: &str,
    table: &str,
) -> Result<String, (String, String)> {
    let rows = sqlx::query(r#"SELECT CAST(a.attname AS TEXT), CAST(pg_get_serial_sequence(format('%I.%I',$1,$2),a.attname) AS TEXT)
        FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE n.nspname=$1 AND c.relname=$2 AND a.attnum>0 AND NOT a.attisdropped
          AND (a.attidentity<>'' OR pg_get_expr(d.adbin,d.adrelid) LIKE 'nextval(%')"#)
        .bind(schema).bind(table).fetch_all(pool).await.map_err(db_error)?;
    let qualified = format!(
        "{}.{}",
        quote_identifier("postgresql", schema)?,
        quote_identifier("postgresql", table)?
    );
    let mut output = String::new();
    for row in &rows {
        let column = row_string(row, 0)?;
        let sequence = row_string(row, 1)?;
        output.push_str(&format!(
            "SELECT setval({}::regclass, COALESCE(MAX({}), 1), COUNT(*) > 0) FROM {};\n",
            sql_literal("postgresql", &Value::String(sequence))?,
            quote_identifier("postgresql", &column)?,
            qualified
        ));
    }
    Ok(output)
}

pub(crate) async fn write_table_insert_sql<W: Write>(
    output: &mut W,
    pool: &DirectPool,
    kind: &str,
    schema: &str,
    table: &str,
    limit: u32,
) -> Result<(), (String, String)> {
    let qualified = if !schema.is_empty() && kind == "postgresql" {
        format!(
            "{}.{}",
            quote_identifier(kind, schema)?,
            quote_identifier(kind, table)?
        )
    } else {
        quote_identifier(kind, table)?
    };
    let sql = if limit == 0 {
        format!("SELECT * FROM {qualified}")
    } else {
        format!(
            "SELECT * FROM {qualified} LIMIT {}",
            limit.clamp(1, 100_000)
        )
    };
    let mut raw_columns = None;
    match pool {
        DirectPool::MySql(pool) => {
            let mut rows = sqlx::query(&sql).fetch(pool);
            while let Some(row) = rows.try_next().await.map_err(db_error)? {
                write_insert_row(
                    output,
                    kind,
                    &qualified,
                    &mut raw_columns,
                    mysql_row_json(&row)?,
                )?;
            }
        }
        DirectPool::Postgres(pool) => {
            let mut rows = sqlx::query(&sql).fetch(pool);
            while let Some(row) = rows.try_next().await.map_err(db_error)? {
                write_insert_row(
                    output,
                    kind,
                    &qualified,
                    &mut raw_columns,
                    postgres_row_json(&row)?,
                )?;
            }
        }
        DirectPool::Sqlite(pool) => {
            let mut rows = sqlx::query(&sql).fetch(pool);
            while let Some(row) = rows.try_next().await.map_err(db_error)? {
                write_insert_row(
                    output,
                    kind,
                    &qualified,
                    &mut raw_columns,
                    sqlite_row_json(&row)?,
                )?;
            }
        }
    }
    Ok(())
}

pub(crate) fn write_insert_row<W: Write>(
    output: &mut W,
    kind: &str,
    qualified: &str,
    raw_columns: &mut Option<Vec<String>>,
    row: Value,
) -> Result<(), (String, String)> {
    let object = row.as_object().ok_or_else(|| {
        (
            "export_failed".into(),
            "A database row could not be represented as an object".into(),
        )
    })?;
    let columns = raw_columns.get_or_insert_with(|| object.keys().cloned().collect());
    let quoted_columns = columns
        .iter()
        .map(|column| quote_identifier(kind, column))
        .collect::<Result<Vec<_>, _>>()?;
    let values = columns
        .iter()
        .map(|column| sql_literal(kind, object.get(column).unwrap_or(&Value::Null)))
        .collect::<Result<Vec<_>, _>>()?;
    write_export(
        output,
        &format!(
            "INSERT INTO {qualified} ({}) VALUES ({});\n",
            quoted_columns.join(", "),
            values.join(", ")
        ),
    )
}

pub(crate) fn sql_literal(kind: &str, value: &Value) -> Result<String, (String, String)> {
    match value {
        Value::Null => Ok("NULL".into()),
        Value::Bool(value) => Ok(if *value { "TRUE" } else { "FALSE" }.into()),
        Value::Number(value) => Ok(value.to_string()),
        Value::String(value) => Ok(format!("'{}'", value.replace('\'', "''"))),
        Value::Object(object) if binary_input(object).is_some() => {
            let bytes = BASE64
                .decode(binary_input(object).unwrap())
                .map_err(|e| ("export_failed".into(), e.to_string()))?;
            let hex = bytes
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            Ok(match kind {
                "mysql" => format!("0x{hex}"),
                "postgresql" => format!("decode('{hex}','hex')"),
                _ => format!("X'{hex}'"),
            })
        }
        other => Ok(format!("'{}'", other.to_string().replace('\'', "''"))),
    }
}
