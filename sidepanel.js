(function () {
  "use strict";
  var metrics = { segments: 0, queueDepth: 0, groqEstimatedUsd: 0 };
  var $ = function (id) { return document.getElementById(id); };
  function dot(id, ok, warning) {
    $(id).style.background = ok ? "#22c55e" : warning ? "#f59e0b" : "#ef4444";
  }
  function addSegment(data) {
    var speaker = data.speaker === "interpreter" ? "interpreter" : "client";
    var host = $(speaker);
    var empty = host.querySelector(".empty");
    if (empty) empty.remove();
    var p = document.createElement("p");
    p.className = data.engine === "groq" ? "groq" : "local";
    var time = document.createElement("time");
    time.textContent = new Date(data.timestamp || Date.now()).toLocaleTimeString();
    p.appendChild(time);
    p.appendChild(document.createTextNode(String(data.text || "")));
    host.appendChild(p);
    while (host.children.length > 80) host.removeChild(host.firstChild);
    host.scrollTop = host.scrollHeight;
    $(speaker + "Latency").textContent = Number(data.latencyMs || 0) + " ms · " + (data.engine || "local");
  }
  function renderMetrics(data) {
    metrics = Object.assign(metrics, data || {});
    $("segments").textContent = String(metrics.segments || 0);
    $("queue").textContent = String(metrics.queueDepth || 0);
    $("groqCost").textContent = "$" + Number(metrics.groqEstimatedUsd || 0).toFixed(4);
  }
  chrome.runtime.onMessage.addListener(function (message) {
    if (!message) return;
    if (message.type === "EFFECTIF_TRANSCRIPT_SEGMENT") addSegment(message.payload || {});
    if (message.type === "EFFECTIF_TRANSCRIPTION_METRICS") renderMetrics(message.payload || {});
    if (message.type === "EFFECTIF_TRANSCRIPTION_STATUS") {
      var data = message.payload || {};
      if (data.connected != null) {
        dot("workerDot", !!data.connected);
        $("workerStatus").textContent = data.connected ? "Conectado" : (data.error || "Sin conexión");
      }
      if (data.engine) {
        dot("engineDot", true, data.engine === "groq");
        $("engineStatus").textContent = data.engine === "groq" ? "Groq respaldo" : "Whisper local";
      }
      if (data.phase === "stopped") {
        dot("engineDot", false);
        $("engineStatus").textContent = "Detenido";
      }
    }
    if (message.type === "EFFECTIF_TRANSCRIPT_CLEAR") clear();
  });
  function clear() {
    ["client", "interpreter"].forEach(function (speaker) {
      $(speaker).innerHTML = '<p class="empty">Esperando voz…</p>';
      $(speaker + "Latency").textContent = "—";
    });
  }
  $("clear").addEventListener("click", clear);
  chrome.runtime.sendMessage({ type: "EFFECTIF_WORKER_PROBE" }, function (response) {
    dot("workerDot", !!(response && response.ok));
    $("workerStatus").textContent = response && response.ok ? "Conectado" : "Motor no iniciado";
  });
})();