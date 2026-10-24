//! Redis: key scans, typed values, string and hash editing, TTLs, and
//! flushing a database.

use crate::*;
use redis::AsyncCommands;
use reqwest::Url;
use serde_json::json;
use std::time::Duration;

pub(crate) async fn redis_method(method: &str, params: Params) -> DbResult {
    let tunnel = open_ssh_tunnel(&params.connection).await?;
    let connection = if tunnel.is_some() {
        params.connection.with_tunnel()?
    } else {
        params.connection.clone()
    };
    let result = redis_method_with_connection(method, &params, &connection).await;
    drop(tunnel);
    result
}

pub(crate) async fn redis_method_with_connection(
    method: &str,
    params: &Params,
    connection: &Connection,
) -> DbResult {
    let mut redis = redis_connect(connection).await?;
    let result = match method {
        "testConnection" => {
            let _: String = redis::cmd("PING")
                .query_async(&mut redis)
                .await
                .map_err(|e| redis_error(e, connection))?;
            Ok(json!({"connected": true}))
        }
        "redisScan" => redis_scan(&mut redis, params, connection).await,
        "redisGetKey" => redis_get_key(&mut redis, &params.key, connection).await,
        "redisSetString" => {
            ensure_specialized_write(connection, "Update Redis key", params.confirmed)?;
            redis_set_string(&mut redis, params, connection).await?;
            Ok(json!({}))
        }
        "redisReplaceHash" => {
            ensure_specialized_write(connection, "Update Redis hash", params.confirmed)?;
            redis_replace_hash(&mut redis, params, connection).await?;
            Ok(json!({}))
        }
        "redisDeleteKey" => {
            ensure_specialized_write(connection, "Delete Redis key", params.confirmed)?;
            require_nonempty(&params.key, "Redis key")?;
            let _: i64 = redis::cmd("DEL")
                .arg(&params.key)
                .query_async(&mut redis)
                .await
                .map_err(|e| redis_error(e, connection))?;
            Ok(json!({}))
        }
        "redisRenameKey" => {
            ensure_specialized_write(connection, "Rename Redis key", params.confirmed)?;
            require_nonempty(&params.key, "Redis key")?;
            require_nonempty(&params.new_key, "New Redis key")?;
            let _: String = redis::cmd("RENAME")
                .arg(&params.key)
                .arg(&params.new_key)
                .query_async(&mut redis)
                .await
                .map_err(|e| redis_error(e, connection))?;
            Ok(json!({}))
        }
        "redisSetTTL" => {
            ensure_specialized_write(connection, "Update Redis TTL", params.confirmed)?;
            require_nonempty(&params.key, "Redis key")?;
            let ttl = params
                .ttl
                .ok_or_else(|| ("invalid_params".into(), "Redis TTL is required".into()))?;
            if ttl < -1 {
                return Err((
                    "invalid_params".into(),
                    "Redis TTL must be -1 or a non-negative number of seconds".into(),
                ));
            }
            if ttl == -1 {
                let _: i64 = redis::cmd("PERSIST")
                    .arg(&params.key)
                    .query_async(&mut redis)
                    .await
                    .map_err(|e| redis_error(e, connection))?;
            } else {
                let _: i64 = redis::cmd("EXPIRE")
                    .arg(&params.key)
                    .arg(ttl)
                    .query_async(&mut redis)
                    .await
                    .map_err(|e| redis_error(e, connection))?;
            }
            Ok(json!({}))
        }
        "redisFlushDatabase" => {
            ensure_specialized_write(connection, "Clear Redis database", params.confirmed)?;
            let _: String = redis::cmd("FLUSHDB")
                .query_async(&mut redis)
                .await
                .map_err(|e| redis_error(e, connection))?;
            Ok(json!({}))
        }
        _ => Err((
            "unknown_method".into(),
            format!("Unknown Redis method: {method}"),
        )),
    };
    result
}

pub(crate) async fn redis_connect(
    connection: &Connection,
) -> Result<redis::aio::MultiplexedConnection, (String, String)> {
    let url = redis_url(connection)?;
    let client = redis::Client::open(url.as_str()).map_err(|e| redis_error(e, connection))?;
    let mut redis = tokio::time::timeout(
        Duration::from_secs(8),
        client.get_multiplexed_tokio_connection(),
    )
    .await
    .map_err(|_| {
        (
            "connection_failed".into(),
            "Redis connection timed out after 8 seconds".into(),
        )
    })?
    .map_err(|e| redis_error(e, connection))?;
    let db = redis_database(connection)?;
    if db != 0 {
        let _: String = redis::cmd("SELECT")
            .arg(db)
            .query_async(&mut redis)
            .await
            .map_err(|e| redis_error(e, connection))?;
    }
    Ok(redis)
}

