//! Nacos: configuration management and service discovery over its HTTP
//! API.

use crate::*;
use reqwest::{Client as HttpClient, Method as HttpMethod, Url};
use serde_json::{json, Value};
use std::time::Duration;

pub(crate) struct NacosClient {
    http: HttpClient,
    base: Url,
    token: Option<String>,
}

pub(crate) async fn nacos_method(method: &str, params: Params) -> DbResult {
    let tunnel = open_ssh_tunnel(&params.connection).await?;
    let connection = if tunnel.is_some() {
        params.connection.with_tunnel()?
    } else {
        params.connection.clone()
    };
    let client = nacos_connect(&connection).await;
    let result = match client {
        Ok(mut client) => nacos_method_with_client(method, &params, &connection, &mut client).await,
        Err(error) => Err(error),
    };
    drop(tunnel);
    result
}

pub(crate) async fn nacos_method_with_client(
    method: &str,
    params: &Params,
    connection: &Connection,
    client: &mut NacosClient,
) -> DbResult {
    match method {
        "testConnection" => {
            let _ = nacos_list_configs(client, connection, "", "", 1, 1).await?;
            Ok(json!({"connected": true}))
        }
        "nacosListConfigs" => {
            nacos_list_configs(
                client,
                connection,
                &params.data_id,
                &params.group,
                normalized_page(params.page),
                normalized_page_size(params.page_size),
            )
            .await
        }
        "nacosGetConfig" => {
            nacos_get_config(client, connection, &params.data_id, &params.group).await
        }
        "nacosPublishConfig" => {
            ensure_specialized_write(connection, "Publish Nacos configuration", params.confirmed)?;
            nacos_publish_config(client, connection, params).await?;
            Ok(json!({}))
        }
        "nacosDeleteConfig" => {
            ensure_specialized_write(connection, "Delete Nacos configuration", params.confirmed)?;
            nacos_delete_config(client, connection, params).await?;
            Ok(json!({}))
        }
        "nacosListServices" => {
            nacos_list_services(
                client,
                connection,
                &params.service_name,
                &params.group,
                normalized_page(params.page),
                normalized_page_size(params.page_size),
            )
            .await
        }
        "nacosListInstances" => {
            nacos_list_instances(client, connection, &params.service_name, &params.group).await
        }
        _ => Err((
            "unknown_method".into(),
            format!("Unknown Nacos method: {method}"),
        )),
    }
}

pub(crate) async fn nacos_connect(
    connection: &Connection,
) -> Result<NacosClient, (String, String)> {
    let base = nacos_base_url(connection)?;
    let http = HttpClient::builder()
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|e| ("connection_failed".into(), e.to_string()))?;
    let mut client = NacosClient {
        http,
        base,
        token: None,
    };
    if !connection.username.trim().is_empty() {
        client.token = Some(nacos_login(&client, connection).await?);
    }
    Ok(client)
}

pub(crate) fn nacos_base_url(connection: &Connection) -> Result<Url, (String, String)> {
    let host = connection.host.trim();
    if host.is_empty() {
        return Err((
            "invalid_connection".into(),
            "Nacos server address is required".into(),
        ));
    }
    if !connection.proxy_url.is_empty() && connection.ssh_host.is_empty() {
        return Err((
            "unsupported_proxy".into(),
            "A proxy URL requires an SSH tunnel in the current Nacos driver".into(),
        ));
    }
    let scheme = if connection.ssl { "https" } else { "http" };
    let port = if connection.port == 0 {
        8848
    } else {
        connection.port
    };
    let mut url = if host.starts_with("http://") || host.starts_with("https://") {
        Url::parse(host).map_err(|e| {
            (
                "invalid_connection".into(),
                format!("Nacos server address is invalid: {e}"),
            )
        })?
    } else {
        Url::parse(&format!("{scheme}://{host}:{port}")).map_err(|e| {
            (
                "invalid_connection".into(),
                format!("Nacos server address is invalid: {e}"),
            )
        })?
    };
    if url.port().is_none() {
        url.set_port(Some(port))
            .map_err(|_| ("invalid_connection".into(), "Nacos port is invalid".into()))?;
    }
    let context = if connection.path.trim().is_empty() {
        "/nacos"
    } else {
        connection.path.trim()
    };
    let context = format!("/{}", context.trim_matches('/'));
    url.set_path(&format!("{context}/"));
    url.set_query(None);
    Ok(url)
}

