mod commands;
mod manifest;
mod packagers;
mod adapter;

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
}

fn main() -> anyhow::Result<()> {
    let Cargo::CoreCode(args) = Cargo::parse();
    match args.command {
        Command::New { name, template } => commands::new::run(&name, &template),
        Command::Build { target, release } => commands::build::run(&target, release),
        Command::Check { target } => commands::check::run(&target),
    }
}
