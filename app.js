const DB_NAME = "humnote-db";
const STORE_NAME = "melodyNotes";
const DB_VERSION = 1;
const MIN_RECORDING_MS = 700;
const MAX_LIVE_NOTES = 18;
const MIN_PITCH_HZ = 45;
const MAX_PITCH_HZ = 700;
const STABLE_NOTE_WINDOW = 3;
const RECORDING_PREROLL_MS = 100;
const MAX_NOTE_GAP_MS = 140;
const MIN_NOTE_DURATION_MS = 180;
const SEMITONE_STICKINESS = 1;
const MAX_NOTE_JUMP_SEMITONES = 7;
const HARMONIC_CORRELATION_RATIO = 0.92;

const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

const els = {
  installButton: document.getElementById("install-button"),
  installHint: document.getElementById("install-hint"),
  statusPill: document.getElementById("status-pill"),
  liveNote: document.getElementById("live-note"),
  liveFrequency: document.getElementById("live-frequency"),
  meterFill: document.getElementById("meter-fill"),
  livePhrase: document.getElementById("live-phrase"),
  titleInput: document.getElementById("title-input"),
  tagsInput: document.getElementById("tags-input"),
  notesInput: document.getElementById("notes-input"),
  recordButton: document.getElementById("record-button"),
  discardButton: document.getElementById("discard-button"),
  draftSummary: document.getElementById("draft-summary"),
  searchInput: document.getElementById("search-input"),
  emptyState: document.getElementById("empty-state"),
  libraryList: document.getElementById("library-list"),
  entryTemplate: document.getElementById("entry-template")
};

const state = {
  db: null,
  entries: [],
  mediaRecorder: null,
  mediaStream: null,
  audioContext: null,
  analyser: null,
  sourceNode: null,
  animationFrame: 0,
  chunks: [],
  recordingStartedAt: 0,
  pitchFrames: [],
  liveMelody: [],
  currentBlob: null,
  currentMelody: [],
  currentDurationMs: 0,
  deferredInstallPrompt: null,
  discardingTake: false,
  recentDetections: [],
  isArming: false
};

init().catch((error) => {
  console.error(error);
  setStatus("idle", "Error");
  els.liveNote.textContent = "Unavailable";
  els.liveFrequency.textContent = "Something went wrong while starting the app.";
});

async function init() {
  state.db = await openDatabase();
  state.entries = await getAllEntries(state.db);
  renderLibrary();
  wireEvents();
  await registerServiceWorker();
}

function wireEvents() {
  els.recordButton.addEventListener("click", handleRecordToggle);
  els.discardButton.addEventListener("click", handleDiscard);
  els.searchInput.addEventListener("input", renderLibrary);

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.deferredInstallPrompt = event;
    els.installButton.hidden = false;
    els.installHint.textContent = "Install HumNote for full-screen launch and faster access.";
  });

  els.installButton.addEventListener("click", async () => {
    if (!state.deferredInstallPrompt) {
      return;
    }

    state.deferredInstallPrompt.prompt();
    await state.deferredInstallPrompt.userChoice;
    state.deferredInstallPrompt = null;
    els.installButton.hidden = true;
  });
}

async function handleRecordToggle() {
  if (state.isArming) {
    return;
  }

  if (state.mediaRecorder?.state === "recording") {
    await stopRecording();
    return;
  }

  await startRecording();
}

async function handleDiscard() {
  if (state.mediaRecorder?.state === "recording") {
    state.discardingTake = true;
    state.mediaRecorder.stop();
    return;
  }

  clearDraft();
}