pub(crate) async fn nacos_login(
    client: &NacosClient,
    connection: &Connection,
) -> Result<String, (String, String)> {
    let form = vec![
        ("username".to_string(), connection.username.clone()),
        ("password".to_string(), connection.password.clone()),
    ];
    let mut errors = Vec::new();
    for path in ["/v1/auth/login", "/v1/auth/users/login"] {
        let response = nacos_request_raw(
            &client.http,
            &client.base,
            HttpMethod::POST,
            path,
            &[],
            Some(&form),
        )
        .await;
        match response {
            Ok(response) if response.status().is_success() => {
                let value: Value = response.json().await.map_err(|e| {
                    (
                        "nacos_auth_failed".into(),
                        format!("Nacos login response is invalid: {e}"),
                    )
                })?;
                if let Some(token) = value
                    .get("accessToken")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                {
                    return Ok(token.to_string());
                }
                errors.push("Nacos login response did not contain an access token".to_string());
            }
            Ok(response) => errors.push(nacos_http_error(response, connection).await.1),
            Err(error) => errors.push(error.1),
        }
    }
    Err(("nacos_auth_failed".into(), errors.join("; ")))
}

pub(crate) async fn nacos_list_configs(
    client: &NacosClient,
    connection: &Connection,
    data_id: &str,
    group: &str,
    page: u32,
    page_size: u32,
) -> DbResult {
    let response = nacos_request(
        client,
        HttpMethod::GET,
        "/v1/cs/configs",
        &[
            ("search".to_string(), "blur".to_string()),
            ("dataId".to_string(), data_id.to_string()),
            ("group".to_string(), group.to_string()),
            ("tenant".to_string(), connection.database.clone()),
            ("pageNo".to_string(), page.to_string()),
            ("pageSize".to_string(), page_size.to_string()),
        ],
        None,
    )
    .await?;
    let value = nacos_json(response, connection).await?;
    let items = value.get("pageItems").or_else(|| value.get("items")).and_then(Value::as_array).cloned().unwrap_or_default().into_iter().map(|item| json!({
        "dataId": item.get("dataId").and_then(Value::as_str).unwrap_or_default(),
        "group": item.get("group").or_else(|| item.get("groupName")).and_then(Value::as_str).unwrap_or("DEFAULT_GROUP"),
        "namespace": item.get("tenant").or_else(|| item.get("namespace")).or_else(|| item.get("namespaceId")).and_then(Value::as_str).unwrap_or(&connection.database),
        "type": item.get("type").or_else(|| item.get("configType")).and_then(Value::as_str),
        "md5": item.get("md5").and_then(Value::as_str)
    })).collect::<Vec<_>>();
    let total_count = value
        .get("totalCount")
        .or_else(|| value.get("count"))
        .and_then(Value::as_i64)
        .unwrap_or(items.len() as i64);
    Ok(json!({"items": items, "totalCount": total_count.max(0)}))
}

