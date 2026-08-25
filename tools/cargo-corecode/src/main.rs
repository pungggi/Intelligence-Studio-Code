mod commands;
mod manifest;
mod packagers;
mod adapter;
mod signing;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "cargo", bin_name = "cargo")]
enum Cargo {
    #[command(name = "corecode")]
    CoreCode(CoreCodeArgs),
}

#[derive(Parser)]
#[command(version, about = "Build toolchain for CoreCode WASM extensions")]
struct CoreCodeArgs {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Scaffold a new extension project
    New {
        name: String,
        /// Template: language-provider, format-provider, grammar, webview
        #[arg(long, default_value = "language-provider")]
        template: String,
    },
    /// Build extension packages
    Build {
        /// Target: corecode, zed, vscode, or all
        #[arg(long, default_value = "corecode")]
        target: String,
        #[arg(long)]
        release: bool,
    },
    /// Check WIT API compatibility for each target
    Check {
        #[arg(long, default_value = "all")]
        target: String,
    },
    /// Build a release .ccext and publish it to the CoreCode marketplace
    Publish {
        /// API token (defaults to $CORECODE_TOKEN)
        #[arg(long)]
        token: Option<String>,
        /// Registry base URL (defaults to $CORECODE_REGISTRY,
        /// then https://marketplace.corecode.dev)
        #[arg(long)]
        registry: Option<String>,
        /// ed25519 signing key: path to a key file or the base64 seed
        /// (defaults to $CORECODE_SIGNING_KEY; unsigned when unset)
        #[arg(long)]
        signing_key: Option<String>,
        /// Build and validate the package without uploading
        #[arg(long)]
        dry_run: bool,
    },
    /// Generate an ed25519 signing keypair for authenticated publishing
    Keygen {
        /// Output directory (defaults to the current directory)
        #[arg(long)]
        out: Option<String>,
        /// Overwrite existing key files
        #[arg(long)]
        force: bool,
    },
}

fn main() -> anyhow::Result<()> {
    let Cargo::CoreCode(args) = Cargo::parse();
    match args.command {
        Command::New { name, template } => commands::new::run(&name, &template),
        Command::Build { target, release } => commands::build::run(&target, release),
        Command::Check { target } => commands::check::run(&target),
        Command::Publish {
            token,
            registry,
            signing_key,
            dry_run,
        } => commands::publish::run(
            token.as_deref(),
            registry.as_deref(),
            signing_key.as_deref(),
            dry_run,
        ),
        Command::Keygen { out, force } => commands::keygen::run(out.as_deref(), force),
    }
}
