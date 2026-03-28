#!/usr/bin/env node
/**
 * Spike 2: IPC Benchmark Server (Node.js side)
 *
 * Listens on a Unix Domain Socket and responds to messages
 * using either binary or JSON-RPC protocol based on client selection.
 *
 * Usage: node src/extension-host/src/spike-ipc-server.js
 *
 * Protocol selection: Client sends first byte:
 *   'B' (0x42) = Binary protocol
 *   'J' (0x4A) = JSON-RPC protocol
 */

const net = require('net');
const fs = require('fs');
const path = require('path');

const SOCKET_PATH = '/tmp/corecode-spike-ipc.sock';

// Clean up stale socket
if (fs.existsSync(SOCKET_PATH)) {
  fs.unlinkSync(SOCKET_PATH);
}

let connectionCount = 0;

const server = net.createServer((socket) => {
  connectionCount++;
  const connId = connectionCount;
  console.log(`[Connection ${connId}] Client connected`);

  let protocol = null; // 'binary' or 'json'
  let messageCount = 0;
  let buffer = Buffer.alloc(0);

  socket.on('data', (data) => {
    // First byte selects protocol
    if (protocol === null) {
      const selector = data[0];
      if (selector === 0x42) { // 'B'
        protocol = 'binary';
        console.log(`[Connection ${connId}] Protocol: Binary`);
        data = data.subarray(1);
      } else if (selector === 0x4A) { // 'J'
        protocol = 'json';
        console.log(`[Connection ${connId}] Protocol: JSON-RPC`);
        data = data.subarray(1);
      } else {
        console.error(`[Connection ${connId}] Unknown protocol selector: 0x${selector.toString(16)}`);
        socket.destroy();
        return;
      }
      if (data.length === 0) return;
    }

    if (protocol === 'binary') {
      handleBinaryData(socket, data, connId);
    } else {
      handleJsonData(socket, data, connId);
    }
  });

  // --- Binary protocol handler ---
  // Stateful: accumulate data and process length-prefixed frames
  let binaryBuffer = Buffer.alloc(0);

  function handleBinaryData(socket, data, connId) {
    binaryBuffer = Buffer.concat([binaryBuffer, data]);

    while (binaryBuffer.length >= 4) {
      const frameLen = binaryBuffer.readUInt32LE(0);
      if (binaryBuffer.length < 4 + frameLen) break; // incomplete frame

      const payload = binaryBuffer.subarray(4, 4 + frameLen);
      binaryBuffer = binaryBuffer.subarray(4 + frameLen);

      // Parse request
      // msg_type(1) + id(8) + uri_len(2) + uri(N) + version(4) + text_len(4) + text(M)
      const msgType = payload[0];
      const id = payload.readBigUInt64LE(1);
      const uriLen = payload.readUInt16LE(9);
      // We don't need to actually parse uri/text for the benchmark,
      // but we do it to simulate real work
      const uri = payload.subarray(11, 11 + uriLen).toString('utf8');
      const versionOffset = 11 + uriLen;
      const version = payload.readUInt32LE(versionOffset);
      const textLen = payload.readUInt32LE(versionOffset + 4);
      const text = payload.subarray(versionOffset + 8, versionOffset + 8 + textLen).toString('utf8');

      messageCount++;

      // Build binary response: msg_type(1) + id(8) + status(1) = 10 bytes
      const respPayload = Buffer.alloc(10);
      respPayload[0] = 2; // response type
      respPayload.writeBigUInt64LE(id, 1);
      respPayload[9] = 0; // status OK

      // Frame it
      const respFrame = Buffer.alloc(4 + respPayload.length);
      respFrame.writeUInt32LE(respPayload.length, 0);
      respPayload.copy(respFrame, 4);

      socket.write(respFrame);
    }
  }

  // --- JSON-RPC handler ---
  let jsonBuffer = '';

  function handleJsonData(socket, data, connId) {
    jsonBuffer += data.toString('utf8');

    let newlineIdx;
    while ((newlineIdx = jsonBuffer.indexOf('\n')) !== -1) {
      const line = jsonBuffer.substring(0, newlineIdx);
      jsonBuffer = jsonBuffer.substring(newlineIdx + 1);

      if (line.length === 0) continue;

      try {
        const request = JSON.parse(line);
        messageCount++;

        // Parse to simulate real work (same as binary)
        const { uri, version, text } = request.params;

        const response = JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: { status: 'ok' },
        });

        socket.write(response + '\n');
      } catch (err) {
        console.error(`[Connection ${connId}] JSON parse error:`, err.message);
      }
    }
  }

  socket.on('close', () => {
    console.log(`[Connection ${connId}] Disconnected (${messageCount} messages processed)`);
  });

  socket.on('error', (err) => {
    if (err.code !== 'ECONNRESET') {
      console.error(`[Connection ${connId}] Error:`, err.message);
    }
  });
});

server.listen(SOCKET_PATH, () => {
  console.log(`=== CoreCode Spike 2: IPC Benchmark Server ===`);
  console.log(`Listening on ${SOCKET_PATH}`);
  console.log(`Waiting for client connections...`);
  console.log(`(Press Ctrl+C to stop)\n`);
});

// Cleanup on exit
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  server.close();
  if (fs.existsSync(SOCKET_PATH)) {
    fs.unlinkSync(SOCKET_PATH);
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  server.close();
  if (fs.existsSync(SOCKET_PATH)) {
    fs.unlinkSync(SOCKET_PATH);
  }
  process.exit(0);
});
