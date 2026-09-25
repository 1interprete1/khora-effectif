(function () {
  "use strict";
  var worker = new Worker("socket-worker.js");
  var connected = false;
  var waiters = [];

  function playTone(volume) {
    var context = new AudioContext();
    var oscillator = context.createOscillator();
    var gain = context.createGain();
    var start = context.currentTime;
    oscillator.frequency.setValueAtTime(880, start);
    oscillator.frequency.setValueAtTime(1174.66, start + 0.12);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, volume * 0.38), start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.37);
    oscillator.onended = function () { context.close(); };
  }
  function relay(type, payload) {
    chrome.runtime.sendMessage({
      type: type, payload: payload || {}, timestamp: new Date().toISOString()
    }).catch(function () {});
  }
  function settle(ok, error) {
    var pending = waiters.splice(0);
    pending.forEach(function (waiter) {
      clearTimeout(waiter.timer);
      if (ok) waiter.resolve(true);
      else waiter.reject(new Error(error || "Motor local desconectado"));
    });
  }
  worker.onmessage = function (event) {
    var message = event.data || {};
    if (message.kind === "state") {
      connected = !!message.connected;
      if (connected) settle(true);
      else if (message.phase === "error") settle(false, message.error);
      relay("EFFECTIF_TRANSCRIPTION_STATUS", {
        phase: "socket-" + message.phase,
        connected: connected,
        error: message.error,
        platformAudioModified: false
      });
      return;
    }
    if (message.kind === "message") {
      try {
        var data = JSON.parse(message.data);
        if (data.type === "transcript") relay("EFFECTIF_TRANSCRIPT_SEGMENT", data);
        else if (data.type === "metrics") relay("EFFECTIF_TRANSCRIPTION_METRICS", data);
        else relay("EFFECTIF_TRANSCRIPTION_STATUS", data);
      } catch (error) {
        relay("EFFECTIF_TRANSCRIPTION_STATUS", {
          phase: "worker-message-error", error: String(error)
        });
      }
    }
  };
  function ensureWorker() {
    if (connected) return Promise.resolve(true);
    worker.postMessage({ type: "connect" });
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        waiters = waiters.filter(function (item) { return item.timer !== timer; });
        reject(new Error("El motor local no respondió en 3 segundos"));
      }, 3000);
      waiters.push({ resolve: resolve, reject: reject, timer: timer });
    });
  }
  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || message.target !== "offscreen") return false;
    if (message.type === "EFFECTIF_PLAY_SOUND") {
      try {
        playTone(Math.max(0, Math.min(1, Number(message.volume) || 0)));
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: String(error) });
      }
      return false;
    }
    if (message.type === "EFFECTIF_START_LOCAL_TRANSCRIPTION") {
      ensureWorker().then(function () {
        worker.postMessage({
          type: "send",
          payload: {
            type: "start", callId: message.callId,
            mode: message.mode || "auto", apiKey: message.apiKey,
            localModel: message.localModel || "large-v3-turbo",
            groqModel: message.groqModel || "whisper-large-v3-turbo",
            microphoneId: message.microphoneId || "",
            speakerId: message.speakerId || "",
            privacy: { persistAudio: false, persistTranscript: false },
            platformPolicy: "no-platform-media-access"
          }
        });
        sendResponse({ ok: true });
      }).catch(function (error) {
        sendResponse({ ok: false, error: String(error) });
      });
      return true;
    }
    if (message.type === "EFFECTIF_TEST_LOCAL_TRANSCRIPTION") {
      ensureWorker().then(function () {
        worker.postMessage({
          type: "send",
          payload: {
            type: "test",
            mode: message.mode || "auto",
            apiKey: message.apiKey,
            localModel: message.localModel || "large-v3-turbo",
            groqModel: message.groqModel || "whisper-large-v3-turbo",
            microphoneId: message.microphoneId || "",
            speakerId: message.speakerId || ""
          }
        });
        sendResponse({ ok: true });
      }).catch(function (error) {
        sendResponse({ ok: false, error: String(error) });
      });
      return true;
    }
    if (message.type === "EFFECTIF_STOP_LOCAL_TRANSCRIPTION") {
      worker.postMessage({
        type: "send",
        payload: { type: "stop", reason: message.reason || "call-ended" }
      });
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === "EFFECTIF_WORKER_PROBE") {
      ensureWorker().then(function () {
        worker.postMessage({ type: "send", payload: { type: "probe" } });
        sendResponse({ ok: true });
      }).catch(function (error) {
        sendResponse({ ok: false, error: String(error) });
      });
      return true;
    }
    return false;
  });
})();