pub(crate) async fn nacos_get_config(
    client: &NacosClient,
    connection: &Connection,
    data_id: &str,
    group: &str,
) -> DbResult {
    require_nonempty(data_id, "Nacos data ID")?;
    let group = nonempty_or(group, "DEFAULT_GROUP");
    let response = nacos_request(
        client,
        HttpMethod::GET,
        "/v1/cs/configs",
        &[
            ("dataId".to_string(), data_id.to_string()),
            ("group".to_string(), group.to_string()),
            ("tenant".to_string(), connection.database.clone()),
            ("show".to_string(), "all".to_string()),
        ],
        None,
    )
    .await?;
    if !response.status().is_success() {
        return Err(nacos_http_error(response, connection).await);
    }
    let text = response.text().await.map_err(|e| {
        (
            "nacos_error".into(),
            format!("Unable to read Nacos configuration: {e}"),
        )
    })?;
    let parsed = serde_json::from_str::<Value>(&text).ok();
    let content = parsed
        .as_ref()
        .and_then(|value| value.get("content"))
        .and_then(Value::as_str)
        .unwrap_or(&text)
        .to_string();
    Ok(json!({
        "dataId": parsed.as_ref().and_then(|value| value.get("dataId")).and_then(Value::as_str).unwrap_or(data_id),
        "group": parsed.as_ref().and_then(|value| value.get("group")).or_else(|| parsed.as_ref().and_then(|value| value.get("groupName"))).and_then(Value::as_str).unwrap_or(group),
        "namespace": parsed.as_ref().and_then(|value| value.get("tenant")).or_else(|| parsed.as_ref().and_then(|value| value.get("namespace"))).and_then(Value::as_str).unwrap_or(&connection.database),
        "content": content,
        "type": parsed.as_ref().and_then(|value| value.get("type")).or_else(|| parsed.as_ref().and_then(|value| value.get("configType"))).and_then(Value::as_str),
        "md5": parsed.as_ref().and_then(|value| value.get("md5")).and_then(Value::as_str)
    }))
}

pub(crate) async fn nacos_publish_config(
    client: &NacosClient,
    connection: &Connection,
    params: &Params,
) -> Result<(), (String, String)> {
    require_nonempty(&params.data_id, "Nacos data ID")?;
    let group = nonempty_or(&params.group, "DEFAULT_GROUP");
    let mut form = vec![
        ("dataId".to_string(), params.data_id.clone()),
        ("group".to_string(), group.to_string()),
        ("tenant".to_string(), connection.database.clone()),
        ("content".to_string(), params.content.clone()),
    ];
    if !params.r#type.trim().is_empty() {
        form.push(("type".to_string(), params.r#type.clone()));
    }
    let response =
        nacos_request(client, HttpMethod::POST, "/v1/cs/configs", &[], Some(&form)).await?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(nacos_http_error(response, connection).await)
    }
}

pub(crate) async fn nacos_delete_config(
    client: &NacosClient,
    connection: &Connection,
    params: &Params,
) -> Result<(), (String, String)> {
    require_nonempty(&params.data_id, "Nacos data ID")?;
    let group = nonempty_or(&params.group, "DEFAULT_GROUP");
    let response = nacos_request(
        client,
        HttpMethod::DELETE,
        "/v1/cs/configs",
        &[
            ("dataId".to_string(), params.data_id.clone()),
            ("group".to_string(), group.to_string()),
            ("tenant".to_string(), connection.database.clone()),
        ],
        None,
    )
    .await?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(nacos_http_error(response, connection).await)
    }
}

pub(crate) async fn nacos_list_services(
    client: &NacosClient,
    connection: &Connection,
    service_name: &str,
    group: &str,
    page: u32,
    page_size: u32,
) -> DbResult {
    let mut query = vec![
        ("namespaceId".to_string(), connection.database.clone()),
        ("pageNo".to_string(), page.to_string()),
        ("pageSize".to_string(), page_size.to_string()),
    ];
    if !group.trim().is_empty() {
        query.push(("groupNameParam".to_string(), group.to_string()));
    }
    if !service_name.trim().is_empty() {
        query.push(("serviceNameParam".to_string(), service_name.to_string()));
    }
    let response = nacos_request(
        client,
        HttpMethod::GET,
        "/v1/ns/catalog/services",
        &query,
        None,
    )
    .await?;
    let value = nacos_json(response, connection).await?;
    let items = value.get("serviceList").or_else(|| value.get("doms")).and_then(Value::as_array).cloned().unwrap_or_default().into_iter().map(|item| {
        let raw_name = item.get("name").or_else(|| item.get("serviceName")).and_then(Value::as_str).unwrap_or_default();
        let group_name = item.get("groupName").and_then(Value::as_str).unwrap_or_else(|| raw_name.split("@@").next().filter(|_| raw_name.contains("@@")).unwrap_or("DEFAULT_GROUP"));
        let name = raw_name.strip_prefix(&format!("{group_name}@@")).unwrap_or(raw_name);
        json!({"name": name, "group": group_name, "clusterCount": item.get("clusterCount").and_then(Value::as_i64).unwrap_or(0).max(0)})
    }).collect::<Vec<_>>();
    let total_count = value
        .get("count")
        .or_else(|| value.get("totalCount"))
        .and_then(Value::as_i64)
        .unwrap_or(items.len() as i64);
    Ok(json!({"items": items, "totalCount": total_count.max(0)}))
}