async function startRecording() {
  clearDraft(false);
  setStatus("processing", "Connecting");
  els.liveFrequency.textContent = "Requesting microphone permission...";

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const audioContext = new AudioContextClass();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 4096;
    const sourceNode = audioContext.createMediaStreamSource(stream);
    sourceNode.connect(analyser);

    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";

    const mediaRecorder = new MediaRecorder(stream, { mimeType });
    state.mediaRecorder = mediaRecorder;
    state.mediaStream = stream;
    state.audioContext = audioContext;
    state.analyser = analyser;
    state.sourceNode = sourceNode;
    state.chunks = [];
    state.pitchFrames = [];
    state.liveMelody = [];
    state.currentBlob = null;
    state.currentMelody = [];
    state.currentDurationMs = 0;
    state.recentDetections = [];
    state.recordingStartedAt = 0;
    state.isArming = true;

    mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) {
        state.chunks.push(event.data);
      }
    });

    const handleStop = async () => {
      if (state.discardingTake) {
        state.discardingTake = false;
        cleanupAudio();
        clearDraft();
        return;
      }

      const blob = new Blob(state.chunks, { type: mediaRecorder.mimeType || "audio/webm" });
      state.currentBlob = blob;
      state.currentDurationMs = Date.now() - state.recordingStartedAt;
      state.currentMelody = summariseMelody(state.pitchFrames);
      updateDraftSummary();

      if (state.currentDurationMs >= MIN_RECORDING_MS) {
        await saveCurrentTake();
      } else {
        els.draftSummary.textContent = "That take was too short to save. Try holding the idea a little longer.";
      }

      cleanupAudio();
      renderLivePhrase([]);
      els.discardButton.disabled = false;
    };

    mediaRecorder.addEventListener("stop", handleStop);

    setStatus("processing", "Arming");
    els.recordButton.textContent = "Get ready...";
    els.discardButton.disabled = false;
    els.liveNote.textContent = "Stand by...";
    els.liveFrequency.textContent = "Recording starts in a moment to avoid click noise.";

    window.setTimeout(() => {
      if (!state.mediaRecorder || state.discardingTake) {
        state.isArming = false;
        return;
      }

      state.recordingStartedAt = Date.now();
      state.isArming = false;
      mediaRecorder.start();
      state.animationFrame = requestAnimationFrame(samplePitchFrame);

      setStatus("recording", "Recording");
      els.recordButton.textContent = "Stop & save";
      els.liveNote.textContent = "Listening...";
      els.liveFrequency.textContent = "Hum or whistle a short idea.";
    }, RECORDING_PREROLL_MS);
  } catch (error) {
    console.error(error);
    cleanupAudio();
    state.isArming = false;
    setStatus("idle", "Ready");
    els.liveNote.textContent = "Permission needed";
    els.liveFrequency.textContent = "HumNote needs microphone access to record melody ideas.";
  }
}

async function stopRecording() {
  if (state.isArming) {
    state.discardingTake = true;
    state.isArming = false;
    cleanupAudio();
    clearDraft(false);
    return;
  }

  if (!state.mediaRecorder || state.mediaRecorder.state !== "recording") {
    return;
  }

  cancelAnimationFrame(state.animationFrame);
  setStatus("processing", "Saving");
  els.recordButton.disabled = true;
  els.recordButton.textContent = "Saving...";
  els.liveFrequency.textContent = "Turning your take into a melody note...";

  state.mediaRecorder.stop();
}

function samplePitchFrame() {
  if (!state.analyser || !state.audioContext) {
    return;
  }

  const buffer = new Float32Array(state.analyser.fftSize);
  state.analyser.getFloatTimeDomainData(buffer);

  const rms = rootMeanSquare(buffer);
  const pitch = rms > 0.015 ? detectPitch(buffer, state.audioContext.sampleRate) : -1;

  els.meterFill.style.width = `${Math.max(6, Math.min(100, rms * 260))}%`;

  if (pitch > 0) {
    const note = stabilizeDetectedNote(frequencyToNote(pitch));
    const now = Date.now() - state.recordingStartedAt;
    const stableNote = registerDetection(note);
    if (stableNote) {
      state.pitchFrames.push({ time: now, frequency: pitch, note: stableNote });
      updateLiveMelody(stableNote);
      els.liveNote.textContent = stableNote.label;
      els.liveFrequency.textContent = `${Math.round(pitch)} Hz`;
    } else {
      els.liveNote.textContent = "Locking on...";
      els.liveFrequency.textContent = `${Math.round(pitch)} Hz`;
    }
  } else {
    els.liveNote.textContent = "Listening...";
    els.liveFrequency.textContent = "Hold a steady tone for cleaner note detection.";
    state.recentDetections = [];
  }

  state.animationFrame = requestAnimationFrame(samplePitchFrame);
}