pub(crate) fn redis_url(connection: &Connection) -> Result<Url, (String, String)> {
    let host = connection.host.trim();
    if host.is_empty() {
        return Err(("invalid_connection".into(), "Redis host is required".into()));
    }
    if !connection.proxy_url.is_empty() && connection.ssh_host.is_empty() {
        return Err((
            "unsupported_proxy".into(),
            "A proxy URL requires an SSH tunnel in the current Redis driver".into(),
        ));
    }
    let scheme = if connection.ssl { "rediss" } else { "redis" };
    let port = if connection.port == 0 {
        6379
    } else {
        connection.port
    };
    let db = redis_database(connection)?;
    let credential = if connection.password.is_empty() {
        String::new()
    } else if connection.username.is_empty() {
        format!(":{}@", urlencoding::encode(&connection.password))
    } else {
        format!(
            "{}:{}@",
            urlencoding::encode(&connection.username),
            urlencoding::encode(&connection.password)
        )
    };
    Url::parse(&format!("{scheme}://{credential}{host}:{port}/{db}")).map_err(|e| {
        (
            "invalid_connection".into(),
            format!("Redis address is invalid: {e}"),
        )
    })
}

pub(crate) fn redis_database(connection: &Connection) -> Result<u32, (String, String)> {
    if connection.database.trim().is_empty() {
        return Ok(0);
    }
    connection.database.trim().parse::<u32>().map_err(|_| {
        (
            "invalid_connection".into(),
            "Redis database index must be a non-negative integer".into(),
        )
    })
}

pub(crate) async fn redis_scan(
    redis: &mut redis::aio::MultiplexedConnection,
    params: &Params,
    connection: &Connection,
) -> DbResult {
    let cursor = if params.cursor.trim().is_empty() {
        0
    } else {
        params.cursor.parse::<u64>().map_err(|_| {
            (
                "invalid_params".into(),
                "Redis scan cursor is invalid".into(),
            )
        })?
    };
    let pattern = if params.pattern.trim().is_empty() {
        "*"
    } else {
        params.pattern.trim()
    };
    let count = params.count.clamp(1, 250);
    let (next_cursor, keys): (u64, Vec<String>) = redis::cmd("SCAN")
        .arg(cursor)
        .arg("MATCH")
        .arg(pattern)
        .arg("COUNT")
        .arg(count)
        .query_async(redis)
        .await
        .map_err(|e| redis_error(e, connection))?;
    let (replies, size_enabled) = match redis_scan_metadata(redis, &keys, params.include_size).await
    {
        Ok(replies) => (replies, params.include_size),
        Err(error) if params.include_size && redis_memory_usage_unsupported(&error) => {
            let replies = redis_scan_metadata(redis, &keys, false)
                .await
                .map_err(|e| redis_error(e, connection))?;
            (replies, false)
        }
        Err(error) => return Err(redis_error(error, connection)),
    };
    let stride = if size_enabled { 3 } else { 2 };
    if replies.len() != keys.len() * stride {
        return Err((
            "redis_error".into(),
            "Redis returned an incomplete scan metadata response".into(),
        ));
    }
    let mut summaries = Vec::with_capacity(keys.len());
    for (index, key) in keys.into_iter().enumerate() {
        let offset = index * stride;
        let kind: String = redis::from_redis_value(&replies[offset]).map_err(|e| {
            (
                "redis_error".into(),
                format!("Redis returned an invalid key type: {e}"),
            )
        })?;
        if kind == "none" {
            continue;
        }
        let ttl: i64 = redis::from_redis_value(&replies[offset + 1]).map_err(|e| {
            (
                "redis_error".into(),
                format!("Redis returned an invalid key TTL: {e}"),
            )
        })?;
        let size = if size_enabled {
            redis::from_redis_value::<Option<i64>>(&replies[offset + 2])
                .unwrap_or(None)
                .unwrap_or(-1)
        } else {
            -1
        };
        summaries.push(json!({"key": key, "type": kind, "ttl": ttl, "size": size}));
    }
    Ok(json!({"keys": summaries, "nextCursor": next_cursor.to_string()}))
}

pub(crate) async fn redis_scan_metadata(
    redis: &mut redis::aio::MultiplexedConnection,
    keys: &[String],
    include_size: bool,
) -> redis::RedisResult<Vec<redis::Value>> {
    let mut pipeline = redis::pipe();
    for key in keys {
        pipeline.cmd("TYPE").arg(key);
        pipeline.cmd("TTL").arg(key);
        if include_size {
            pipeline.cmd("MEMORY").arg("USAGE").arg(key);
        }
    }
    pipeline.query_async(redis).await
}

pub(crate) fn redis_memory_usage_unsupported(error: &redis::RedisError) -> bool {
    let message = error.to_string().to_ascii_lowercase();
    message.contains("unknown command")
        || message.contains("unknown subcommand")
        || message.contains("unsupported")
}

pub(crate) async fn redis_key_size(
    redis: &mut redis::aio::MultiplexedConnection,
    key: &str,
    kind: &str,
    connection: &Connection,
) -> Result<i64, (String, String)> {
    let command = match kind {
        "string" => "STRLEN",
        "hash" => "HLEN",
        "list" => "LLEN",
        "set" => "SCARD",
        "zset" => "ZCARD",
        "stream" => "XLEN",
        _ => return Ok(0),
    };
    redis::cmd(command)
        .arg(key)
        .query_async(redis)
        .await
        .map_err(|e| redis_error(e, connection))
}

