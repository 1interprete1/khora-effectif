(function () {
  "use strict";
  var DEFAULT_CONFIG = {
    targetHost: "app.cloudinterpreter.com",
    autoAnswerEnabled: true,
    observationEnabled: true,
    networkTelemetryEnabled: true,
    performanceTelemetryEnabled: true,
    interactionTelemetryEnabled: true,
    telemetryRetentionDays: 180,
    telemetryMaxEvents: 250000,
    telemetryHeartbeatSeconds: 30,
    soundEnabled: true,
    volume: 0.8,
    transcriptionAvailable: false,
    transcriptionEnabled: false,
    opiRatePerMinute: 0.20,
    vriRatePerMinute: 0.25,
    currency: "USD",
    billingRule: "pro_rata_by_second_assumed",
    overlayEnabled: true,
    overlayCompact: true,
    usdMxnRate: null,
    exchangeRateDate: null,
    exchangeRateUpdatedAt: null
  };
  var config = Object.assign({}, DEFAULT_CONFIG);
  var state = {};
  var mirror = {};
  var $ = function (id) { return document.getElementById(id); };
  function status(text, error) {
    $("status").textContent = text;
    $("status").style.color = error ? "#ff8b8b" : "#76d7a5";
  }
  function save(patch) {
    config = Object.assign({}, config, patch);
    chrome.storage.local.set({ effectifConfig: config }, function () {
      render();
      status("Configuración guardada");
    });
  }
  function localDay(value) {
    var date = value ? new Date(value) : new Date();
    if (!Number.isFinite(date.getTime())) date = new Date();
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
  }
  function duration(start) {
    if (!start) return "00:00:00";
    var seconds = Math.max(0, Math.floor((Date.now() - Date.parse(start)) / 1000));
    var hours = Math.floor(seconds / 3600);
    var minutes = Math.floor((seconds % 3600) / 60);
    var rest = seconds % 60;
    return [hours, minutes, rest].map(function (value) { return String(value).padStart(2, "0"); }).join(":");
  }
  function render() {
    $("enabled").checked = !!config.autoAnswerEnabled;
    $("observation").checked = !!config.observationEnabled;
    $("networkTelemetryEnabled").checked = !!config.networkTelemetryEnabled;
    $("performanceTelemetryEnabled").checked = !!config.performanceTelemetryEnabled;
    $("interactionTelemetryEnabled").checked = !!config.interactionTelemetryEnabled;
    $("telemetryRetentionDays").value = String(config.telemetryRetentionDays || 180);
    $("telemetryMaxEvents").value = String(config.telemetryMaxEvents || 250000);
    $("telemetryHeartbeatSeconds").value = String(config.telemetryHeartbeatSeconds || 30);
    $("overlayEnabled").checked = !!config.overlayEnabled;
    $("volume").value = String(config.volume);
    $("volumeValue").textContent = Math.round(config.volume * 100) + "%";
    $("sessionTimer").textContent = duration(state.sessionStartedAt);
    $("onlineTimer").textContent = duration(state.onlineStartedAt);
    $("callTimer").textContent = duration(state.callStartedAt);
    $("endCall").disabled = !state.callStartedAt;
    var today = localDay();
    var completed = Array.isArray(state.completedCalls) ? state.completedCalls.filter(function (call) {
      return localDay(call.startedAt || call.endedAt) === today;
    }) : [];
    $("callsToday").textContent = String(state.dailyCalls && state.dailyCalls[today] || 0);
    $("missedToday").textContent = String(state.dailyMissedCalls && state.dailyMissedCalls[today] || 0);
    $("minutesToday").textContent = (completed.reduce(function (sum, call) {
      return sum + Number(call.billableSecondsAssumed || call.observedSeconds || 0);
    }, 0) / 60).toFixed(1);
    var completedUsd = completed.reduce(function (sum, call) {
      return sum + Number(call.estimatedRevenue || call.estimatedAmount || 0);
    }, 0);
    var liveSeconds = state.callStartedAt ? Math.max(0, (Date.now() - Date.parse(state.callStartedAt)) / 1000) : 0;
    var liveRate = state.callModality === "VRI" ? Number(config.vriRatePerMinute || 0.25) : Number(config.opiRatePerMinute || 0.20);
    var earnedUsd = completedUsd + liveSeconds / 60 * liveRate;
    var fx = Number(config.usdMxnRate || 0);
    $("earnedToday").textContent = "US$" + earnedUsd.toFixed(4);
    $("earnedTodayMxn").textContent = fx > 0 ? "MX$" + (earnedUsd * fx).toFixed(4) : "Sin tasa";
    $("exchangeRate").textContent = fx > 0 ? "$" + fx.toFixed(4) : "No disponible";
    $("exchangeMeta").textContent = fx > 0
      ? "Fecha de referencia: " + (config.exchangeRateDate || "última disponible")
      : ((state.exchangeRateError || "Reintentando automáticamente").slice(0, 90));
    renderOfficial();
  }
  $("enabled").addEventListener("change", function () {
    save({ autoAnswerEnabled: this.checked });
  });
  $("observation").addEventListener("change", function () { save({ observationEnabled: this.checked }); });
  $("networkTelemetryEnabled").addEventListener("change", function () { save({ networkTelemetryEnabled: this.checked }); });
  $("performanceTelemetryEnabled").addEventListener("change", function () { save({ performanceTelemetryEnabled: this.checked }); });
  $("interactionTelemetryEnabled").addEventListener("change", function () { save({ interactionTelemetryEnabled: this.checked }); });
  $("telemetryRetentionDays").addEventListener("change", function () { save({ telemetryRetentionDays: Math.max(7, Math.min(730, Number(this.value) || 180)) }); });
  $("telemetryMaxEvents").addEventListener("change", function () { save({ telemetryMaxEvents: Math.max(1000, Math.min(1000000, Number(this.value) || 250000)) }); });
  $("telemetryHeartbeatSeconds").addEventListener("change", function () { save({ telemetryHeartbeatSeconds: Math.max(10, Math.min(300, Number(this.value) || 30)) }); });
  $("overlayEnabled").addEventListener("change", function () { save({ overlayEnabled: this.checked }); });
  $("volume").addEventListener("input", function () {
    config.volume = Number(this.value);
    $("volumeValue").textContent = Math.round(config.volume * 100) + "%";
  });
  $("volume").addEventListener("change", function () { save({ volume: Number(this.value) }); });
  function renderOfficial() {
    var host = $("officialData");
    if (!host) return;
    var order = ["statistics", "pre-scheduled", "appointments", "finance", "profile"];
    var labels = {
      statistics: "Statistics · On-Demand",
      "pre-scheduled": "Statistics · Pre-Scheduled",
      appointments: "Appointments", finance: "Finance", profile: "Profile"
    };
    var cards = order.filter(function (key) { return mirror[key]; }).map(function (key) {
      var item = mirror[key];
      var summary = item.summary || {};
      var summaryText = [
        summary.earned ? "Ganado " + summary.earned : "",
        summary.callLength ? "Tiempo " + summary.callLength : "",
        summary.callCount ? "Llamadas " + summary.callCount : ""
      ].filter(Boolean).join(" · ");
      var rows = (item.tables || []).reduce(function (sum, table) {
        return sum + Math.max(0, (table.rows || []).length - 1);
      }, 0);
      var tables = (item.tables || []).map(function (table) {
        return '<div class="table-wrap"><table>' + (table.rows || []).map(function (row, rowIndex) {
          var tag = rowIndex === 0 ? "th" : "td";
          return "<tr>" + row.map(function (cell) {
            return "<" + tag + ">" + escapeHtml(cell) + "</" + tag + ">";
          }).join("") + "</tr>";
        }).join("") + "</table></div>";
      }).join("");
      var preview = (item.lines || []).slice(0, 8).join(" · ");
      return '<details><summary><b>' + labels[key] + '</b><span>' +
        new Date(item.capturedAt).toLocaleTimeString() + '</span></summary>' +
        (summaryText ? '<p class="official-summary">' + escapeHtml(summaryText) + '</p>' : '') +
        (rows ? '<small>' + rows + ' filas visibles sincronizadas.</small>' : '') +
        tables +
        '<p class="preview">' + escapeHtml(preview || "Sin contenido visible") + '</p></details>';
    });
    host.innerHTML = cards.length ? cards.join("") : "<small>Aún no hay pantallas sincronizadas.</small>";
  }
  function escapeHtml(value) {
    return String(value || "").replace(/[&<>"']/g, function (character) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character];
    });
  }
  $("refresh").addEventListener("click", function () {
    chrome.tabs.query({ url: "https://app.cloudinterpreter.com/*" }, function (tabs) {
      var pending = tabs.length;
      if (!pending) { status("No hay pestañas de Effectif abiertas", true); return; }
      tabs.forEach(function (tab) {
        chrome.tabs.sendMessage(tab.id, { type: "EFFECTIF_REQUEST_PLATFORM_SNAPSHOT" }, function () {
          pending -= 1;
          if (!pending) status("Pantallas abiertas actualizadas");
        });
      });
    });
  });
  document.querySelectorAll("[data-open]").forEach(function (button) {
    button.addEventListener("click", function () {
      chrome.tabs.query({ url: "https://app.cloudinterpreter.com/profile/*" }, function (tabs) {
        var profile = tabs.find(function (tab) { return /\/profile\/[^/]+/.test(tab.url || ""); });
        if (!profile) { status("Abre primero My Profile", true); return; }
        var match = profile.url.match(/^(https:\/\/app\.cloudinterpreter\.com\/profile\/[^/?#]+)/);
        if (!match) return;
        chrome.tabs.create({ url: match[1] + "/" + button.dataset.open });
      });
    });
  });
  $("refreshExchange").addEventListener("click", function () {
    status("Actualizando tipo de cambio…");
    chrome.runtime.sendMessage({ type: "EFFECTIF_REFRESH_EXCHANGE_RATE" }, function (response) {
      status(response && response.ok ? "Tipo de cambio actualizado" : ((response && response.error) || "No se pudo actualizar"), !(response && response.ok));
    });
  });
  $("sound").addEventListener("click", function () {
    chrome.runtime.sendMessage({ type: "EFFECTIF_TEST_SOUND", volume: config.volume }, function (response) {
      status(response && response.ok ? "Sonido reproducido" : "No se pudo reproducir el sonido", !(response && response.ok));
    });
  });
  $("endCall").addEventListener("click", function () {
    chrome.runtime.sendMessage({ type: "EFFECTIF_END_CALL" }, function (response) {
      if (response && response.ok) status("Llamada guardada");
      else status((response && response.error) || "No se pudo cerrar", true);
    });
  });
  function formatBytes(bytes) {
    if (!Number(bytes)) return "0 B";
    var units = ["B", "KB", "MB", "GB"]; var index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return (bytes / Math.pow(1024, index)).toFixed(index ? 1 : 0) + " " + units[index];
  }
  async function refreshTelemetryStats() {
    try {
      var stats = await KhoraTelemetryDB.stats();
      $("telemetryCount").textContent = stats.events.toLocaleString("es-MX") + " eventos";
      $("telemetryMeta").textContent = stats.snapshots.toLocaleString("es-MX") + " snapshots · " + formatBytes(stats.usageBytes) + " usados · desde " + (stats.oldestEventAt ? new Date(stats.oldestEventAt).toLocaleString() : "ahora");
    } catch (error) {
      $("telemetryCount").textContent = "Base no disponible";
      $("telemetryMeta").textContent = String(error);
    }
  }
  $("export").addEventListener("click", async function () {
    var button = this; button.disabled = true; status("Leyendo historial persistente…");
    try {
      var stored = await chrome.storage.local.get(["effectifConfig", "effectifState", "effectifPlatformMirror"]);
      var results = await Promise.all([KhoraTelemetryDB.getEvents(), KhoraTelemetryDB.getSnapshots(), KhoraTelemetryDB.stats()]);
      var payload = {
        schema: "khora-effectif-observation/v2", exportedAt: new Date().toISOString(),
        config: Object.assign({}, stored.effectifConfig || {}, { groqApiKey: stored.effectifConfig && stored.effectifConfig.groqApiKey ? "[REDACTED]" : "" }),
        state: stored.effectifState || {}, telemetry: results[2],
        events: results[0], platformSnapshots: results[1], platformMirror: stored.effectifPlatformMirror || {}
      };
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      var link = document.createElement("a"); link.href = URL.createObjectURL(blob);
      link.download = "effectif-observacion-persistente-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json";
      link.click(); setTimeout(function () { URL.revokeObjectURL(link.href); }, 1000);
      status("Exportados " + results[0].length.toLocaleString("es-MX") + " eventos y " + results[1].length.toLocaleString("es-MX") + " snapshots");
    } catch (error) { status("No se pudo exportar: " + String(error), true); }
    finally { button.disabled = false; }
  });
  chrome.storage.local.get(["effectifConfig", "effectifState", "effectifLastEvent", "effectifPlatformMirror"], function (stored) {
    config = Object.assign({}, DEFAULT_CONFIG, stored.effectifConfig || {});
    state = stored.effectifState || {};
    mirror = stored.effectifPlatformMirror || {};
    var last = stored.effectifLastEvent;
    $("last").textContent = last ? new Date(last.timestamp).toLocaleTimeString() + " — " + last.action : "Sin eventos";
    render();
    refreshTelemetryStats();
  });
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== "local") return;
    if (changes.effectifConfig) config = Object.assign({}, DEFAULT_CONFIG, changes.effectifConfig.newValue || {});
    if (changes.effectifState) state = changes.effectifState.newValue || {};
    if (changes.effectifPlatformMirror) mirror = changes.effectifPlatformMirror.newValue || {};
    if (changes.effectifLastEvent && changes.effectifLastEvent.newValue) {
      var last = changes.effectifLastEvent.newValue;
      $("last").textContent = new Date(last.timestamp).toLocaleTimeString() + " — " + last.action;
    }
    render();
  });
  setInterval(render, 250);
  setInterval(refreshTelemetryStats, 10000);
})();