function stabilizeDetectedNote(note) {
  const recentStable = state.pitchFrames.at(-1)?.note;
  if (!recentStable) {
    return note;
  }

  const semitoneJump = note.midi - recentStable.midi;
  if (Math.abs(semitoneJump) <= MAX_NOTE_JUMP_SEMITONES) {
    return note;
  }

  for (let divisor = 2; divisor <= 4; divisor += 1) {
    const loweredMidi = note.midi - 12 * Math.log2(divisor);
    const roundedMidi = Math.round(loweredMidi);
    if (Math.abs(roundedMidi - recentStable.midi) <= MAX_NOTE_JUMP_SEMITONES) {
      return midiToNote(roundedMidi);
    }
  }

  for (let multiplier = 2; multiplier <= 4; multiplier += 1) {
    const raisedMidi = note.midi + 12 * Math.log2(multiplier);
    const roundedMidi = Math.round(raisedMidi);
    if (Math.abs(roundedMidi - recentStable.midi) <= MAX_NOTE_JUMP_SEMITONES) {
      return midiToNote(roundedMidi);
    }
  }

  return note;
}

function updateLiveMelody(note) {
  const latest = state.liveMelody.at(-1);
  if (!latest || latest.name !== note.label) {
    state.liveMelody.push({ name: note.label, time: performance.now() });
    if (state.liveMelody.length > MAX_LIVE_NOTES) {
      state.liveMelody.shift();
    }
    renderLivePhrase(state.liveMelody.map((item) => item.name));
  }
}

function registerDetection(note) {
  state.recentDetections.push(note);
  if (state.recentDetections.length > STABLE_NOTE_WINDOW) {
    state.recentDetections.shift();
  }

  if (state.recentDetections.length < STABLE_NOTE_WINDOW) {
    return null;
  }

  const first = state.recentDetections[0];
  const isStable = state.recentDetections.every((item) => item.midi === first.midi);
  return isStable ? first : null;
}

function renderLivePhrase(notes) {
  els.livePhrase.innerHTML = "";

  if (!notes.length) {
    els.livePhrase.textContent = "No phrase yet.";
    return;
  }

  notes.forEach((note) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = note;
    els.livePhrase.append(chip);
  });
}

function updateDraftSummary() {
  const noteLabels = state.currentMelody.map((item) => item.note).join(" - ");
  if (noteLabels) {
    els.draftSummary.textContent = `Draft melody: ${noteLabels}. Saving it to your melody inbox now.`;
  } else {
    els.draftSummary.textContent = "Captured the audio. Pitch detection was faint, but the take is still available.";
  }
}

async function saveCurrentTake() {
  const title = els.titleInput.value.trim() || generateDefaultTitle();
  const tags = els.tagsInput.value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);

  const entry = {
    id: crypto.randomUUID(),
    title,
    tags,
    notes: els.notesInput.value.trim(),
    createdAt: new Date().toISOString(),
    melody: state.currentMelody,
    durationMs: state.currentDurationMs,
    clip: state.currentBlob,
    searchText: [title, tags.join(" "), els.notesInput.value.trim(), state.currentMelody.map((item) => item.note).join(" ")]
      .join(" ")
      .toLowerCase()
  };

  await putEntry(state.db, entry);
  state.entries = await getAllEntries(state.db);
  renderLibrary();
  els.draftSummary.textContent = `Saved "${title}" to your melody inbox.`;
  resetRecorderUi();
}

function clearDraft(resetTextFields = true) {
  state.currentBlob = null;
  state.currentMelody = [];
  state.currentDurationMs = 0;
  state.pitchFrames = [];
  state.liveMelody = [];
  state.recentDetections = [];
  renderLivePhrase([]);
  if (resetTextFields) {
    els.titleInput.value = "";
    els.tagsInput.value = "";
    els.notesInput.value = "";
  }
  els.draftSummary.textContent = "Record a short idea and HumNote will save both the audio and a melody sketch.";
  resetRecorderUi();
}

function resetRecorderUi() {
  els.recordButton.disabled = false;
  els.recordButton.textContent = "Start recording";
  setStatus("idle", "Ready");
  els.liveNote.textContent = "Listening...";
  els.liveFrequency.textContent = "Give microphone permission to start capturing melody.";
  els.meterFill.style.width = "2%";
}

function cleanupAudio() {
  cancelAnimationFrame(state.animationFrame);
  state.animationFrame = 0;

  if (state.sourceNode) {
    state.sourceNode.disconnect();
  }

  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach((track) => track.stop());
  }

  if (state.audioContext) {
    state.audioContext.close().catch(() => {});
  }

  state.mediaRecorder = null;
  state.mediaStream = null;
  state.audioContext = null;
  state.analyser = null;
  state.sourceNode = null;
  state.isArming = false;
}

