importScripts("telemetry-db.js");
(function () {
  "use strict";

  /* Paquete preliminar privado por instrucción expresa del operador. */
  var GROQ_API_KEY = ""; /* Nunca incrustar credenciales en el paquete. */
  var GROQ_MODEL = "whisper-large-v3-turbo";
  var GROQ_USD_PER_AUDIO_HOUR = 0.04;
  var TRANSCRIPTION_MODULE_AVAILABLE = false;
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
    transcriptionMode: "auto",
    localWhisperModel: "large-v3-turbo",
    selectedMicrophoneId: "",
    selectedSpeakerId: "",
    instantPreviewEnabled: false,
    audioSafetyMode: true,
    opiRatePerMinute: 0.20,
    vriRatePerMinute: 0.25,
    currency: "USD",
    billingRule: "pro_rata_by_second_assumed",
    overlayEnabled: true,
    overlayCompact: true,
    usdMxnRate: null,
    exchangeRateDate: null,
    exchangeRateUpdatedAt: null,
    exchangeRateSource: "Frankfurter / European Central Bank",
    groqApiKey: "",
    groqModel: GROQ_MODEL,
    groqEstimatedUsdPerAudioHour: GROQ_USD_PER_AUDIO_HOUR
  };
  var offscreenCreation = null;
  var eventQueue = Promise.resolve();
  var stateQueue = Promise.resolve();
  var cachedConfig = Object.assign({}, DEFAULT_CONFIG);

  function uid() { return crypto.randomUUID(); }
  function iso() { return new Date().toISOString(); }
  function redactString(value) {
    return String(value || "")
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
      .replace(/\b(?:gsk|sk|pk)_[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_KEY]")
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[EMAIL]")
      .slice(0, 5000);
  }
  function scrub(value, depth) {
    if (depth > 8) return "[MAX_DEPTH]";
    if (typeof value === "string") return redactString(value);
    if (Array.isArray(value)) return value.slice(0, 500).map(function (item) { return scrub(item, depth + 1); });
    if (!value || typeof value !== "object") return value;
    var output = {};
    Object.keys(value).slice(0, 500).forEach(function (key) {
      if (/api.?key|authorization|cookie|password|secret|token/i.test(key)) output[key] = "[REDACTED]";
      else output[key] = scrub(value[key], depth + 1);
    });
    return output;
  }
  function localDay(value) {
    var date = value ? new Date(value) : new Date();
    if (!Number.isFinite(date.getTime())) date = new Date();
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
  }
  async function fetchJson(url) {
    var response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error("HTTP " + response.status + " en " + new URL(url).hostname);
    var text = await response.text();
    var data;
    try { data = JSON.parse(text); } catch (_) { throw new Error("JSON inválido en " + new URL(url).hostname); }
    return data;
  }
  async function refreshExchangeRate(reason) {
    var sources = [
      { url: "https://api.frankfurter.app/latest?from=USD&to=MXN", name: "Frankfurter / European Central Bank", read: function (data) { return { rate: Number(data && data.rates && data.rates.MXN), date: data && data.date }; } },
      { url: "https://api.frankfurter.dev/v1/latest?base=USD&symbols=MXN", name: "Frankfurter / European Central Bank", read: function (data) { return { rate: Number(data && data.rates && data.rates.MXN), date: data && data.date }; } },
      { url: "https://open.er-api.com/v6/latest/USD", name: "ExchangeRate-API", read: function (data) { return { rate: Number(data && data.rates && data.rates.MXN), date: data && data.time_last_update_utc ? new Date(data.time_last_update_utc).toISOString().slice(0, 10) : null }; } }
    ];
    var failures = [];
    for (var i = 0; i < sources.length; i += 1) {
      try {
        var data = await fetchJson(sources[i].url);
        var result = sources[i].read(data);
        if (!(result.rate > 0)) throw new Error("Respuesta sin tasa USD/MXN válida");
        var stored = await chrome.storage.local.get(["effectifConfig", "effectifState"]);
        var config = Object.assign({}, DEFAULT_CONFIG, stored.effectifConfig || {}, {
          usdMxnRate: result.rate, exchangeRateDate: result.date || localDay(),
          exchangeRateUpdatedAt: iso(), exchangeRateSource: sources[i].name
        });
        var state = Object.assign(baseState(), stored.effectifState || {}, { exchangeRateError: null });
        await chrome.storage.local.set({ effectifConfig: config, effectifState: state });
        record("EXCHANGE_RATE_UPDATED", { pair: "USD/MXN", rate: result.rate, rateDate: result.date || null, source: sources[i].name, reason: reason || "scheduled" }, "info", "background");
        return result.rate;
      } catch (error) { failures.push(String(error)); }
    }
    var saved = await chrome.storage.local.get(["effectifState"]);
    var message = failures.join(" | ") || "No hubo fuente disponible";
    var next = Object.assign(baseState(), saved.effectifState || {}, { exchangeRateError: message });
    await chrome.storage.local.set({ effectifState: next });
    record("EXCHANGE_RATE_ERROR", { pair: "USD/MXN", message: message, reason: reason || "scheduled" }, "warn", "background");
    throw new Error(message);
  }
  function baseState() {
    return {
      sessionStartedAt: null, sessionSegments: [], pendingCall: null,
      onlineStartedAt: null, onlineSegments: [],
      callStartedAt: null, callId: null, callModality: null,
      completedCalls: [], totalCalls: 0, dailyCalls: {},
      missedCalls: 0, dailyMissedCalls: {}, missedCallRecords: [],
      transcriptionActive: false, transcriptionTabId: null,
      transcriptionStatus: { phase: "idle", connected: false, engine: null },
      transcriptionMetrics: {
        segments: 0, localSegments: 0, groqSegments: 0,
        queueDepth: 0, averageLatencyMs: 0, groqEstimatedUsd: 0
      },
      lastConnectAt: null,
      exchangeRateError: null,
      groqUsage: {
        requests: 0, successes: 0, errors: 0, audioSeconds: 0,
        bytesSent: 0, charactersReturned: 0, totalLatencyMs: 0, estimatedUsd: 0
      },
      eventSequence: 0,
      telemetryHealth: { dbWrites: 0, dbErrors: 0, lastWriteAt: null, lastMaintenanceAt: null }
    };
  }
  function log(level, action, payload) {
    try {
      console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
        "[KHORA-EFFECTIF]", iso(), action, payload || {}
      );
    } catch (_) {}
  }
  function appendEvent(input, callback) {
    eventQueue = eventQueue.then(async function () {
      var stored = await chrome.storage.local.get(["effectifEvents", "effectifEventSequence", "effectifTelemetryHealth"]);
      var sequence = Number(stored.effectifEventSequence || 0) + 1;
      var event = Object.assign({
        schema: "khora-effectif-event/v3", id: uid(), sequence: sequence,
        timestamp: iso(), level: "info", source: "background",
        extensionVersion: chrome.runtime.getManifest().version
      }, input || {});
      delete event.apiKey; delete event.audio; delete event.text;
      if (event.payload) {
        delete event.payload.apiKey; delete event.payload.audio;
        delete event.payload.text; delete event.payload.dialogText;
      }
      event.ingestedAt = iso();
      event.ingestDelayMs = Math.max(0, Date.parse(event.ingestedAt) - Date.parse(event.timestamp || event.ingestedAt));
      event.payload = scrub(event.payload || {}, 0);
      event.context = scrub(event.context || {}, 0);
      event.url = redactString(event.url || "");
      var health = Object.assign({ dbWrites: 0, dbErrors: 0, lastWriteAt: null }, stored.effectifTelemetryHealth || {});
      try {
        await KhoraTelemetryDB.putEvent(event);
        health.dbWrites += 1;
        health.lastWriteAt = event.timestamp;
      } catch (dbError) {
        health.dbErrors += 1;
        health.lastError = String(dbError);
      }
      var events = Array.isArray(stored.effectifEvents) ? stored.effectifEvents : [];
      events.push(event);
      if (events.length > 500) events = events.slice(-500);
      await chrome.storage.local.set({
        effectifEvents: events, effectifLastEvent: event, effectifEventSequence: sequence,
        effectifTelemetryHealth: health
      });
      log(event.level, event.action || "EVENT", event.payload);
      if (callback) callback(event);
    }).catch(function (error) {
      console.error("[KHORA-EFFECTIF] EVENT_LOG_ERROR", String(error));
    });
  }
  function record(action, payload, level, source) {
    appendEvent({ action: action, payload: payload || {}, level: level || "info", source: source || "background" });
  }
  function mutateState(mutator) {
    stateQueue = stateQueue.then(async function () {
      var stored = await chrome.storage.local.get(["effectifState", "effectifConfig"]);
      var state = Object.assign(baseState(), stored.effectifState || {});
      var config = Object.assign({}, DEFAULT_CONFIG, stored.effectifConfig || {});
      await mutator(state, config);
      await chrome.storage.local.set({ effectifState: state });
      return state;
    }).catch(function (error) {
      record("STATE_MUTATION_ERROR", { message: String(error) }, "error", "background");
    });
    return stateQueue;
  }
  async function initialize() {
    var stored = await chrome.storage.local.get(["effectifConfig", "effectifState", "effectifEvents", "effectifTelemetryMigrated"]);
    var config = Object.assign({}, DEFAULT_CONFIG, stored.effectifConfig || {}, { transcriptionAvailable: false, transcriptionEnabled: false });
    cachedConfig = config;
    var state = Object.assign(baseState(), stored.effectifState || {}, {
      transcriptionActive: false,
      transcriptionTabId: null,
      transcriptionStatus: { phase: "dormant", connected: false, engine: null }
    });
    await chrome.storage.local.set({ effectifConfig: config, effectifState: state });
    try {
      if (!stored.effectifTelemetryMigrated && Array.isArray(stored.effectifEvents) && stored.effectifEvents.length) {
        await KhoraTelemetryDB.putEvents(stored.effectifEvents);
        await chrome.storage.local.set({ effectifTelemetryMigrated: true });
      }
      if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
      await KhoraTelemetryDB.putMetadata("schema", { version: 1, extensionVersion: chrome.runtime.getManifest().version });
    } catch (error) {
      state.telemetryHealth = Object.assign({}, state.telemetryHealth || {}, { lastError: String(error) });
      await chrome.storage.local.set({ effectifState: state });
    }
  }
  async function ensureOffscreen() {
    if (await chrome.offscreen.hasDocument()) return;
    if (!offscreenCreation) {
      offscreenCreation = chrome.offscreen.createDocument({
        url: "sound-offscreen.html",
        reasons: ["AUDIO_PLAYBACK"],
        justification: "Reproducir la alerta audible de Auto-Answer"
      }).finally(function () { offscreenCreation = null; });
    }
    await offscreenCreation;
  }
  async function playSound(volume) {
    await ensureOffscreen();
    var response = await chrome.runtime.sendMessage({
      target: "offscreen", type: "EFFECTIF_PLAY_SOUND",
      volume: Math.max(0, Math.min(1, Number(volume) || 0))
    });
    if (!response || !response.ok) throw new Error(response && response.error || "Sonido no confirmado");
  }
  function handleSession(event) {
    chrome.storage.local.get(["effectifState"], function (stored) {
      var state = Object.assign(baseState(), stored.effectifState || {});
      if (event.action === "PLATFORM_SESSION_STARTED" && !state.sessionStartedAt) {
        state.sessionStartedAt = event.timestamp;
      } else if (event.action === "PLATFORM_SESSION_ENDED" && state.sessionStartedAt) {
        state.sessionSegments = (state.sessionSegments || []).concat({
          startedAt: state.sessionStartedAt, endedAt: event.timestamp,
          durationSeconds: Math.max(0, (Date.parse(event.timestamp) - Date.parse(state.sessionStartedAt)) / 1000),
          reason: event.payload && event.payload.reason || "pagehide"
        }).slice(-1000);
        state.sessionStartedAt = null;
      }
      chrome.storage.local.set({ effectifState: state });
    });
  }
  function handleAvailability(event) {
    chrome.storage.local.get(["effectifState"], function (stored) {
      var state = Object.assign(baseState(), stored.effectifState || {});
      var next = event.payload && event.payload.state;
      if (next === "online" && !state.onlineStartedAt) {
        state.onlineStartedAt = event.timestamp;
      } else if (next === "offline" && state.onlineStartedAt) {
        state.onlineSegments = (state.onlineSegments || []).concat({
          startedAt: state.onlineStartedAt,
          endedAt: event.timestamp,
          durationSeconds: Math.max(0, (Date.parse(event.timestamp) - Date.parse(state.onlineStartedAt)) / 1000)
        }).slice(-1000);
        state.onlineStartedAt = null;
      }
      chrome.storage.local.set({ effectifState: state });
    });
  }
  function markIncoming(event) {
    mutateState(async function (state) {
      if (state.callId) return;
      var pendingAge = state.pendingCall && Date.parse(event.timestamp) - Date.parse(state.pendingCall.detectedAt);
      if (!state.pendingCall || !Number.isFinite(pendingAge) || pendingAge > 60000) {
        state.pendingCall = {
          id: uid(), detectedAt: event.timestamp,
          modality: event.payload && event.payload.modality || event.modality || "OPI",
          clickedAt: null
        };
      }
      chrome.alarms.create("effectif-pending-call", { when: Date.now() + 15000 });
    });
  }
  function startCall(event) {
    var callId = event.callId || event.payload && event.payload.callId;
    mutateState(async function (state) {
      if (!callId || state.callId === callId ||
          (state.completedCalls || []).some(function (call) { return call.callId === callId; })) return;
      state.callId = callId;
      state.callStartedAt = event.timestamp;
      state.callModality = state.pendingCall && state.pendingCall.modality || "OPI";
      state.pendingCall = null;
      chrome.alarms.clear("effectif-pending-call");
      state.totalCalls = Number(state.totalCalls || 0) + 1;
      var day = localDay(event.timestamp);
      state.dailyCalls = Object.assign({}, state.dailyCalls || {});
      state.dailyCalls[day] = Number(state.dailyCalls[day] || 0) + 1;
      record("CALL_TIMER_STARTED", { callId: callId, modality: state.callModality }, "info", "background");
    }).then(function (state) {
      if (state && state.callId === callId) {
        record("TRANSCRIPTION_MODULE_DORMANT", { callId: callId, availableInCurrentVersion: false }, "info", "background");
      }
    });
  }
  function alertOnConnect(event) {
    mutateState(async function (state, config) {
      state.lastConnectAt = event.timestamp;
      if (state.pendingCall) {
        state.pendingCall.clickedAt = event.timestamp;
      } else if (!state.callId) {
        state.pendingCall = {
          id: uid(), detectedAt: event.timestamp, clickedAt: event.timestamp,
          modality: event.payload && event.payload.modality || "OPI"
        };
      }
      chrome.alarms.create("effectif-pending-call", { when: Date.now() + 15000 });
      if (!config.soundEnabled) return;
      playSound(config.volume).then(function () {
        record("ALERT_SOUND_PLAYED", { detectedAt: event.timestamp }, "info", "offscreen");
      }).catch(function (error) {
        record("ALERT_SOUND_ERROR", { message: String(error) }, "error", "offscreen");
      });
    });
  }
  function closeCall(source, platformSeconds, sendResponse) {
    mutateState(async function (state, config) {
      if (!state.callStartedAt || !state.callId) {
        if (sendResponse) sendResponse({ ok: false, error: "No hay llamada activa" });
        return;
      }
      var endedAt = iso();
      var observedSeconds = Math.max(0, (Date.parse(endedAt) - Date.parse(state.callStartedAt)) / 1000);
      var hasPlatformSeconds = Number.isFinite(platformSeconds) && platformSeconds >= 0;
      var billableSeconds = hasPlatformSeconds ? platformSeconds : observedSeconds;
      var modality = state.callModality || "OPI";
      var rate = modality === "VRI" ? config.vriRatePerMinute : config.opiRatePerMinute;
      var call = {
        callId: state.callId, startedAt: state.callStartedAt, endedAt: endedAt,
        modality: modality, observedSeconds: Math.round(observedSeconds * 1000) / 1000,
        platformSeconds: hasPlatformSeconds ? platformSeconds : null,
        billableSecondsAssumed: Math.round(billableSeconds * 1000) / 1000,
        ratePerMinute: rate, estimatedRevenue: Math.round((billableSeconds / 60) * rate * 10000) / 10000,
        currency: config.currency, billingRule: config.billingRule, endSource: source
      };
      state.completedCalls = (state.completedCalls || []).concat(call).slice(-1000);
      if (state.transcriptionActive) {
        chrome.runtime.sendMessage({ target: "offscreen", type: "EFFECTIF_STOP_LOCAL_TRANSCRIPTION", reason: "call-ended" }).catch(function () {});
        state.transcriptionActive = false;
        state.transcriptionTabId = null;
        state.transcriptionStatus = { phase: "stopped", connected: true, engine: null };
        chrome.runtime.sendMessage({ type: "EFFECTIF_TRANSCRIPT_CLEAR" }).catch(function () {});
      }
      state.callStartedAt = null; state.callId = null; state.callModality = null;
      record("CALL_TIMER_STOPPED", call, "info", source);
      if (sendResponse) sendResponse({ ok: true, call: call });
    });
  }
  async function startTranscription(tabId, callId, sendResponse) {
    try {
      var stored = await chrome.storage.local.get(["effectifConfig"]);
      var config = Object.assign({}, DEFAULT_CONFIG, stored.effectifConfig || {});
      if (!config.transcriptionAvailable || !config.transcriptionEnabled) {
        if (sendResponse) sendResponse({ ok: false, error: "Módulo reservado: no disponible en esta versión" });
        return;
      }
      await ensureOffscreen();
      var response = await chrome.runtime.sendMessage({
        target: "offscreen", type: "EFFECTIF_START_LOCAL_TRANSCRIPTION",
        tabId: tabId, callId: callId,
        apiKey: config.groqApiKey || GROQ_API_KEY,
        mode: config.transcriptionMode || "auto",
        localModel: config.localWhisperModel || "large-v3-turbo",
        groqModel: config.groqModel || GROQ_MODEL,
        microphoneId: config.selectedMicrophoneId || "",
        speakerId: config.selectedSpeakerId || ""
      });
      if (!response || !response.ok) throw new Error(response && response.error || "Motor no iniciado");
      await mutateState(async function (state) {
        state.transcriptionActive = true;
        state.transcriptionTabId = tabId;
        state.transcriptionStatus = {
          phase: "starting", connected: true, engine: null,
          platformAudioModified: false
        };
      });
      record("TRANSCRIPTION_STARTED", {
        tabId: tabId, callId: callId, mode: config.transcriptionMode,
        platformAudioAccess: false, platformAudioModified: false
      }, "info", "background");
      if (sendResponse) sendResponse({ ok: true });
    } catch (error) {
      record("TRANSCRIPTION_START_ERROR", {
        tabId: tabId, callId: callId, message: String(error),
        platformAudioModified: false
      }, "error", "background");
      if (sendResponse) sendResponse({ ok: false, error: String(error) });
    }
  }
  function savePlatformSnapshot(message, sender, sendResponse) {
    var snapshot = message.snapshot || {};
    if (!sender.tab || !/^https:\/\/app\.cloudinterpreter\.com\//.test(sender.tab.url || "")) {
      sendResponse({ ok: false, error: "Origen no autorizado" });
      return;
    }
    chrome.storage.local.get(["effectifPlatformMirror"], function (stored) {
      var mirror = Object.assign({}, stored.effectifPlatformMirror || {});
      var key = String(snapshot.key || "other").slice(0, 80);
      mirror[key] = Object.assign({}, snapshot, {
        tabId: sender.tab.id,
        capturedAt: snapshot.capturedAt || iso()
      });
      KhoraTelemetryDB.putSnapshot(Object.assign({}, snapshot, { tabId: sender.tab ? sender.tab.id : null }))
        .catch(function (error) { record("TELEMETRY_SNAPSHOT_DB_ERROR", { message: String(error) }, "error", "background"); });
      chrome.storage.local.set({ effectifPlatformMirror: mirror }, function () {
        record("PLATFORM_MIRROR_UPDATED", {
          key: key,
          route: snapshot.route || "",
          summaryFields: Object.keys(snapshot.summary || {}).length,
          tableCount: Array.isArray(snapshot.tables) ? snapshot.tables.length : 0,
          visibleLines: Array.isArray(snapshot.lines) ? snapshot.lines.length : 0
        }, "info", "content");
        sendResponse({ ok: true });
      });
    });
  }
  function updateGroqUsage(message) {
    chrome.storage.local.get(["effectifState", "effectifConfig"], function (stored) {
      var state = Object.assign(baseState(), stored.effectifState || {});
      var config = Object.assign({}, DEFAULT_CONFIG, stored.effectifConfig || {});
      var usage = Object.assign({}, baseState().groqUsage, state.groqUsage || {});
      usage.requests += 1;
      usage.audioSeconds += Number(message.audioSeconds || 0);
      usage.bytesSent += Number(message.bytesSent || 0);
      usage.totalLatencyMs += Number(message.latencyMs || 0);
      if (message.ok) {
        usage.successes += 1;
        usage.charactersReturned += Number(message.characters || 0);
      } else usage.errors += 1;
      usage.estimatedUsd = Math.round(
        (usage.audioSeconds / 3600) * Number(config.groqEstimatedUsdPerAudioHour || 0) * 1000000
      ) / 1000000;
      state.groqUsage = usage;
      chrome.storage.local.set({ effectifState: state });
      record(message.ok ? "GROQ_TRANSCRIPTION_OK" : "GROQ_TRANSCRIPTION_ERROR", {
        speaker: message.speaker, audioSeconds: message.audioSeconds,
        bytesSent: message.bytesSent, latencyMs: message.latencyMs,
        characters: message.characters || 0, httpStatus: message.httpStatus || null,
        error: message.ok ? undefined : message.error, estimatedTotalUsd: usage.estimatedUsd
      }, message.ok ? "info" : "error", "offscreen");
    });
  }

  chrome.runtime.onInstalled.addListener(function (details) {
    chrome.offscreen.closeDocument().catch(function () {});
    initialize().catch(function (error) { console.error("[KHORA-EFFECTIF] INIT_ERROR", error); });
    chrome.alarms.create("effectif-exchange-rate", { delayInMinutes: 0.1, periodInMinutes: 60 });
    chrome.alarms.create("effectif-telemetry-maintenance", { delayInMinutes: 1, periodInMinutes: 60 });
    refreshExchangeRate("installed").catch(function () {});
    if (details && details.reason === "update" &&
        /^0\.4\./.test(String(details.previousVersion || ""))) {
      chrome.storage.local.get(["effectifConfig"], function (stored) {
        chrome.storage.local.set({
          effectifConfig: Object.assign({}, DEFAULT_CONFIG, stored.effectifConfig || {}, {
            transcriptionAvailable: false,
            transcriptionEnabled: false
          })
        });
        record("V050_TRANSCRIPTION_MIGRATION_ENABLED", {
          previousVersion: details.previousVersion,
          platformAudioAccess: false
        }, "info", "background");
      });
    }
  });
  chrome.runtime.onStartup.addListener(function () {
    record("EXTENSION_RUNTIME_STARTED", { manifestVersion: chrome.runtime.getManifest().manifest_version }, "info", "runtime");
  });
  chrome.runtime.onSuspend.addListener(function () {
    log("info", "EXTENSION_RUNTIME_SUSPENDING", { pendingNetworkRequests: networkRequests ? networkRequests.size : 0 });
  });
  initialize().catch(function (error) { console.error("[KHORA-EFFECTIF] INIT_ERROR", error); });
  chrome.alarms.create("effectif-exchange-rate", { delayInMinutes: 0.1, periodInMinutes: 60 });
  chrome.alarms.create("effectif-telemetry-maintenance", { delayInMinutes: 1, periodInMinutes: 60 });
  refreshExchangeRate("startup").catch(function () {});
  chrome.alarms.onAlarm.addListener(function (alarm) {
    if (!alarm) return;
    if (alarm.name === "effectif-exchange-rate") { refreshExchangeRate("alarm").catch(function () {}); return; }
    if (alarm.name === "effectif-telemetry-maintenance") {
      chrome.storage.local.get(["effectifConfig"], async function (stored) {
        var config = Object.assign({}, DEFAULT_CONFIG, stored.effectifConfig || {});
        try {
          var pruned = await KhoraTelemetryDB.prune({ retentionDays: config.telemetryRetentionDays, maxEvents: config.telemetryMaxEvents });
          var stats = await KhoraTelemetryDB.stats();
          var health = Object.assign({}, (await chrome.storage.local.get(["effectifTelemetryHealth"])).effectifTelemetryHealth || {}, {
            lastMaintenanceAt: iso(), stats: stats
          });
          await chrome.storage.local.set({ effectifTelemetryHealth: health });
          record("TELEMETRY_MAINTENANCE", { pruned: pruned, stats: stats }, "info", "background");
        } catch (error) { record("TELEMETRY_MAINTENANCE_ERROR", { message: String(error) }, "error", "background"); }
      });
      return;
    }
    if (alarm.name !== "effectif-pending-call") return;
    mutateState(async function (state) {
      if (!state.pendingCall || state.callId) return;
      var clickedAt = state.pendingCall.clickedAt || (
        state.lastConnectAt &&
        Math.abs(Date.parse(state.lastConnectAt) - Date.parse(state.pendingCall.detectedAt)) <= 2000
          ? state.lastConnectAt : null
      );
      var missed = {
        id: state.pendingCall.id || uid(),
        detectedAt: state.pendingCall.detectedAt,
        clickedAt: clickedAt,
        classifiedAt: iso(),
        modality: state.pendingCall.modality || "OPI",
        reason: clickedAt ? "connect_clicked_no_call_route" : "dialog_expired_before_click"
      };
      state.missedCalls = Number(state.missedCalls || 0) + 1;
      state.dailyMissedCalls = Object.assign({}, state.dailyMissedCalls || {});
      var day = localDay(missed.detectedAt || iso());
      state.dailyMissedCalls[day] = Number(state.dailyMissedCalls[day] || 0) + 1;
      state.missedCallRecords = (state.missedCallRecords || []).concat(missed).slice(-1000);
      state.pendingCall = null;
      record("MISSED_CALL_CLASSIFIED", missed, "warn", "alarm");
    });
  });
  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || message.target === "offscreen") return false;
    if (message.type === "EFFECTIF_EVENT") {
      var event = Object.assign({
        timestamp: iso(), tabId: sender.tab ? sender.tab.id : null,
        source: "content", level: "info"
      }, message.event || {});
      appendEvent(event, function () { sendResponse({ ok: true }); });
      if (event.action === "PLATFORM_SESSION_STARTED" || event.action === "PLATFORM_SESSION_ENDED") handleSession(event);
      if (event.action === "AVAILABILITY_STATE") handleAvailability(event);
      if (event.action === "INCOMING_DIALOG_DETECTED") markIncoming(event);
      if (event.action === "CONNECT_CLICKED") alertOnConnect(event);
      if (event.action === "CALL_ROUTE_ENTERED") startCall(event);
      if (event.action === "CALL_END_CLICKED") {
        var clickedSeconds = event.payload && event.payload.platformSeconds;
        closeCall("end-button", typeof clickedSeconds === "number" ? clickedSeconds : NaN, null);
      }
      if (event.action === "CALL_ROUTE_ENDED") {
        var seconds = event.payload && event.payload.platformSeconds;
        closeCall("route", typeof seconds === "number" ? seconds : NaN, null);
      }
      return true;
    }
    if (message.type === "EFFECTIF_TELEMETRY_STATS") {
      KhoraTelemetryDB.stats().then(function (stats) { sendResponse({ ok: true, stats: stats }); })
        .catch(function (error) { sendResponse({ ok: false, error: String(error) }); });
      return true;
    }
    if (message.type === "EFFECTIF_REFRESH_EXCHANGE_RATE") {
      refreshExchangeRate("manual").then(function (rate) { sendResponse({ ok: true, rate: rate }); })
        .catch(function (error) { sendResponse({ ok: false, error: String(error) }); });
      return true;
    }
    if (message.type === "EFFECTIF_TEST_SOUND") {
      playSound(message.volume).then(function () {
        record("ALERT_SOUND_TESTED", {}, "info", "popup"); sendResponse({ ok: true });
      }).catch(function (error) { sendResponse({ ok: false, error: String(error) }); });
      return true;
    }
    if (message.type === "EFFECTIF_PLATFORM_SNAPSHOT") {
      savePlatformSnapshot(message, sender, sendResponse); return true;
    }
    if (message.type === "EFFECTIF_END_CALL") {
      closeCall("manual", NaN, sendResponse); return true;
    }
    if (message.type === "EFFECTIF_START_TRANSCRIPTION") {
      sendResponse({ ok: false, error: "Módulo reservado: no disponible en esta versión" }); return false;
    }
    if (message.type === "EFFECTIF_STOP_TRANSCRIPTION") {
      sendResponse({ ok: false, error: "Módulo reservado: no disponible en esta versión" }); return false;
    }
    if (TRANSCRIPTION_MODULE_AVAILABLE && message.type === "EFFECTIF_TRANSCRIPT_SEGMENT") {
      var segment = message.payload || {};
      record("TRANSCRIPT_SEGMENT_RENDERED", {
        speaker: segment.speaker, engine: segment.engine,
        latencyMs: segment.latencyMs, characters: String(segment.text || "").length,
        platformAudioModified: false
      }, "info", "worker");
      sendResponse({ ok: true }); return false;
    }
    if (TRANSCRIPTION_MODULE_AVAILABLE && message.type === "EFFECTIF_TRANSCRIPTION_STATUS") {
      var status = message.payload || {};
      mutateState(async function (state) {
        state.transcriptionStatus = Object.assign({}, state.transcriptionStatus || {}, status);
      });
      record("TRANSCRIPTION_STATUS", {
        phase: status.phase, connected: status.connected,
        engine: status.engine, error: status.error,
        platformAudioModified: false
      }, status.error ? "warn" : "info", "worker");
      sendResponse({ ok: true }); return false;
    }
    if (TRANSCRIPTION_MODULE_AVAILABLE && message.type === "EFFECTIF_TRANSCRIPTION_METRICS") {
      var workerMetrics = message.payload || {};
      mutateState(async function (state) {
        state.transcriptionMetrics = Object.assign({}, state.transcriptionMetrics || {}, workerMetrics);
      });
      record("TRANSCRIPTION_METRICS", {
        segments: workerMetrics.segments, localSegments: workerMetrics.localSegments,
        groqSegments: workerMetrics.groqSegments, queueDepth: workerMetrics.queueDepth,
        averageLatencyMs: workerMetrics.averageLatencyMs,
        groqEstimatedUsd: workerMetrics.groqEstimatedUsd,
        platformAudioModified: false
      }, "info", "worker");
      sendResponse({ ok: true }); return false;
    }
    if (message.type === "EFFECTIF_WORKER_PROBE") {
      sendResponse({ ok: false, error: "Módulo reservado: no disponible en esta versión" }); return false;
    }
    if (message.type === "EFFECTIF_TEST_TRANSCRIPTION") {
      sendResponse({ ok: false, error: "Módulo reservado: no disponible en esta versión" }); return false;
    }
    if (TRANSCRIPTION_MODULE_AVAILABLE && message.type === "EFFECTIF_TEST_TRANSCRIPTION_DORMANT") {
      chrome.storage.local.get(["effectifConfig"], function (stored) {
        var config = Object.assign({}, DEFAULT_CONFIG, stored.effectifConfig || {});
        ensureOffscreen().then(function () {
          return chrome.runtime.sendMessage({
            target: "offscreen", type: "EFFECTIF_TEST_LOCAL_TRANSCRIPTION",
            apiKey: config.groqApiKey || GROQ_API_KEY,
            mode: config.transcriptionMode || "auto",
            localModel: config.localWhisperModel || "large-v3-turbo",
            groqModel: config.groqModel || GROQ_MODEL,
            microphoneId: config.selectedMicrophoneId || "",
            speakerId: config.selectedSpeakerId || ""
          });
        }).then(sendResponse).catch(function (error) {
          sendResponse({ ok: false, error: String(error) });
        });
      });
      return true;
    }
    if (message.type === "EFFECTIF_OPEN_SIDE_PANEL") {
      sendResponse({ ok: false, error: "Módulo reservado: no disponible en esta versión" }); return false;
    }
    if (TRANSCRIPTION_MODULE_AVAILABLE && message.type === "EFFECTIF_GROQ_USAGE") {
      updateGroqUsage(message); sendResponse({ ok: true }); return false;
    }
    return false;
  });
  var networkRequests = new Map();
  function sanitizedRequestUrl(raw) {
    try {
      var url = new URL(raw);
      return url.origin + url.pathname
        .replace(/\/call\/[^/]+/g, "/call/<ID>")
        .replace(/\/profile\/[^/]+/g, "/profile/<ID>")
        .slice(0, 500);
    } catch (_) { return "[INVALID_URL]"; }
  }
  chrome.webRequest.onBeforeRequest.addListener(function (details) {
    if (!cachedConfig.observationEnabled || !cachedConfig.networkTelemetryEnabled) return;
    networkRequests.set(details.requestId, { at: Date.now(), method: details.method, type: details.type, url: sanitizedRequestUrl(details.url), tabId: details.tabId });
    if (networkRequests.size > 5000) networkRequests.delete(networkRequests.keys().next().value);
  }, { urls: ["https://app.cloudinterpreter.com/*"] });
  chrome.webRequest.onCompleted.addListener(function (details) {
    var started = networkRequests.get(details.requestId); networkRequests.delete(details.requestId);
    if (!started) return;
    record("NETWORK_REQUEST_COMPLETED", {
      method: started.method, type: started.type, url: started.url, tabId: started.tabId,
      statusCode: details.statusCode, fromCache: !!details.fromCache,
      durationMs: Math.max(0, Date.now() - started.at)
    }, details.statusCode >= 400 ? "warn" : "info", "webRequest");
  }, { urls: ["https://app.cloudinterpreter.com/*"] });
  chrome.webRequest.onErrorOccurred.addListener(function (details) {
    var started = networkRequests.get(details.requestId); networkRequests.delete(details.requestId);
    if (!started) return;
    record("NETWORK_REQUEST_ERROR", { method: started.method, type: started.type, url: started.url, tabId: started.tabId, error: details.error, durationMs: Math.max(0, Date.now() - started.at) }, "warn", "webRequest");
  }, { urls: ["https://app.cloudinterpreter.com/*"] });
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === "local" && changes.effectifConfig) {
      cachedConfig = Object.assign({}, DEFAULT_CONFIG, changes.effectifConfig.newValue || {});
    }
  });

  chrome.commands.onCommand.addListener(function (command) {
    if (command !== "toggle-auto-answer") return;
    chrome.storage.local.get(["effectifConfig"], function (stored) {
      var config = Object.assign({}, DEFAULT_CONFIG, stored.effectifConfig || {});
      config.autoAnswerEnabled = !config.autoAnswerEnabled;
      chrome.storage.local.set({ effectifConfig: config });
      record(config.autoAnswerEnabled ? "AUTO_ANSWER_ENABLED" : "AUTO_ANSWER_DISABLED", {}, "info", "keyboard");
    });
  });
  function routeShape(url) {
    try {
      return new URL(url).pathname
        .replace(/^\/call\/[^/]+/, "/call/<ID>")
        .replace(/^\/profile\/[^/]+/, "/profile/<ID>");
    } catch (_) { return ""; }
  }
  chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
    var url = changeInfo.url || tab.url || "";
    if (!/^https:\/\/app\.cloudinterpreter\.com\//.test(url)) return;
    if (changeInfo.url || changeInfo.status === "complete") {
      record("TAB_LIFECYCLE", {
        tabId: tabId, status: changeInfo.status || "url-change",
        route: routeShape(url), active: !!tab.active
      }, "info", "tabs");
    }
  });
  chrome.tabs.onRemoved.addListener(function (tabId) {
    chrome.storage.local.get(["effectifState"], function (stored) {
      var state = Object.assign(baseState(), stored.effectifState || {});
      if (state.transcriptionTabId === tabId) {
        chrome.runtime.sendMessage({
          target: "offscreen", type: "EFFECTIF_STOP_LOCAL_TRANSCRIPTION", reason: "tab-closed"
        }).catch(function () {});
        state.transcriptionActive = false;
        state.transcriptionTabId = null;
        chrome.storage.local.set({ effectifState: state });
        record("TRANSCRIPTION_TAB_CLOSED", { tabId: tabId }, "warn", "tabs");
      }
    });
  });
})();