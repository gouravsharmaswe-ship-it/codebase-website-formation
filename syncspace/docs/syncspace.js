/*!
 * Synapse.js (formerly SyncSpace) — Real-time Multiplayer Coordination Client Library
 * Single-file, dependency-free real-time collaboration.
 *
 * Public API:
 *   Synapse.connect({ url, room, name, clientId, connectTimeout })
 *   Synapse.randomRoom()
 *
 * Room Methods:
 *   room.set(key, value, [cursorPosition])
 *   room.counterAction(action, [amount])
 *   room.restoreVersion(versionId)
 *   room.quickShout(message)
 *   room.sendReaction(emoji)
 *   room.cursor(x, y)
 *   room.get(key)
 *   room.getAll()
 *   room.peers()
 *   room.me()
 *   room.on(event, fn)
 *   room.off(event, fn)
 *   room.close()
 *   room.simulateDisconnect()
 *   room.status -> 'connecting' | 'open' | 'reconnecting' | 'closed'
 */

(function (root, factory) {
  var lib = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = lib;
  } else {
    root.Synapse = lib;
    root.SyncSpace = lib; // Backward-compatible alias
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
    if (!opts.url) throw new Error('Synapse.connect: "url" is required');
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(opts.room || '')) {
      throw new Error('Synapse.connect: "room" must be 1-32 alphanumeric characters, - or _');
    }

    var WS = opts.WebSocket || (typeof WebSocket !== 'undefined' ? WebSocket : null);
    if (!WS) throw new Error('Synapse: No WebSocket implementation found');

    var listeners = {};
    var state = {};
    var peers = {};
    var myId = opts.clientId || (randomRoom() + randomRoom());
    var ws = null;
    var closedByUser = false;
    var attempts = 0;
    var reconnectTimer = null;
    var heartbeatTimer = null;
    var offlineQueue = [];
    var lastCursorTime = 0;

    var api = {
      status: 'connecting',
      notepadHistory: [],
      counterHistory: [],
      dbConnected: false
    };

    function emit(event) {
      var args = Array.prototype.slice.call(arguments, 1);
      var handlers = listeners[event] || [];
      handlers.slice().forEach(function (fn) {
        try {
          fn.apply(null, args);
        } catch (err) {
          console.error('[Synapse] Listener error for event "' + event + '":', err);
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

            var previousState = state;
            state = msg.state || {};

            api.notepadHistory = msg.notepadHistory || [];
            api.counterHistory = msg.counterHistory || [];
            api.dbConnected = !!msg.dbConnected;

            // Trigger state diff events
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

            peers = {};
            (msg.peers || []).forEach(function (p) {
              peers[p.id] = p;
            });

            emit('open', {
              reconnected: wasReconnect,
              notepadHistory: api.notepadHistory,
              counterHistory: api.counterHistory,
              dbConnected: api.dbConnected
            });
            emit('presence', getPeerList());

            // Flush offline write queue
            var queued = offlineQueue;
            offlineQueue = [];
            queued.forEach(function (item) {
              if (item.type === 'counter_action') {
                api.counterAction(item.action, item.amount);
              } else {
                api.set(item.key, item.value, item.cursorPosition);
              }
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

          case 'notepad_version_added': {
            if (msg.version) {
              api.notepadHistory.unshift(msg.version);
              if (api.notepadHistory.length > 100) api.notepadHistory.pop();
              emit('notepad-version-added', msg.version, api.notepadHistory);
            }
            break;
          }

          case 'counter_action_added': {
            if (msg.action) {
              api.counterHistory.unshift(msg.action);
              if (api.counterHistory.length > 100) api.counterHistory.pop();
              emit('counter-action-added', msg.action, api.counterHistory);
            }
            break;
          }

          case 'quick_shout': {
            emit('quick-shout', msg);
            break;
          }

          case 'reaction': {
            emit('reaction', msg.emoji, msg.from, msg.time);
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
            break;
          }
        }
      };

      sock.onclose = handleDrop;
      sock.onerror = function () {};
    }

    // Public Room Instance API
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
      return peers[myId] || { id: myId, name: opts.name || 'Guest', color: '#4f46e5' };
    };

    api.set = function (key, value, cursorPosition) {
      if (value === undefined) {
        delete state[key];
      } else {
        state[key] = value;
      }

      var payload = {
        t: 'set',
        key: key,
        value: value,
        cursorPosition: typeof cursorPosition === 'number' ? cursorPosition : null
      };

      if (!sendRaw(payload)) {
        offlineQueue.push({ type: 'set', key: key, value: value, cursorPosition: cursorPosition });
      }
      return api;
    };

    api.counterAction = function (action, amount) {
      var act = action || 'inc';
      var amt = typeof amount === 'number' ? amount : 1;
      var payload = {
        t: 'counter_action',
        action: act,
        amount: amt
      };

      if (!sendRaw(payload)) {
        offlineQueue.push({ type: 'counter_action', action: act, amount: amt });
      }
      return api;
    };

    api.restoreVersion = function (versionId) {
      return sendRaw({
        t: 'restore_version',
        versionId: versionId
      });
    };

    api.quickShout = function (message) {
      var text = String(message || '').trim().slice(0, 240);
      if (!text) return false;
      return sendRaw({
        t: 'quick_shout',
        message: text
      });
    };

    api.sendReaction = function (emoji) {
      var em = String(emoji || '🚀').slice(0, 8);
      return sendRaw({
        t: 'reaction',
        emoji: em
      });
    };

    api.cursor = function (x, y) {
      var now = Date.now();
      if (now - lastCursorTime < 33) return; // ~30 fps max
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