function renderLibrary() {
  const query = els.searchInput.value.trim().toLowerCase();
  const filtered = state.entries.filter((entry) => !query || entry.searchText.includes(query));

  els.emptyState.hidden = filtered.length > 0;
  els.libraryList.innerHTML = "";

  filtered
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .forEach((entry) => {
      const fragment = els.entryTemplate.content.cloneNode(true);
      const card = fragment.querySelector(".entry-card");
      const title = fragment.querySelector(".entry-title");
      const date = fragment.querySelector(".entry-date");
      const tags = fragment.querySelector(".entry-tags");
      const notes = fragment.querySelector(".entry-notes");
      const melody = fragment.querySelector(".entry-melody");
      const audio = fragment.querySelector(".entry-audio");
      const deleteButton = fragment.querySelector(".entry-delete");
      const playMelodyButton = fragment.querySelector(".play-melody");
      const playAudioButton = fragment.querySelector(".play-audio");

      title.textContent = entry.title;
      date.textContent = formatDate(entry.createdAt, entry.durationMs);
      tags.textContent = entry.tags.length ? `Tags: ${entry.tags.join(", ")}` : "No tags yet";
      notes.textContent = entry.notes || "No extra context saved for this melody.";

      if (entry.melody?.length) {
        renderDurationMelody(melody, entry.melody);
      } else {
        melody.textContent = "Audio saved without a clear note sketch.";
      }

      const audioUrl = URL.createObjectURL(entry.clip);
      audio.src = audioUrl;

      playAudioButton.addEventListener("click", () => {
        audio.currentTime = 0;
        audio.play();
      });

      playMelodyButton.disabled = !entry.melody?.length;
      playMelodyButton.addEventListener("click", () => playMelody(entry.melody));

      deleteButton.addEventListener("click", async () => {
        URL.revokeObjectURL(audioUrl);
        await deleteEntry(state.db, entry.id);
        state.entries = await getAllEntries(state.db);
        renderLibrary();
      });

      card.dataset.entryId = entry.id;
      els.libraryList.append(fragment);
    });
}

async function playMelody(melody) {
  if (!melody?.length) {
    return;
  }

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const context = new AudioContextClass();
  const gain = context.createGain();
  gain.gain.value = 0.07;
  gain.connect(context.destination);

  let cursor = context.currentTime + 0.02;
  melody.forEach((item) => {
    const oscillator = context.createOscillator();
    oscillator.type = "triangle";
    oscillator.frequency.value = noteNumberToFrequency(item.midi);
    oscillator.connect(gain);
    oscillator.start(cursor);
    oscillator.stop(cursor + Math.max(0.16, item.durationMs / 1000));
    cursor += Math.max(0.2, item.durationMs / 1000);
  });

  setTimeout(() => {
    context.close().catch(() => {});
  }, (cursor - context.currentTime + 0.5) * 1000);
}

function setStatus(kind, label) {
  els.statusPill.className = `status-pill ${kind}`;
  els.statusPill.textContent = label;
}

function generateDefaultTitle() {
  const now = new Date();
  return `Melody idea ${now.toLocaleDateString([], { month: "short", day: "numeric" })} ${now.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit"
  })}`;
}

function formatDate(dateString, durationMs) {
  const date = new Date(dateString);
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  return `${date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  })} - ${seconds}s take`;
}

function summariseMelody(frames) {
  if (!frames.length) {
    return [];
  }

  const notes = [];
  let current = null;
  let previousTime = frames[0].time;

  for (const frame of frames) {
    const gapMs = frame.time - previousTime;

    if (
      !current ||
      current.note !== frame.note.label ||
      gapMs > MAX_NOTE_GAP_MS
    ) {
      if (current) {
        current.durationMs = Math.max(MIN_NOTE_DURATION_MS, previousTime - current.startedAt + estimatedFrameSpan(frames));
        if (current.durationMs >= MIN_NOTE_DURATION_MS) {
          notes.push(current);
        }
      }

      current = {
        note: frame.note.label,
        midi: frame.note.midi,
        startedAt: frame.time,
        durationMs: 0
      };
    }

    previousTime = frame.time;
  }

  if (current) {
    current.durationMs = Math.max(MIN_NOTE_DURATION_MS, previousTime - current.startedAt + estimatedFrameSpan(frames));
    notes.push(current);
  }

  return smoothMelody(
    notes
      .filter((item) => item.durationMs >= MIN_NOTE_DURATION_MS)
      .reduce((accumulator, item) => {
      const previous = accumulator.at(-1);
      if (previous && previous.note === item.note && item.startedAt - (previous.startedAt + previous.durationMs) <= MAX_NOTE_GAP_MS) {
        previous.durationMs += item.durationMs;
      } else {
        accumulator.push(item);
      }
      return accumulator;
      }, [])
  ).slice(0, 24);
}

