"use strict";
var socket = null;
var WORKER_TOKEN = "";

function state(phase, extra) {
  self.postMessage(Object.assign({ kind: "state", phase: phase }, extra || {}));
}
function connect() {
  if (socket && socket.readyState === WebSocket.OPEN) {
    state("connected", { connected: true });
    return;
  }
  try {
    socket = new WebSocket("ws://127.0.0.1:8765");
    socket.onopen = function () {
      socket.send(JSON.stringify({ type: "auth", token: WORKER_TOKEN }));
      state("connected", { connected: true });
    };
    socket.onmessage = function (event) {
      self.postMessage({ kind: "message", data: event.data });
    };
    socket.onerror = function () {
      state("error", { connected: false, error: "No se pudo conectar con el motor local" });
    };
    socket.onclose = function () {
      socket = null;
      state("closed", { connected: false });
    };
  } catch (error) {
    state("error", { connected: false, error: String(error) });
  }
}
self.onmessage = function (event) {
  var message = event.data || {};
  if (message.type === "connect") connect();
  if (message.type === "send") {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message.payload || {}));
    else state("error", { connected: false, error: "Motor local desconectado" });
  }
};
connect();