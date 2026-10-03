chrome.runtime.onMessage.addListener((message) => {
  if (message?.target === "offscreen" && message.type === "PLAY_ALERT_SOUND") {
    playToneSequence();
  }
});

function playToneSequence() {
  try {
    const audio = new AudioContext();
    const master = audio.createGain();
    master.gain.setValueAtTime(0.0001, audio.currentTime);
    master.gain.exponentialRampToValueAtTime(0.38, audio.currentTime + 0.025);
    master.connect(audio.destination);

    const strikes = [0.02, 0.52, 1.02];
    const partials = [
      { frequency: 1046, level: 0.42, duration: 0.95 },
      { frequency: 1760, level: 0.20, duration: 0.72 },
      { frequency: 2637, level: 0.11, duration: 0.52 },
      { frequency: 3520, level: 0.06, duration: 0.34 }
    ];

    for (const strike of strikes) {
      for (const partial of partials) {
        const oscillator = audio.createOscillator();
        const envelope = audio.createGain();
        const start = audio.currentTime + strike;
        oscillator.type = "sine";
        oscillator.frequency.value = partial.frequency;
        envelope.gain.setValueAtTime(0.0001, start);
        envelope.gain.exponentialRampToValueAtTime(partial.level, start + 0.012);
        envelope.gain.exponentialRampToValueAtTime(0.0001, start + partial.duration);
        oscillator.connect(envelope);
        envelope.connect(master);
        oscillator.start(start);
        oscillator.stop(start + partial.duration + 0.02);
      }
    }
    window.setTimeout(() => audio.close().catch(() => {}), 2300);
  } catch {
    // Keep the worker and desktop notification usable if audio is unavailable.
  }
}