function estimatedFrameSpan(frames) {
  if (frames.length < 2) {
    return 60;
  }

  let total = 0;
  let count = 0;
  for (let index = 1; index < frames.length; index += 1) {
    const delta = frames[index].time - frames[index - 1].time;
    if (delta > 0 && delta < 120) {
      total += delta;
      count += 1;
    }
  }

  if (count === 0) {
    return 60;
  }

  return Math.max(20, Math.min(80, total / count));
}

function smoothMelody(notes) {
  if (notes.length <= 1) {
    return notes;
  }

  const smoothed = [];

  for (const note of notes) {
    const previous = smoothed.at(-1);
    if (!previous) {
      smoothed.push({ ...note });
      continue;
    }

    const closeInPitch = Math.abs(note.midi - previous.midi) <= SEMITONE_STICKINESS;
    const shortBlip = note.durationMs <= 260;
    const nearlyContiguous = note.startedAt - (previous.startedAt + previous.durationMs) <= MAX_NOTE_GAP_MS;

    if (closeInPitch && (shortBlip || nearlyContiguous)) {
      const totalDuration = previous.durationMs + note.durationMs;
      const weightedMidi = Math.round(
        (previous.midi * previous.durationMs + note.midi * note.durationMs) / totalDuration
      );
      const merged = midiToNote(weightedMidi);
      previous.midi = merged.midi;
      previous.note = merged.label;
      previous.durationMs = totalDuration;
      continue;
    }

    smoothed.push({ ...note });
  }

  for (let index = 1; index < smoothed.length - 1; index += 1) {
    const previous = smoothed[index - 1];
    const current = smoothed[index];
    const next = smoothed[index + 1];
    const isShortBridge = current.durationMs <= 240;
    const neighborsMatch = previous.midi === next.midi;

    if (isShortBridge && neighborsMatch) {
      previous.durationMs += current.durationMs + next.durationMs;
      smoothed.splice(index, 2);
      index -= 1;
    }
  }

  return smoothed;
}

