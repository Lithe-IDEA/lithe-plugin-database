//! The backend of the Lithe database plugin: the `backend` process Lithe
//! starts when the database window first calls a function, with
//! `--state ${stateDir}`. It keeps saved connections in that directory and
//! their passwords in the host's credential store, and runs every database
//! method through the engine.

mod dbx;
mod service;
mod store;

use lithe_plugin_sdk::Backend;
use std::path::PathBuf;

fn main() {
    let state = match state_directory() {
        Ok(state) => state,
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(2);
        }
    };
    sqlx_drivers();
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name("lithe-database")
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("The async runtime could not start: {error}");
            std::process::exit(1);
        }
    };
    let mut backend = Backend::new("lithe-database").version(env!("CARGO_PKG_VERSION"));
    service::Service::new(store::Store::new(state), runtime).install(&mut backend);
    std::process::exit(backend.listen());
}

fn state_directory() -> Result<PathBuf, String> {
    let mut arguments = std::env::args().skip(1);
    match (arguments.next().as_deref(), arguments.next()) {
        (Some("--state"), Some(path)) if arguments.next().is_none() => Ok(PathBuf::from(path)),
        _ => Err("usage: lithe-database-backend --state <directory>".into()),
    }
}

/// The engine's SQL methods use sqlx's `Any` driver, which needs the
/// concrete drivers registered once per process.
fn sqlx_drivers() {
    lithe_database_engine::install_drivers();
}
