/*!
 * SyncSpace.js — Multiplayer in 10 lines!
 * Single-file, dependency-free real-time client library.
 *
 * Quickstart:
 *   const room = SyncSpace.connect({ url: 'wss://your-server', room: 'demo', name: 'Alex' });
 *   room.on('state', (key, val) => console.log(key, val));
 *   room.set('score', 42);
 *   room.on('cursor', (id, x, y, peer) => drawCursor(id, x, y, peer));
 *   document.onmousemove = e => room.cursor(e.clientX / innerWidth, e.clientY / innerHeight);
 *
 * Public API:
 *   SyncSpace.connect({ url, room, name, clientId, connectTimeout })
 *   SyncSpace.randomRoom()
 *
 * Room instance methods:
 *   room.set(key, value)
 *   room.get(key)
 *   room.getAll()
 *   room.peers()
 *   room.me()
 *   room.cursor(x, y)
 *   room.on(event, fn)
 *   room.off(event, fn)
 *   room.close()
 *   room.simulateDisconnect()
 *   room.status -> 'connecting' | 'open' | 'reconnecting' | 'closed'
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SyncSpace = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function randomRoom() {
    var chars = 'abcdefghjkmnpqrstuvwxyz23456789';
    var res = '';
    for (var i = 0; i < 6; i++) {
      res += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return res;
  }

  function connect(opts) {
    opts = opts || {};
    if (!opts.url) throw new Error('SyncSpace.connect: "url" is required');
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(opts.room || '')) {
      throw new Error('SyncSpace.connect: "room" must be 1-32 characters (alphanumeric, -, _)');
    }

    var WS = opts.WebSocket || (typeof WebSocket !== 'undefined' ? WebSocket : null);
    if (!WS) throw new Error('SyncSpace: No WebSocket implementation found');

    var listeners = {};
    var state = {}; // Current shared state map
    var peers = {}; // id -> { id, name, color }
    var myId = opts.clientId || (randomRoom() + randomRoom());
    var ws = null;
    var closedByUser = false;
    var attempts = 0;
    var reconnectTimer = null;
    var heartbeatTimer = null;
    var offlineQueue = [];
    var lastCursorTime = 0;

    var api = {
      status: 'connecting'
    };

    function emit(event) {
      var args = Array.prototype.slice.call(arguments, 1);
      var handlers = listeners[event] || [];
      handlers.slice().forEach(function (fn) {
        try {
          fn.apply(null, args);
        } catch (err) {
          console.error('[SyncSpace] Listener error for event "' + event + '":', err);
        }
      });
    }

    function sendRaw(payload) {
      if (ws && ws.readyState === 1) {
        try {
          ws.send(JSON.stringify(payload));
          return true;
        } catch (e) {
          return false;
        }
      }
      return false;
    }

    function setStatus(newStatus) {
      api.status = newStatus;
    }

    function getPeerList() {
      return Object.keys(peers).map(function (k) {
        return peers[k];
      });
    }

    function open() {
      setStatus(attempts > 0 ? 'reconnecting' : 'connecting');
      var sock = (ws = new WS(opts.url));
      var isDropped = false;

      // Handle hanging handshake
      var connectTimer = setTimeout(function () {
        if (sock.readyState !== 1) {
          try {
            sock.close();
          } catch (e) {}
          handleDrop();
        }
      }, opts.connectTimeout || 8000);

      function handleDrop() {
        if (isDropped) return;
        isDropped = true;
        clearTimeout(connectTimer);
        clearInterval(heartbeatTimer);

        sock.onopen = sock.onmessage = sock.onerror = sock.onclose = null;

        if (closedByUser) {
          setStatus('closed');
          emit('close');
          return;
        }

        setStatus('reconnecting');
        var delay = Math.min(10000, 500 * Math.pow(2, attempts)) + Math.random() * 300;
        attempts++;
        emit('reconnecting', attempts, delay);
        reconnectTimer = setTimeout(open, delay);
      }

      sock.onopen = function () {
        clearTimeout(connectTimer);
        sendRaw({
          t: 'join',
          room: opts.room,
          name: opts.name || 'Guest',
          clientId: myId
        });
      };

      sock.onmessage = function (event) {
        var msg;
        try {
          msg = JSON.parse(event.data);
        } catch (e) {
          return;
        }

        switch (msg.t) {
          case 'welcome': {
            var wasReconnect = attempts > 0;
            attempts = 0;
            myId = msg.id;
            setStatus('open');

            // Synchronize state snapshot
            var previousState = state;
            state = msg.state || {};

            // Fire state events for differences
            Object.keys(state).forEach(function (k) {
              if (JSON.stringify(previousState[k]) !== JSON.stringify(state[k])) {
                emit('state', k, state[k], null);
              }
            });
            Object.keys(previousState).forEach(function (k) {
              if (!(k in state)) {
                emit('state', k, undefined, null);
              }
            });

            // Update peer directory
            peers = {};
            (msg.peers || []).forEach(function (p) {
              peers[p.id] = p;
            });

            emit('open', { reconnected: wasReconnect });
            emit('presence', getPeerList());

            // Flush offline write queue
            var queued = offlineQueue;
            offlineQueue = [];
            queued.forEach(function (item) {
              api.set(item.key, item.value);
            });

            // Start heartbeat ping
            clearInterval(heartbeatTimer);
            heartbeatTimer = setInterval(function () {
              sendRaw({ t: 'ping' });
            }, 20000);
            break;
          }

          case 'state': {
            if (msg.value === undefined) {
              delete state[msg.key];
            } else {
              state[msg.key] = msg.value;
            }
            emit('state', msg.key, msg.value, msg.by);
            break;
          }

          case 'peer-join': {
            peers[msg.peer.id] = msg.peer;
            emit('peer-join', msg.peer);
            emit('presence', getPeerList());
            break;
          }

          case 'peer-leave': {
            var departed = peers[msg.id];
            delete peers[msg.id];
            emit('peer-leave', msg.id, departed);
            emit('presence', getPeerList());
            break;
          }

          case 'cursor': {
            emit('cursor', msg.id, msg.x, msg.y, peers[msg.id]);
            break;
          }

          case 'error': {
            emit('error', { code: msg.code, message: msg.message });
            break;
          }

          case 'pong': {
            // Heartbeat ACK
            break;
          }
        }
      };

      sock.onclose = handleDrop;
      sock.onerror = function () {};
    }

    // Public Room API
    api.on = function (event, fn) {
      if (typeof fn === 'function') {
        (listeners[event] = listeners[event] || []).push(fn);
      }
      return api;
    };

    api.off = function (event, fn) {
      if (listeners[event]) {
        listeners[event] = listeners[event].filter(function (f) {
          return f !== fn;
        });
      }
      return api;
    };

    api.get = function (key) {
      return state[key];
    };

    api.getAll = function () {
      return JSON.parse(JSON.stringify(state));
    };

    api.peers = getPeerList;

    api.me = function () {
      return peers[myId] || { id: myId, name: opts.name || 'Guest', color: '#6366f1' };
    };

    api.set = function (key, value) {
      // Optimistic local state update
      if (value === undefined) {
        delete state[key];
      } else {
        state[key] = value;
      }

      if (!sendRaw({ t: 'set', key: key, value: value })) {
        offlineQueue.push({ key: key, value: value });
      }
      return api;
    };

    api.cursor = function (x, y) {
      var now = Date.now();
      // Throttle cursor broadcast to ~30 updates/sec
      if (now - lastCursorTime < 33) return;
      lastCursorTime = now;
      sendRaw({ t: 'cursor', x: x, y: y });
    };

    api.close = function () {
      closedByUser = true;
      clearTimeout(reconnectTimer);
      clearInterval(heartbeatTimer);
      if (ws) {
        try {
          ws.close();
        } catch (e) {}
      }
    };

    // Helper for demo/testing: simulates network cut
    api.simulateDisconnect = function () {
      if (ws) {
        try {
          ws.close();
        } catch (e) {}
      }
    };

    open();
    return api;
  }

  return {
    connect: connect,
    randomRoom: randomRoom
  };
});
