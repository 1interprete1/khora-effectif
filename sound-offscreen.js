(function () {
  "use strict";
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
  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || message.target !== "offscreen" || message.type !== "EFFECTIF_PLAY_SOUND") return false;
    try {
      playTone(Math.max(0, Math.min(1, Number(message.volume) || 0)));
      sendResponse({ ok: true });
    } catch (error) {
      sendResponse({ ok: false, error: String(error) });
    }
    return false;
  });
})();