function midiToNote(midi) {
  const noteName = noteNames[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return {
    midi,
    label: `${noteName}${octave}`
  };
}

function rootMeanSquare(buffer) {
  let sum = 0;
  for (const value of buffer) {
    sum += value * value;
  }
  return Math.sqrt(sum / buffer.length);
}

function frequencyToNote(frequency) {
  const midi = Math.round(12 * Math.log2(frequency / 440) + 69);
  return midiToNote(midi);
}

function noteNumberToFrequency(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

function detectPitch(buffer, sampleRate) {
  const size = buffer.length;
  const rms = rootMeanSquare(buffer);
  if (rms < 0.01) {
    return -1;
  }

  const centered = new Float32Array(size);
  let mean = 0;
  for (let index = 0; index < size; index += 1) {
    mean += buffer[index];
  }
  mean /= size;

  for (let index = 0; index < size; index += 1) {
    centered[index] = buffer[index] - mean;
  }

  const minOffset = Math.floor(sampleRate / MAX_PITCH_HZ);
  const maxOffset = Math.min(Math.floor(sampleRate / MIN_PITCH_HZ), size - 2);
  if (maxOffset <= minOffset) {
    return -1;
  }

  const yinBuffer = new Float32Array(maxOffset + 1);
  yinBuffer[0] = 1;

  for (let tau = 1; tau <= maxOffset; tau += 1) {
    let sum = 0;
    for (let index = 0; index < size - tau; index += 1) {
      const delta = centered[index] - centered[index + tau];
      sum += delta * delta;
    }
    yinBuffer[tau] = sum;
  }

  let runningTotal = 0;
  for (let tau = 1; tau <= maxOffset; tau += 1) {
    runningTotal += yinBuffer[tau];
    yinBuffer[tau] = runningTotal === 0 ? 1 : (yinBuffer[tau] * tau) / runningTotal;
  }

  let bestTau = -1;
  const threshold = 0.12;
  for (let tau = minOffset; tau <= maxOffset; tau += 1) {
    if (yinBuffer[tau] < threshold) {
      bestTau = tau;
      while (bestTau + 1 <= maxOffset && yinBuffer[bestTau + 1] < yinBuffer[bestTau]) {
        bestTau += 1;
      }
      break;
    }
  }

  if (bestTau === -1) {
    let minimumValue = 1;
    for (let tau = minOffset; tau <= maxOffset; tau += 1) {
      if (yinBuffer[tau] < minimumValue) {
        minimumValue = yinBuffer[tau];
        bestTau = tau;
      }
    }
    if (bestTau === -1 || minimumValue > 0.22) {
      return -1;
    }
  }

  const previous = yinBuffer[bestTau - 1] ?? yinBuffer[bestTau];
  const current = yinBuffer[bestTau];
  const next = yinBuffer[bestTau + 1] ?? yinBuffer[bestTau];
  const denominator = previous + next - 2 * current;
  let adjustment = 0;
  if (denominator !== 0) {
    adjustment = 0.5 * (previous - next) / denominator;
  }
  adjustment = Math.max(-0.5, Math.min(0.5, adjustment));

  const refinedTau = bestTau + adjustment;
  if (!Number.isFinite(refinedTau) || refinedTau < minOffset || refinedTau > maxOffset) {
    return -1;
  }

  const frequency = sampleRate / refinedTau;

  if (frequency < MIN_PITCH_HZ || frequency > MAX_PITCH_HZ) {
    return -1;
  }

  return preferLowerHarmonic(frequency, yinBuffer, minOffset, maxOffset, sampleRate, current, bestTau);
}

function preferLowerHarmonic(frequency, yinBuffer, minOffset, maxOffset, sampleRate, currentValue, bestTau) {
  let chosenFrequency = frequency;
  let chosenTau = bestTau;

  for (let multiple = 2; multiple <= 4; multiple += 1) {
    const candidateTau = Math.round(bestTau * multiple);
    if (candidateTau > maxOffset) {
      break;
    }

    const candidateValue = yinBuffer[candidateTau];
    if (candidateValue <= currentValue * (1 / HARMONIC_CORRELATION_RATIO)) {
      const candidateFrequency = sampleRate / candidateTau;
      if (candidateFrequency >= MIN_PITCH_HZ && candidateFrequency <= MAX_PITCH_HZ) {
        chosenFrequency = candidateFrequency;
        chosenTau = candidateTau;
        break;
      }
    }
  }

  if (chosenTau !== bestTau) {
    return chosenFrequency;
  }

  if (frequency < MIN_PITCH_HZ || frequency > MAX_PITCH_HZ) {
    return -1;
  }

  return frequency;
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.addEventListener("upgradeneeded", () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    });

    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

function getAllEntries(db) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAll();

    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

function putEntry(db, entry) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.put(entry);

    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

function deleteEntry(db, id) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.delete(id);

    request.addEventListener("success", () => resolve());
    request.addEventListener("error", () => reject(request.error));
  });
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    return;
  }

  try {
    await navigator.serviceWorker.register("/sw.js");
  } catch (error) {
    console.warn("Service worker registration failed", error);
  }
}

function renderDurationMelody(container, melody) {
  container.innerHTML = "";
  container.classList.add("duration-melody");

  const maxDuration = Math.max(...melody.map((item) => item.durationMs), MIN_NOTE_DURATION_MS);

  melody.forEach((item) => {
    const pill = document.createElement("span");
    pill.className = "chip duration-chip";
    pill.textContent = item.note;

    const flexGrow = Math.max(1, item.durationMs / maxDuration * 3.4);
    pill.style.flexGrow = String(flexGrow);
    pill.style.setProperty("--duration-fill", `${Math.max(18, Math.min(100, item.durationMs / maxDuration * 100))}%`);
    pill.title = `${item.note} - ${Math.round(item.durationMs)} ms`;

    const length = document.createElement("span");
    length.className = "duration-label";
    length.textContent = formatDurationBadge(item.durationMs);
    pill.append(length);

    container.append(pill);
  });
}

function formatDurationBadge(durationMs) {
  if (durationMs >= 1000) {
    return `${(durationMs / 1000).toFixed(1)}s`;
  }

  return `${Math.round(durationMs)}ms`;
}