pub(crate) async fn redis_get_key(
    redis: &mut redis::aio::MultiplexedConnection,
    key: &str,
    connection: &Connection,
) -> DbResult {
    require_nonempty(key, "Redis key")?;
    let kind: String = redis::cmd("TYPE")
        .arg(key)
        .query_async(redis)
        .await
        .map_err(|e| redis_error(e, connection))?;
    if kind == "none" {
        return Err(("not_found".into(), "The Redis key no longer exists".into()));
    }
    let ttl: i64 = redis::cmd("TTL")
        .arg(key)
        .query_async(redis)
        .await
        .map_err(|e| redis_error(e, connection))?;
    let size = redis_key_size(redis, key, &kind, connection).await?;
    let string_value = if kind == "string" {
        Some(
            redis::cmd("GET")
                .arg(key)
                .query_async::<Option<String>>(redis)
                .await
                .map_err(|e| redis_error(e, connection))?
                .unwrap_or_default(),
        )
    } else {
        None
    };
    let hash_entries = if kind == "hash" {
        let pairs: Vec<(String, String)> = redis
            .hgetall(key)
            .await
            .map_err(|e| redis_error(e, connection))?;
        pairs
            .into_iter()
            .map(|(field, value)| json!({"field": field, "value": value}))
            .collect()
    } else {
        Vec::new()
    };
    Ok(
        json!({"key": key, "type": kind, "ttl": ttl, "size": size, "stringValue": string_value, "hashEntries": hash_entries}),
    )
}

pub(crate) async fn redis_set_string(
    redis: &mut redis::aio::MultiplexedConnection,
    params: &Params,
    connection: &Connection,
) -> Result<(), (String, String)> {
    require_nonempty(&params.key, "Redis key")?;
    let prior_ttl: i64 = redis::cmd("PTTL")
        .arg(&params.key)
        .query_async(redis)
        .await
        .map_err(|e| redis_error(e, connection))?;
    let _: String = redis::cmd("SET")
        .arg(&params.key)
        .arg(&params.value)
        .query_async(redis)
        .await
        .map_err(|e| redis_error(e, connection))?;
    redis_apply_ttl(redis, &params.key, params.ttl, prior_ttl, connection).await
}

pub(crate) async fn redis_replace_hash(
    redis: &mut redis::aio::MultiplexedConnection,
    params: &Params,
    connection: &Connection,
) -> Result<(), (String, String)> {
    require_nonempty(&params.key, "Redis key")?;
    if params.entries.iter().any(|entry| entry.field.is_empty()) {
        return Err((
            "invalid_params".into(),
            "Redis hash fields cannot be empty".into(),
        ));
    }
    let prior_ttl: i64 = redis::cmd("PTTL")
        .arg(&params.key)
        .query_async(redis)
        .await
        .map_err(|e| redis_error(e, connection))?;
    let _: i64 = redis::cmd("DEL")
        .arg(&params.key)
        .query_async(redis)
        .await
        .map_err(|e| redis_error(e, connection))?;
    if params.entries.is_empty() {
        return Ok(());
    }
    let mut command = redis::cmd("HSET");
    command.arg(&params.key);
    for entry in &params.entries {
        command.arg(&entry.field).arg(&entry.value);
    }
    let _: i64 = command
        .query_async(redis)
        .await
        .map_err(|e| redis_error(e, connection))?;
    redis_apply_ttl(redis, &params.key, None, prior_ttl, connection).await
}

pub(crate) async fn redis_apply_ttl(
    redis: &mut redis::aio::MultiplexedConnection,
    key: &str,
    requested_ttl: Option<i64>,
    prior_ttl: i64,
    connection: &Connection,
) -> Result<(), (String, String)> {
    match requested_ttl {
        Some(-1) => {
            let _: i64 = redis::cmd("PERSIST")
                .arg(key)
                .query_async(redis)
                .await
                .map_err(|e| redis_error(e, connection))?;
        }
        Some(ttl) if ttl >= 0 => {
            let _: i64 = redis::cmd("EXPIRE")
                .arg(key)
                .arg(ttl)
                .query_async(redis)
                .await
                .map_err(|e| redis_error(e, connection))?;
        }
        Some(_) => {
            return Err((
                "invalid_params".into(),
                "Redis TTL must be -1 or a non-negative number of seconds".into(),
            ))
        }
        None if prior_ttl >= 0 => {
            let _: i64 = redis::cmd("PEXPIRE")
                .arg(key)
                .arg(prior_ttl)
                .query_async(redis)
                .await
                .map_err(|e| redis_error(e, connection))?;
        }
        None => {}
    }
    Ok(())
}

pub(crate) fn redis_error(error: redis::RedisError, connection: &Connection) -> (String, String) {
    (
        "redis_error".into(),
        redact(error.to_string(), &connection.password),
    )
}
