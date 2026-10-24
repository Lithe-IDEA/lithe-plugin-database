//! SSH tunnels: a local port forwarded through the system `ssh` client,
//! ended with the method that opened it.

use crate::*;
use std::{
    process::{Child, Command, Stdio},
    time::Duration,
};

pub(crate) struct SshTunnel {
    child: Child,
}

/// Ends the `ssh` client once the method that opened the tunnel is done,
/// whether it finished, returned early with an error, or was cancelled by
/// dropping its future. Without this the client outlives the method and
/// keeps holding the local port.
impl Drop for SshTunnel {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub(crate) async fn open_ssh_tunnel(
    connection: &Connection,
) -> Result<Option<SshTunnel>, (String, String)> {
    if connection.ssh_host.is_empty() {
        return Ok(None);
    }
    if connection.ssh_username.is_empty() || connection.ssh_local_port == 0 {
        return Err((
            "invalid_ssh_tunnel".into(),
            "SSH host, username, and local port are required".into(),
        ));
    }
    let target_port = if connection.port > 0 {
        connection.port
    } else {
        match connection.kind.as_str() {
            "mysql" | "mariadb" => 3306,
            "sqlserver" => 1433,
            "mongodb" => 27017,
            "redis" => 6379,
            "nacos" => 8848,
            _ => 5432,
        }
    };
    let target = format!("{}:{target_port}", connection.host);
    let destination = format!("{}@{}", connection.ssh_username, connection.ssh_host);
    let mut command = Command::new("ssh");
    command
        .arg("-N")
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("ExitOnForwardFailure=yes")
        .arg("-L")
        .arg(format!("{}:{}", connection.ssh_local_port, target))
        .arg("-p")
        .arg(
            if connection.ssh_port == 0 {
                22
            } else {
                connection.ssh_port
            }
            .to_string(),
        );
    if !connection.ssh_key_path.is_empty() {
        command.arg("-i").arg(&connection.ssh_key_path);
    }
    if !connection.proxy_url.is_empty() {
        command
            .arg("-o")
            .arg(format!("ProxyCommand={}", connection.proxy_url));
    }
    let mut child = command
        .arg(destination)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| ("ssh_tunnel_failed".into(), error.to_string()))?;
    tokio::time::sleep(Duration::from_millis(180)).await;
    if let Some(status) = child
        .try_wait()
        .map_err(|error| ("ssh_tunnel_failed".into(), error.to_string()))?
    {
        return Err((
            "ssh_tunnel_failed".into(),
            format!("SSH tunnel exited with status {status}"),
        ));
    }
    Ok(Some(SshTunnel { child }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn dropping_a_tunnel_ends_its_ssh_client() {
        let child = Command::new("sleep").arg("30").spawn().unwrap();
        let pid = child.id().to_string();
        drop(SshTunnel { child });
        // The client was killed and reaped, so the PID no longer exists.
        let alive = Command::new("kill").args(["-0", &pid]).status().unwrap();
        assert!(!alive.success(), "ssh client {pid} outlived its tunnel");
    }
}
