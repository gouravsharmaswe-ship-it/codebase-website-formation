// Comprehensive SyncSpace Automated Integration Test Suite
// Real WebSocket server + real SyncSpace client library + TCP proxy simulating real-world network drops
const net = require('net');
const assert = require('assert');
const { server } = require('../server/server');
const SyncSpace = require('../web/syncspace.js');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const waitUntil = async (conditionFn, timeoutMs = 6000, label = 'condition') => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (conditionFn()) return;
    await sleep(30);
  }
  throw new Error(`Timed out waiting for: ${label}`);
};

let testsPassed = 0;
let testsFailed = 0;

async function runTest(testName, testFn) {
  try {
    await testFn();
    testsPassed++;
    console.log(`  ✓ PASS: ${testName}`);
  } catch (err) {
    testsFailed++;
    console.error(`  ✗ FAIL: ${testName} - ${err.message}`);
  }
}

(async () => {
  console.log('\n========================================');
  console.log('🧪 Starting SyncSpace Integration Tests');
  console.log('========================================\n');

  // 1. Spin up backend server on random available port
  await new Promise(resolve => server.listen(0, resolve));
  const serverPort = server.address().port;

  // 2. Set up a controllable TCP proxy between clients and server to simulate network cuts
  const activeSockets = new Set();
  let proxyBlocked = false;

  const proxyServer = net.createServer(clientSock => {
    if (proxyBlocked) {
      return clientSock.destroy();
    }
    const serverSock = net.connect(serverPort, '127.0.0.1');
    activeSockets.add(clientSock);
    activeSockets.add(serverSock);

    clientSock.pipe(serverSock);
    serverSock.pipe(clientSock);

    const cleanup = () => {
      clientSock.destroy();
      serverSock.destroy();
      activeSockets.delete(clientSock);
      activeSockets.delete(serverSock);
    };

    clientSock.on('error', cleanup);
    serverSock.on('error', cleanup);
    clientSock.on('close', cleanup);
    serverSock.on('close', cleanup);
  });

  await new Promise(resolve => proxyServer.listen(0, resolve));
  const proxyPort = proxyServer.address().port;
  const proxyUrl = `ws://127.0.0.1:${proxyPort}`;

  const openClients = [];
  const createClient = (room, name) => {
    const client = SyncSpace.connect({
      url: proxyUrl,
      room,
      name,
      connectTimeout: 1800
    });
    openClients.push(client);
    return new Promise(resolve => client.on('open', () => resolve(client)));
  };

  // Connect three clients to room "room-alpha"
  const [clientA, clientB, clientC] = await Promise.all([
    createClient('room-alpha', 'User-Alpha'),
    createClient('room-alpha', 'User-Beta'),
    createClient('room-alpha', 'User-Gamma')
  ]);

  // Connect one client to an isolated room "room-beta"
  const clientOther = await createClient('room-beta', 'User-Isolated');

  // TEST 1: Presence across 3 tabs
  await runTest('Online presence list accurately tracks all 3 connected clients in room', async () => {
    await waitUntil(() => {
      return clientA.peers().length === 3 &&
             clientB.peers().length === 3 &&
             clientC.peers().length === 3;
    }, 4000, 'all 3 peers present in peer lists');

    const namesA = clientA.peers().map(p => p.name).sort();
    assert.deepStrictEqual(namesA, ['User-Alpha', 'User-Beta', 'User-Gamma']);
  });

  // TEST 2: Shared-state synchronization across 3 tabs
  await runTest('Shared-state synchronization propagates across all 3 browser tabs', async () => {
    // Client A updates counter and message
    clientA.set('counter', 42);
    clientA.set('doc', { title: 'Hackathon Note', content: 'SyncSpace works!' });

    await waitUntil(() => {
      return clientB.get('counter') === 42 && clientC.get('counter') === 42;
    }, 3000, 'client B and C to receive client A updates');

    assert.strictEqual(clientB.get('counter'), 42);
    assert.deepStrictEqual(clientC.get('doc'), { title: 'Hackathon Note', content: 'SyncSpace works!' });

    // Client C updates state; Client A and B receive it
    clientC.set('counter', 100);
    await waitUntil(() => {
      return clientA.get('counter') === 100 && clientB.get('counter') === 100;
    }, 3000, 'client A and B to receive client C counter update');

    assert.strictEqual(clientA.get('counter'), 100);
  });

  // TEST 3: Room isolation
  await runTest('Different rooms remain strictly isolated (zero state or presence leak)', async () => {
    // Isolated client should only see 1 peer and none of room-alpha's keys
    assert.strictEqual(clientOther.peers().length, 1);
    assert.strictEqual(clientOther.get('counter'), undefined);
    assert.strictEqual(clientOther.get('doc'), undefined);

    // Isolated client writes a secret key
    clientOther.set('room_beta_secret', 'confidential');
    await sleep(200);

    // Alpha room peers must not see it
    assert.strictEqual(clientA.get('room_beta_secret'), undefined);
    assert.strictEqual(clientB.get('room_beta_secret'), undefined);
    assert.strictEqual(clientC.get('room_beta_secret'), undefined);
  });

  // TEST 4: Live cursors
  await runTest('Live cursor movements broadcast exclusively to peers in the same room', async () => {
    let receivedByB = null;
    let leakedToOther = false;

    clientB.on('cursor', (id, x, y) => {
      receivedByB = { id, x, y };
    });

    clientOther.on('cursor', () => {
      leakedToOther = true;
    });

    // Client A moves cursor
    clientA.cursor(0.35, 0.85);

    await waitUntil(() => receivedByB !== null, 3000, 'client B cursor receipt');

    assert.strictEqual(receivedByB.x, 0.35);
    assert.strictEqual(receivedByB.y, 0.85);
    assert.strictEqual(leakedToOther, false, 'Cursor event must not leak across rooms');
  });

  // TEST 5: Late joiner state restoration
  await runTest('A new peer joining late receives the full latest shared state snapshot', async () => {
    const clientLate = await createClient('room-alpha', 'User-Latecomer');
    
    assert.strictEqual(clientLate.get('counter'), 100);
    assert.deepStrictEqual(clientLate.get('doc'), { title: 'Hackathon Note', content: 'SyncSpace works!' });
    assert.strictEqual(clientLate.peers().length, 4);

    clientLate.close();
    await waitUntil(() => clientA.peers().length === 3, 3000, 'peer-leave propagation');
  });

  // TEST 6: Input validation & error resilience
  await runTest('Client and server reject malformed inputs and handle errors gracefully', async () => {
    // Client-side invalid room validation
    assert.throws(() => {
      SyncSpace.connect({ url: proxyUrl, room: 'invalid room space!' });
    }, /room/);

    // Direct raw socket tests against server error responses
    const rawWs = new (SyncSpace.connect({ url: proxyUrl, room: 'test-err' })._ws || WebSocket || require('ws'))(proxyUrl);
    const serverErrors = [];
    rawWs.onmessage = e => {
      try {
        serverErrors.push(JSON.parse(e.data));
      } catch {}
    };

    await new Promise(r => (rawWs.onopen = r));
    // Send bad json
    rawWs.send('invalid raw text frame');
    // Send state before join
    rawWs.send(JSON.stringify({ t: 'set', key: 'k', value: 1 }));
    // Send invalid room in join
    rawWs.send(JSON.stringify({ t: 'join', room: '../path_traversal' }));

    await waitUntil(() => serverErrors.length >= 3, 4000, 'server error frames');
    const errorCodes = serverErrors.map(e => e.code);
    assert(errorCodes.includes('bad_json'), 'Server should reject bad json');
    assert(errorCodes.includes('not_joined'), 'Server should reject action before join');
    assert(errorCodes.includes('bad_room'), 'Server should reject invalid room characters');

    rawWs.close();
  });

  // TEST 7: Genuine temporary disconnection and automatic reconnection with state restoration
  await runTest('Genuine temporary network severance -> auto-reconnect -> offline writes synced', async () => {
    let reconnectCount = 0;
    let reconnectInfo = null;

    clientC.on('reconnecting', () => {
      reconnectCount++;
    });

    clientC.on('open', info => {
      reconnectInfo = info;
    });

    // 1. Cut the network completely via proxy
    proxyBlocked = true;
    for (const sock of activeSockets) {
      sock.destroy();
    }

    // Wait until Client C notices the disconnection
    await waitUntil(() => reconnectCount > 0, 5000, 'client C reconnecting event');

    // 2. Peer B updates state while C is disconnected (B will also try to reconnect)
    clientB.set('server_updated_while_away', 'fresh-data');

    // 3. Client C makes a write while completely offline (should be queued in memory)
    clientC.set('offline_write_from_c', 'success-queued');

    await sleep(600);

    // 4. Restore the network
    proxyBlocked = false;

    // 5. Client C should reconnect automatically
    await waitUntil(() => reconnectInfo && reconnectInfo.reconnected === true, 12000, 'client C successful reconnect');

    // 6. Verify client C restored state from server
    await waitUntil(() => {
      return clientC.get('server_updated_while_away') === 'fresh-data' &&
             clientA.get('offline_write_from_c') === 'success-queued';
    }, 12000, 'offline queued writes synced and restored');

    assert.strictEqual(clientC.get('server_updated_while_away'), 'fresh-data');
    assert.strictEqual(clientA.get('offline_write_from_c'), 'success-queued');
    assert.strictEqual(clientC.peers().length, 3);
  });

  console.log('\n========================================');
  console.log(`Test Results: ${testsPassed} passed, ${testsFailed} failed`);
  console.log('========================================\n');

  // Teardown
  openClients.forEach(c => c.close());
  proxyServer.close();
  server.close();

  setTimeout(() => {
    process.exit(testsFailed ? 1 : 0);
  }, 150);
})();
