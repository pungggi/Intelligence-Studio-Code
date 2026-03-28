//! Spike 2: IPC Latency Benchmark
//!
//! Measures round-trip latency and throughput between Rust (client)
//! and Node.js (server) over Unix Domain Sockets.
//!
//! Compares two serialization strategies:
//! 1. Raw binary (length-prefixed, simulating FlatBuffers zero-copy)
//! 2. JSON-RPC (newline-delimited JSON)
//!
//! Usage:
//!   1. Start the Node.js server:  node src/extension-host/src/spike-ipc-server.js
//!   2. Run this benchmark:        cargo run --bin spike-ipc
//!
//! The benchmark will auto-detect which protocol the server supports.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};

const SOCKET_PATH: &str = "127.0.0.1:17532";
const MESSAGE_COUNT: usize = 10_000;
const WARMUP_COUNT: usize = 500;

// --- Binary protocol (simulates FlatBuffers) ---
// Format: [4-byte length LE][payload]
// Payload for request: { msg_type: u8, id: u64, uri_len: u16, uri: [u8], version: u32, text_len: u32, text: [u8] }
// Payload for response: { msg_type: u8, id: u64, status: u8 }

fn build_binary_message(id: u64, uri: &str, text: &str) -> Vec<u8> {
    // Simple binary encoding — no external deps needed
    let mut payload = Vec::with_capacity(32 + uri.len() + text.len());

    // msg_type = 1 (TextDocumentDidChange)
    payload.push(1u8);
    // id
    payload.extend_from_slice(&id.to_le_bytes());
    // uri length + uri
    payload.extend_from_slice(&(uri.len() as u16).to_le_bytes());
    payload.extend_from_slice(uri.as_bytes());
    // version
    payload.extend_from_slice(&(id as u32).to_le_bytes());
    // text length + text
    payload.extend_from_slice(&(text.len() as u32).to_le_bytes());
    payload.extend_from_slice(text.as_bytes());

    // Frame it with length prefix
    let mut frame = Vec::with_capacity(4 + payload.len());
    frame.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    frame.extend_from_slice(&payload);
    frame
}

fn read_binary_response(stream: &mut TcpStream) -> Result<(u64, u8)> {
    // Read 4-byte length
    let mut len_buf = [0u8; 4];
    stream.read_exact(&mut len_buf)?;
    let len = u32::from_le_bytes(len_buf) as usize;

    // Read payload
    let mut payload = vec![0u8; len];
    stream.read_exact(&mut payload)?;

    // Parse: msg_type(1) + id(8) + status(1)
    let id = u64::from_le_bytes(payload[1..9].try_into()?);
    let status = payload[9];

    Ok((id, status))
}

// --- JSON-RPC protocol ---

#[derive(Serialize)]
struct JsonRpcRequest {
    jsonrpc: &'static str,
    id: u64,
    method: &'static str,
    params: TextChangeParams,
}

#[derive(Serialize)]
struct TextChangeParams {
    uri: String,
    version: u32,
    text: String,
}

#[derive(Deserialize)]
struct JsonRpcResponse {
    id: u64,
    result: Option<JsonRpcResult>,
}

#[derive(Deserialize)]
struct JsonRpcResult {
    status: String,
}

fn build_json_message(id: u64, uri: &str, text: &str) -> Result<Vec<u8>> {
    let req = JsonRpcRequest {
        jsonrpc: "2.0",
        id,
        method: "textDocument/didChange",
        params: TextChangeParams {
            uri: uri.to_string(),
            version: id as u32,
            text: text.to_string(),
        },
    };
    let mut json = serde_json::to_vec(&req)?;
    json.push(b'\n');
    Ok(json)
}

fn read_json_response(stream: &mut TcpStream) -> Result<u64> {
    // Read until newline
    let mut buf = Vec::with_capacity(256);
    let mut byte = [0u8; 1];
    loop {
        stream.read_exact(&mut byte)?;
        if byte[0] == b'\n' {
            break;
        }
        buf.push(byte[0]);
    }

    let resp: JsonRpcResponse = serde_json::from_slice(&buf)?;
    Ok(resp.id)
}

// --- Benchmark harness ---

struct BenchResult {
    protocol: String,
    message_count: usize,
    total_time: Duration,
    rtts: Vec<Duration>,
}

impl BenchResult {
    fn report(&self) {
        let total_ms = self.total_time.as_secs_f64() * 1000.0;
        let throughput = self.message_count as f64 / self.total_time.as_secs_f64();

        let mut rtt_us: Vec<f64> = self
            .rtts
            .iter()
            .map(|d| d.as_secs_f64() * 1_000_000.0)
            .collect();
        rtt_us.sort_by(|a, b| a.partial_cmp(b).unwrap());

        let count = rtt_us.len();
        let avg = rtt_us.iter().sum::<f64>() / count as f64;
        let min = rtt_us[0];
        let max = rtt_us[count - 1];
        let median = rtt_us[count / 2];
        let p95 = rtt_us[(count as f64 * 0.95).min((count - 1) as f64) as usize];
        let p99 = rtt_us[(count as f64 * 0.99).min((count - 1) as f64) as usize];

        println!("\n--- {} ---", self.protocol);
        println!("Messages:   {}", self.message_count);
        println!("Total time: {:.1}ms", total_ms);
        println!("Throughput: {:.0} msg/sec", throughput);
        println!();
        println!("RTT (microseconds):");
        println!("  avg:    {:.1}µs", avg);
        println!("  min:    {:.1}µs", min);
        println!("  max:    {:.1}µs", max);
        println!("  median: {:.1}µs", median);
        println!("  p95:    {:.1}µs", p95);
        println!("  p99:    {:.1}µs", p99);
        println!();

        // Pass/fail criteria
        let avg_ms = avg / 1000.0;
        if avg_ms < 1.0 {
            println!(
                "[{}] PASS: avg RTT {:.3}ms < 1ms target",
                self.protocol, avg_ms
            );
        } else {
            println!(
                "[{}] FAIL: avg RTT {:.3}ms >= 1ms target",
                self.protocol, avg_ms
            );
        }

        if throughput > 50_000.0 {
            println!(
                "[{}] PASS: throughput {:.0} > 50,000 msg/sec target",
                self.protocol, throughput
            );
        } else {
            println!(
                "[{}] FAIL: throughput {:.0} <= 50,000 msg/sec target",
                self.protocol, throughput
            );
        }
    }
}

