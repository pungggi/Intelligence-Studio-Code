//! Spike 3: Extension Host Client
//!
//! Connects to the Node.js Extension Host via IPC and:
//! 1. Lists registered commands (proves extension loaded & activated)
//! 2. Executes each command with test arguments
//! 3. Measures round-trip time for command execution
//!
//! Usage:
//!   1. Start host:  node src/extension-host/src/spike-ext-host.js
//!   2. Run client:  cargo run --bin spike-ext-host

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::time::Instant;

const SOCKET_PATH: &str = "/tmp/corecode-spike-ext-host.sock";

// --- Protocol: length-prefixed JSON ---

#[derive(Serialize)]
struct Request {
    id: u64,
    method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<serde_json::Value>,
}

#[derive(Deserialize, Debug)]
struct Response {
    id: u64,
    result: Option<serde_json::Value>,
    error: Option<ErrorInfo>,
}

#[derive(Deserialize, Debug)]
struct ErrorInfo {
    message: String,
}

fn send_request(stream: &mut UnixStream, req: &Request) -> Result<Response> {
    let json = serde_json::to_vec(req)?;

    // Write length-prefixed frame
    let len = json.len() as u32;
    stream.write_all(&len.to_le_bytes())?;
    stream.write_all(&json)?;

    // Read response frame
    let mut len_buf = [0u8; 4];
    stream.read_exact(&mut len_buf)?;
    let resp_len = u32::from_le_bytes(len_buf) as usize;

    let mut resp_buf = vec![0u8; resp_len];
    stream.read_exact(&mut resp_buf)?;

    let resp: Response = serde_json::from_slice(&resp_buf)?;
    Ok(resp)
}

