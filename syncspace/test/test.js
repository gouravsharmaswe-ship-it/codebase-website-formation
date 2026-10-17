// Comprehensive Synapse Automated Integration Test Suite
// Real WebSocket server + real Synapse client library + TCP proxy simulating real-world network drops
const net = require('net');
const assert = require('assert');
const { server } = require('../server/server');
const Synapse = require('../web/syncspace.js');
const db = require('../server/db');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const waitUntil = async (conditionFn, timeoutMs = 8000, label = 'condition') => {
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
  console.log('🧪 Starting Synapse Integration Tests');
  console.log('========================================\n');

  // 1. Initialize DB migrations / memory store
  await db.initDb();

  // 2. Spin up backend server on random available port
  await new Promise(resolve => server.listen(0, resolve));
  const serverPort = server.address().port;

  // 3. Set up a controllable TCP proxy between clients and server to simulate network drops
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
    const client = Synapse.connect({
      url: proxyUrl,
      room,
      name,
      connectTimeout: 2000
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

  // TEST 2: Shared notepad synchronization across 3 tabs
  await runTest('Shared notepad text propagates in real time across all 3 browser tabs', async () => {
    clientA.set('pad', 'Hello collaborative world!');

    await waitUntil(() => {
      return clientB.get('pad') === 'Hello collaborative world!' &&
             clientC.get('pad') === 'Hello collaborative world!';
    }, 3000, 'client B and C to receive client A notepad text');

    assert.strictEqual(clientB.get('pad'), 'Hello collaborative world!');
    assert.strictEqual(clientC.get('pad'), 'Hello collaborative world!');
  });

  // TEST 3: Notepad history saves a version after 2 seconds of inactivity
  await runTest('Notepad history debounces and automatically saves a durable version after 2s', async () => {
    let savedVersionReceived = null;
    clientB.on('notepad-version-added', (v) => {
      savedVersionReceived = v;
    });

    // Make an edit
    clientA.set('pad', 'Versioned draft: Chapter 1', 25);

    // Should NOT have saved immediately (< 1000ms)
    await sleep(500);
    assert.strictEqual(savedVersionReceived, null, 'Must not save before 2 seconds of inactivity');

    // Wait until 2.3s has passed
    await waitUntil(() => savedVersionReceived !== null, 3500, 'debounce timer to save version');

    assert.strictEqual(savedVersionReceived.saved_text, 'Versioned draft: Chapter 1');
    assert.strictEqual(savedVersionReceived.display_name, 'User-Alpha');
    assert.strictEqual(savedVersionReceived.cursor_position, 25);
    assert(savedVersionReceived.id, 'Version must have a persistent ID');
  });

  // TEST 4: Restoring a historical version creates a new version without deleting history
  await runTest('Restoring an earlier version updates the pad and creates a new version preserving history', async () => {
    const versionsBefore = await db.getPadVersions('room-alpha');
    const targetVersionId = versionsBefore[0].id;
    const initialHistoryLength = versionsBefore.length;

    // Mutate text further
    clientA.set('pad', 'Temporary scribble that will be overwritten');
    await sleep(200);

    let restoredNotified = false;
    clientC.on('state', (key, val) => {
      if (key === 'pad' && val === 'Versioned draft: Chapter 1') {
        restoredNotified = true;
      }
    });

    // Client B triggers restore
    clientB.restoreVersion(targetVersionId);

    await waitUntil(() => restoredNotified, 3000, 'pad restored event');
    assert.strictEqual(clientA.get('pad'), 'Versioned draft: Chapter 1');
    assert.strictEqual(clientC.get('pad'), 'Versioned draft: Chapter 1');

    // Verify history grew (restoring creates a new version, never deletes past versions)
    const versionsAfter = await db.getPadVersions('room-alpha');
    assert(versionsAfter.length > initialHistoryLength, 'History count must increase after restore');
    assert.strictEqual(versionsAfter[0].saved_text, 'Versioned draft: Chapter 1');
    assert(versionsAfter[0].display_name.includes('Restored'), 'New version documents restoration author');
  });

  // TEST 5: Shared room counter atomic action and history
  await runTest('Shared counter actions apply atomically and record action history', async () => {
    let actionReceivedByC = null;
    clientC.on('counter-action-added', (act) => {
      actionReceivedByC = act;
    });

    clientA.counterAction('inc', 1);

    await waitUntil(() => {
      return clientB.get('counter') === 1 && clientC.get('counter') === 1;
    }, 3000, 'counter value 1 on peers');

    assert.strictEqual(clientB.get('counter'), 1);
    assert.strictEqual(clientC.get('counter'), 1);

    await waitUntil(() => actionReceivedByC !== null, 3000, 'counter action record received');
    assert.strictEqual(actionReceivedByC.action_type, 'inc');
    assert.strictEqual(actionReceivedByC.display_name, 'User-Alpha');
    assert.strictEqual(actionReceivedByC.resulting_value, 1);

    // Test simultaneous counter clicks without race conditions
    await Promise.all([
      clientA.counterAction('inc', 1),
      clientB.counterAction('inc', 1),
      clientC.counterAction('inc', 1)
    ]);

    await waitUntil(() => {
      return clientA.get('counter') === 4 && clientB.get('counter') === 4;
    }, 3000, 'atomic counter accumulation to 4');

    assert.strictEqual(clientA.get('counter'), 4);
  });

  // TEST 6: Room isolation
  await runTest('Rooms are strictly isolated (no cross-room state, presence, or cursor leak)', async () => {
    assert.strictEqual(clientOther.get('pad'), '');
    assert.strictEqual(clientOther.get('counter'), 0);
    assert.strictEqual(clientOther.peers().length, 1);

    clientOther.set('secret', 'classified');
    await sleep(200);

    assert.strictEqual(clientA.get('secret'), undefined);
    assert.strictEqual(clientB.get('secret'), undefined);
  });

  // TEST 7: Live cursor streaming
  await runTest('Live cursor streaming reaches only peers in the same room', async () => {
    let gotCursorB = null;
    let leakedToOther = false;

    clientB.on('cursor', (id, x, y) => {
      gotCursorB = { id, x, y };
    });
    clientOther.on('cursor', () => {
      leakedToOther = true;
    });

    clientA.cursor(0.42, 0.88);

    await waitUntil(() => gotCursorB !== null, 3000, 'client B cursor receipt');
    assert.strictEqual(gotCursorB.x, 0.42);
    assert.strictEqual(gotCursorB.y, 0.88);
    assert.strictEqual(leakedToOther, false);
  });

  // TEST 8: Genuine network disconnection and automatic reconnection with state restoration
  await runTest('Temporary network drop triggers auto-reconnect and restores latest room state', async () => {
    let reconnectingCount = 0;
    let reconnectInfo = null;

    clientC.on('reconnecting', () => {
      reconnectingCount++;
    });
    clientC.on('open', (info) => {
      reconnectInfo = info;
    });

    // 1. Cut the network connection via proxy
    proxyBlocked = true;
    for (const sock of activeSockets) {
      sock.destroy();
    }

    await waitUntil(() => reconnectingCount > 0, 5000, 'client C detects disconnect');

    // 2. Peer B updates state while C is offline
    clientB.set('pad', 'Updated while C was disconnected');

    // 3. Client C makes write while offline
    clientC.counterAction('inc', 10);

    await sleep(600);

    // 4. Restore network
    proxyBlocked = false;

    // 5. Client C should reconnect automatically
    await waitUntil(() => reconnectInfo && reconnectInfo.reconnected, 12000, 'client C reconnect');

    // 6. Verify client C restored server's latest text and all peers reconnected
    await waitUntil(() => {
      return clientC.get('pad') === 'Updated while C was disconnected' &&
             clientC.peers().length === 3;
    }, 12000, 'client C restored pad state and all peers reconnected');

    assert.strictEqual(clientC.get('pad'), 'Updated while C was disconnected');
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