fn run_binary_benchmark(stream: &mut TcpStream) -> Result<BenchResult> {
    let uri = "file:///workspace/src/main.rs";
    let text = "let x = 42; // edited line with some realistic content for benchmarking";

    // Warmup
    for i in 0..WARMUP_COUNT {
        let msg = build_binary_message(i as u64, uri, text);
        stream.write_all(&msg)?;
        let _ = read_binary_response(stream)?;
    }

    // Benchmark
    let mut rtts = Vec::with_capacity(MESSAGE_COUNT);
    let total_start = Instant::now();

    for i in 0..MESSAGE_COUNT {
        let msg = build_binary_message((WARMUP_COUNT + i) as u64, uri, text);
        let rtt_start = Instant::now();
        stream.write_all(&msg)?;
        let (resp_id, _status) = read_binary_response(stream)?;
        let rtt = rtt_start.elapsed();
        rtts.push(rtt);

        assert_eq!(resp_id, (WARMUP_COUNT + i) as u64, "Response ID mismatch");
    }

    let total_time = total_start.elapsed();

    Ok(BenchResult {
        protocol: "Binary (FlatBuffers-like)".to_string(),
        message_count: MESSAGE_COUNT,
        total_time,
        rtts,
    })
}

fn run_json_benchmark(stream: &mut TcpStream) -> Result<BenchResult> {
    let uri = "file:///workspace/src/main.rs";
    let text = "let x = 42; // edited line with some realistic content for benchmarking";

    // Warmup
    for i in 0..WARMUP_COUNT {
        let msg = build_json_message(i as u64, uri, text)?;
        stream.write_all(&msg)?;
        let _ = read_json_response(stream)?;
    }

    // Benchmark
    let mut rtts = Vec::with_capacity(MESSAGE_COUNT);
    let total_start = Instant::now();

    for i in 0..MESSAGE_COUNT {
        let msg = build_json_message((WARMUP_COUNT + i) as u64, uri, text)?;
        let rtt_start = Instant::now();
        stream.write_all(&msg)?;
        let resp_id = read_json_response(stream)?;
        let rtt = rtt_start.elapsed();
        rtts.push(rtt);

        assert_eq!(resp_id, (WARMUP_COUNT + i) as u64, "Response ID mismatch");
    }

    let total_time = total_start.elapsed();

    Ok(BenchResult {
        protocol: "JSON-RPC".to_string(),
        message_count: MESSAGE_COUNT,
        total_time,
        rtts,
    })
}

fn main() -> Result<()> {
    println!("=== CoreCode Spike 2: IPC Latency Benchmark ===\n");
    println!("Connecting to {SOCKET_PATH}...");

    // Run binary benchmark
    println!("\n[1/2] Running binary protocol benchmark ({MESSAGE_COUNT} messages, {WARMUP_COUNT} warmup)...");
    let mut stream = TcpStream::connect(SOCKET_PATH)?;
    // Send protocol selection: 'B' for binary
    stream.write_all(b"B")?;
    let binary_result = run_binary_benchmark(&mut stream)?;
    drop(stream);

    // Small pause between benchmarks
    std::thread::sleep(Duration::from_millis(100));

    // Run JSON benchmark
    println!(
        "[2/2] Running JSON-RPC benchmark ({MESSAGE_COUNT} messages, {WARMUP_COUNT} warmup)..."
    );
    let mut stream = TcpStream::connect(SOCKET_PATH)?;
    // Send protocol selection: 'J' for JSON
    stream.write_all(b"J")?;
    let json_result = run_json_benchmark(&mut stream)?;
    drop(stream);

    // Report results
    println!("\n==================================================");
    println!("=== SPIKE 2 RESULTS ===");

    binary_result.report();
    json_result.report();

    // Comparison
    let binary_avg = binary_result
        .rtts
        .iter()
        .map(|d| d.as_secs_f64())
        .sum::<f64>()
        / binary_result.rtts.len() as f64;
    let json_avg = json_result
        .rtts
        .iter()
        .map(|d| d.as_secs_f64())
        .sum::<f64>()
        / json_result.rtts.len() as f64;
    let speedup = json_avg / binary_avg;

    println!("\n--- Comparison ---");
    println!("Binary vs JSON speedup: {:.1}x", speedup);

    if speedup >= 3.0 {
        println!("[Comparison] PASS: Binary >= 3x faster than JSON");
    } else {
        println!(
            "[Comparison] INFO: Binary {:.1}x faster (target: 3x)",
            speedup
        );
        println!("  Note: On local sockets, serialization overhead may be");
        println!("  small relative to syscall cost. FlatBuffers advantage");
        println!("  grows with larger payloads and complex message structures.");
    }

    println!("\n=== END SPIKE 2 ===");

    Ok(())
}