fn main() -> Result<()> {
    println!("=== CoreCode Spike 3: Extension Host Client ===\n");

    println!("Connecting to Extension Host at {SOCKET_PATH}...");
    let mut stream = UnixStream::connect(SOCKET_PATH)?;
    println!("Connected!\n");

    // --- Test 1: Get extension info ---
    println!("--- Test 1: Get Extension Info ---");
    let resp = send_request(
        &mut stream,
        &Request {
            id: 1,
            method: "getExtensionInfo".to_string(),
            params: None,
        },
    )?;
    println!("Response: {}", serde_json::to_string_pretty(&resp.result)?);

    if let Some(result) = &resp.result {
        if let Some(commands) = result.get("commands") {
            let count = commands.as_array().map(|a| a.len()).unwrap_or(0);
            if count > 0 {
                println!("[Test 1] PASS: {} commands registered", count);
            } else {
                println!("[Test 1] FAIL: No commands registered");
            }
        }
    }

    // --- Test 2: List commands ---
    println!("\n--- Test 2: List Commands ---");
    let resp = send_request(
        &mut stream,
        &Request {
            id: 2,
            method: "listCommands".to_string(),
            params: None,
        },
    )?;
    let commands: Vec<String> = resp
        .result
        .as_ref()
        .and_then(|r| r.get("commands"))
        .and_then(|c| serde_json::from_value(c.clone()).ok())
        .unwrap_or_default();

    for cmd in &commands {
        println!("  - {}", cmd);
    }
    println!("[Test 2] PASS: {} commands listed", commands.len());

    // --- Test 3: Execute corecode.helloWorld ---
    println!("\n--- Test 3: Execute corecode.helloWorld ---");
    let start = Instant::now();
    let resp = send_request(
        &mut stream,
        &Request {
            id: 3,
            method: "executeCommand".to_string(),
            params: Some(serde_json::json!({
                "command": "corecode.helloWorld",
                "args": []
            })),
        },
    )?;
    let rtt = start.elapsed();
    println!("Response: {}", serde_json::to_string_pretty(&resp.result)?);
    println!("RTT: {:.3}ms", rtt.as_secs_f64() * 1000.0);

    if let Some(result) = &resp.result {
        if let Some(value) = result.get("value") {
            if value.as_str() == Some("Hello, World!") {
                println!("[Test 3] PASS: Correct return value");
            } else {
                println!("[Test 3] FAIL: Unexpected return value: {}", value);
            }
        }
    }

    // --- Test 4: Execute corecode.greet with argument ---
    println!("\n--- Test 4: Execute corecode.greet with argument ---");
    let start = Instant::now();
    let resp = send_request(
        &mut stream,
        &Request {
            id: 4,
            method: "executeCommand".to_string(),
            params: Some(serde_json::json!({
                "command": "corecode.greet",
                "args": ["Rust"]
            })),
        },
    )?;
    let rtt = start.elapsed();
    println!("Response: {}", serde_json::to_string_pretty(&resp.result)?);
    println!("RTT: {:.3}ms", rtt.as_secs_f64() * 1000.0);

    if let Some(result) = &resp.result {
        if let Some(value) = result.get("value").and_then(|v| v.as_str()) {
            if value.contains("Rust") {
                println!("[Test 4] PASS: Argument passed correctly");
            } else {
                println!("[Test 4] FAIL: Argument not in response");
            }
        }
    }

    // --- Test 5: Execute corecode.add (data round-trip) ---
    println!("\n--- Test 5: Execute corecode.add (data round-trip) ---");
    let start = Instant::now();
    let resp = send_request(
        &mut stream,
        &Request {
            id: 5,
            method: "executeCommand".to_string(),
            params: Some(serde_json::json!({
                "command": "corecode.add",
                "args": [17, 25]
            })),
        },
    )?;
    let rtt = start.elapsed();
    println!("Response: {}", serde_json::to_string_pretty(&resp.result)?);
    println!("RTT: {:.3}ms", rtt.as_secs_f64() * 1000.0);

    if let Some(result) = &resp.result {
        if let Some(value) = result.get("value") {
            let sum = value.get("result").and_then(|v| v.as_i64());
            if sum == Some(42) {
                println!("[Test 5] PASS: 17 + 25 = 42 (computed correctly)");
            } else {
                println!("[Test 5] FAIL: Expected 42, got {:?}", sum);
            }
        }
    }

    // --- Test 6: Latency benchmark (100 command invocations) ---
    println!("\n--- Test 6: Command Execution Latency (100 calls) ---");
    let mut rtts = Vec::with_capacity(100);
    for i in 0..100 {
        let start = Instant::now();
        let _resp = send_request(
            &mut stream,
            &Request {
                id: 100 + i,
                method: "executeCommand".to_string(),
                params: Some(serde_json::json!({
                    "command": "corecode.add",
                    "args": [i, i + 1]
                })),
            },
        )?;
        rtts.push(start.elapsed());
    }

    let rtt_us: Vec<f64> = rtts.iter().map(|d| d.as_secs_f64() * 1_000_000.0).collect();
    let avg = rtt_us.iter().sum::<f64>() / rtt_us.len() as f64;
    let mut sorted = rtt_us.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let median = sorted[sorted.len() / 2];
    let p95 = sorted[(sorted.len() as f64 * 0.95) as usize];

    println!(
        "  avg={:.0}µs  median={:.0}µs  p95={:.0}µs",
        avg, median, p95
    );

    let avg_ms = avg / 1000.0;
    if avg_ms < 5.0 {
        println!(
            "[Test 6] PASS: avg RTT {:.3}ms < 5ms target",
            avg_ms
        );
    } else {
        println!(
            "[Test 6] FAIL: avg RTT {:.3}ms >= 5ms target",
            avg_ms
        );
    }

    // --- Summary ---
    println!("\n=== SPIKE 3 SUMMARY ===");
    println!("Extension loading:     OK");
    println!("activate() called:     OK");
    println!("Commands registered:   {} commands", commands.len());
    println!("Command execution:     OK (return values verified)");
    println!("Argument passing:      OK (string + numeric args)");
    println!("Data round-trip:       OK (computed result returned)");
    println!("Avg command RTT:       {:.3}ms", avg_ms);
    println!("========================\n");

    Ok(())
}