pub(crate) async fn nacos_list_instances(
    client: &NacosClient,
    connection: &Connection,
    service_name: &str,
    group: &str,
) -> DbResult {
    require_nonempty(service_name, "Nacos service name")?;
    let mut query = vec![
        ("serviceName".to_string(), service_name.to_string()),
        ("namespaceId".to_string(), connection.database.clone()),
    ];
    if !group.trim().is_empty() {
        query.push(("groupName".to_string(), group.to_string()));
    }
    let response = nacos_request(
        client,
        HttpMethod::GET,
        "/v1/ns/instance/list",
        &query,
        None,
    )
    .await?;
    let value = nacos_json(response, connection).await?;
    let hosts = value
        .get("hosts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(Value::Array(
        hosts
            .into_iter()
            .map(|host| {
                json!({
                    "ip": host.get("ip").and_then(Value::as_str).unwrap_or_default(),
                    "port": host.get("port").and_then(Value::as_i64).unwrap_or(0).max(0),
                    "healthy": host.get("healthy").and_then(Value::as_bool).unwrap_or(false),
                    "enabled": host.get("enabled").and_then(Value::as_bool).unwrap_or(true),
                    "ephemeral": host.get("ephemeral").and_then(Value::as_bool).unwrap_or(true),
                    "clusterName": host.get("clusterName").and_then(Value::as_str)
                })
            })
            .collect(),
    ))
}

pub(crate) async fn nacos_request(
    client: &NacosClient,
    method: HttpMethod,
    path: &str,
    query: &[(String, String)],
    form: Option<&[(String, String)]>,
) -> Result<reqwest::Response, (String, String)> {
    let mut query = query.to_vec();
    if let Some(token) = &client.token {
        query.push(("accessToken".to_string(), token.clone()));
    }
    nacos_request_raw(&client.http, &client.base, method, path, &query, form).await
}

pub(crate) async fn nacos_request_raw(
    http: &HttpClient,
    base: &Url,
    method: HttpMethod,
    path: &str,
    query: &[(String, String)],
    form: Option<&[(String, String)]>,
) -> Result<reqwest::Response, (String, String)> {
    let endpoint = base.join(path.trim_start_matches('/')).map_err(|e| {
        (
            "invalid_connection".into(),
            format!("Nacos endpoint is invalid: {e}"),
        )
    })?;
    let mut request = http.request(method, endpoint).query(query);
    if let Some(form) = form {
        request = request.form(form);
    }
    request
        .send()
        .await
        .map_err(|e| ("nacos_error".into(), format!("Nacos request failed: {e}")))
}

pub(crate) async fn nacos_json(
    response: reqwest::Response,
    connection: &Connection,
) -> Result<Value, (String, String)> {
    if !response.status().is_success() {
        return Err(nacos_http_error(response, connection).await);
    }
    response.json().await.map_err(|e| {
        (
            "nacos_error".into(),
            format!("Nacos response is not valid JSON: {e}"),
        )
    })
}

pub(crate) async fn nacos_http_error(
    response: reqwest::Response,
    connection: &Connection,
) -> (String, String) {
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    (
        "nacos_error".into(),
        redact(
            format!("Nacos server returned {status}: {}", text.trim()),
            &connection.password,
        ),
    )
}
