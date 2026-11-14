const AudioCtx = window.AudioContext || window.webkitAudioContext;
let audioCtx = null;
let activeSources = []; 
const decodedBufferCache = new Map();

function ensureAudioContext() {
  if (!audioCtx) audioCtx = new AudioCtx();
  if (audioCtx.state === 'suspended') audioCtx.resume();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
});

function updateMediaSessionMetadata(title = 'Soundboard LV.5') {
  if ('mediaSession' in navigator) {
    try {
      const hasPlaying = activeSources.length > 0 || smartSPMap.size > 0;
      navigator.mediaSession.metadata = new MediaMetadata({ title, artist: 'Custom Soundboard LV.5', album: 'Background Playback' });
      navigator.mediaSession.playbackState = hasPlaying ? 'playing' : 'none';
      navigator.mediaSession.setActionHandler('pause', () => stopAllSounds());
      navigator.mediaSession.setActionHandler('stop', () => stopAllSounds());
    } catch (e) {}
  }
}

const DB_NAME = 'CustomSoundboardDB_Lv5_ver5_1';
const DB_VERSION = 1;
let db = null;

function initDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const database = e.target.result;
      if (!database.objectStoreNames.contains('categories')) database.createObjectStore('categories', { keyPath: 'id' });
      if (!database.objectStoreNames.contains('sounds')) database.createObjectStore('sounds', { keyPath: 'id' });
    };
    req.onsuccess = (e) => { db = e.target.result; resolve(); };
    req.onerror = (e) => reject(e);
  });
}

function dbGetAll(storeName) {
  return new Promise((resolve) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
  });
}

function dbPut(storeName, data) {
  return new Promise((resolve) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(data);
    tx.oncomplete = () => resolve();
  });
}

function dbDelete(storeName, id) {
  return new Promise((resolve) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(id);
    tx.oncomplete = () => resolve();
  });
}

function dbClear(storeName) {
  return new Promise((resolve) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).clear();
    tx.oncomplete = () => resolve();
  });
}

let categories = [];
let sounds = [];
let currentCategoryId = null;
let isEditMode = false;
let editingSoundId = null;
let draggedCatId = null;
let draggedSoundId = null;
let smartSPMap = new Map();

const PHASE_COLORS = ['#00e676', '#ffeb3b', '#ff5252', '#40c4ff', '#ea80fc', '#ff9100'];
function getPhaseColor(index) { return PHASE_COLORS[index % PHASE_COLORS.length]; }

function getNormalizedPhaseBounds(phase, totalDuration) {
  const tStart = Math.max(0, Math.min(Number(phase.trimStart ?? phase.start ?? 0), totalDuration));
  const tEnd = Math.max(tStart + 0.05, Math.min(Number(phase.trimEnd ?? phase.end ?? totalDuration), totalDuration));
  const isPartial = Boolean(phase.isPartialLoop);
  let lStart = tStart;
  let lEnd = tEnd;
  if (isPartial) {
    lStart = Math.max(tStart, Math.min(Number(phase.start ?? tStart), tEnd));
    lEnd = Math.max(lStart + 0.05, Math.min(Number(phase.end ?? tEnd), tEnd));
  }
  return { trimStart: tStart, trimEnd: tEnd, loopStart: lStart, loopEnd: lEnd, isPartialLoop: isPartial };
}

function updateButtonVisualState(buttonEl, phaseIndex, totalPhases, isWaiting) {
  buttonEl.style.borderBottom = `5px solid ${getPhaseColor(phaseIndex)}`;
  if (isWaiting) buttonEl.classList.add('sp-waiting');
  else buttonEl.classList.remove('sp-waiting');

  let badge = buttonEl.querySelector('.phase-status-badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'phase-status-badge';
    buttonEl.appendChild(badge);
  }
  badge.textContent = `P${phaseIndex + 1}/${totalPhases}${isWaiting ? ' ⚡SP待ち' : ''}`;
}

function clearButtonVisualState(buttonEl) {
  buttonEl.style.borderBottom = '';
  buttonEl.classList.remove('playing', 'sp-waiting');
  const badge = buttonEl.querySelector('.phase-status-badge');
  if (badge) badge.remove();
}

function findExitPoint(prevPos, currPos, activeStart, activeEnd, spList) {
  const validSPs = (spList || []).filter(sp => sp >= activeStart && sp <= activeEnd).sort((a, b) => a - b);
  if (currPos >= prevPos) {
    for (const sp of validSPs) { if (prevPos < sp && sp <= currPos) return sp; }
    if (prevPos < activeEnd && activeEnd <= currPos) return activeEnd;
  } else {
    for (const sp of validSPs) { if (prevPos < sp && sp <= activeEnd) return sp; }
    return activeEnd;
  }
  return null;
}

async function handleSoundButtonPress(sound, buttonEl) {
  ensureAudioContext();
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  if (sound.playbackType === 'seamless') {
    const state = smartSPMap.get(sound.id);
    if (state) {
      const maxPhaseIndex = state.phases.length - 1;
      if (state.currentPhase < maxPhaseIndex) {
        state.spActive = true;
        updateButtonVisualState(buttonEl, state.currentPhase, state.phases.length, true);
      } else {
        stopSmartSPEntry(state);
      }
      return;
    }
    await startSmartSPPlayback(sound, buttonEl);
    return;
  }

  if (sound.playbackType === 'loop') {
    const existingEntry = activeSources.find(item => item.soundId === sound.id);
    if (existingEntry) { stopSoundEntry(existingEntry); return; }
  }

  applyOverwriteRules(sound);

  let audioBuffer = decodedBufferCache.get(sound.id);
  if (!audioBuffer) {
    audioBuffer = await audioCtx.decodeAudioData(sound.audioData.slice(0));
    decodedBufferCache.set(sound.id, audioBuffer);
  }

  const duration = audioBuffer.duration;
  const trimStart = Math.max(0, Math.min(Number(sound.trimStart) || 0, duration));
  const trimEnd = (sound.trimEnd !== null && sound.trimEnd !== undefined && !isNaN(Number(sound.trimEnd)))
    ? Math.max(trimStart + 0.05, Math.min(Number(sound.trimEnd), duration))
    : duration;

  const source = audioCtx.createBufferSource();
  source.buffer = audioBuffer;

  if (sound.playbackType === 'loop') {
    source.loop = true;
    if (sound.isPartialLoop) {
      const lStart = Math.max(trimStart, Math.min(Number(sound.loopStart) || trimStart, trimEnd));
      const lEnd = Math.max(lStart + 0.05, Math.min(Number(sound.loopEnd) || trimEnd, trimEnd));
      source.loopStart = lStart;
      source.loopEnd = lEnd;
    } else {
      source.loopStart = trimStart;
      source.loopEnd = trimEnd;
    }
  } else {
    source.loop = false;
  }

  const gainNode = audioCtx.createGain();
  gainNode.gain.value = (sound.volume ?? 100) / 100;
  source.connect(gainNode);
  gainNode.connect(audioCtx.destination);

  const playEntry = { source, soundId: sound.id, buttonEl };
  activeSources.push(playEntry);
  buttonEl.classList.add('playing');
  updateMediaSessionMetadata(sound.name);

  source.onended = () => {
    activeSources = activeSources.filter(item => item !== playEntry);
    if (!activeSources.some(item => item.soundId === sound.id)) buttonEl.classList.remove('playing');
    updateMediaSessionMetadata();
  };

  if (sound.playbackType === 'loop') source.start(0, trimStart);
  else source.start(0, trimStart, trimEnd - trimStart);
}

async function startSmartSPPlayback(sound, buttonEl) {
  applyOverwriteRules(sound);
  let audioBuffer = decodedBufferCache.get(sound.id);
  if (!audioBuffer) {
    audioBuffer = await audioCtx.decodeAudioData(sound.audioData.slice(0));
    decodedBufferCache.set(sound.id, audioBuffer);
  }

  const duration = audioBuffer.duration;
  const phases = (sound.seamlessPhases && sound.seamlessPhases.length > 0)
    ? sound.seamlessPhases
    : [{ trimStart: 0, trimEnd: duration, isPartialLoop: false, start: 0, end: duration, sps: [duration * 0.5] }];

  const gainNode = audioCtx.createGain();
  gainNode.gain.value = (sound.volume ?? 100) / 100;
  gainNode.connect(audioCtx.destination);

  buttonEl.classList.add('playing');
  updateButtonVisualState(buttonEl, 0, phases.length, false);

  const state = {
    soundId: sound.id, soundName: sound.name, buttonEl, audioBuffer, phases, gainNode,
    currentPhase: 0, spActive: false, currentSource: null, segmentStartCtxTime: 0,
    segmentInitialOffset: 0, lastCheckedPos: 0, monitorInterval: null, isStopped: false
  };

  smartSPMap.set(sound.id, state);
  updateMediaSessionMetadata(sound.name);
  playSmartSPSegment(state, 0, getNormalizedPhaseBounds(phases[0], duration).trimStart);
}

function getBufferPosAtTime(state, bounds, ctxTime) {
  const elapsed = ctxTime - state.segmentStartCtxTime;
  const loopLen = bounds.loopEnd - bounds.loopStart;
  let pos = state.segmentInitialOffset + elapsed;
  if (pos >= bounds.loopEnd && loopLen > 0) pos = bounds.loopStart + ((pos - bounds.loopStart) % loopLen);
  return pos;
}

function playSmartSPSegment(state, phaseIndex, startOffset) {
  if (state.isStopped) return;
  state.currentPhase = phaseIndex;
  const phase = state.phases[phaseIndex];
  const bounds = getNormalizedPhaseBounds(phase, state.audioBuffer.duration);

  const source = audioCtx.createBufferSource();
  source.buffer = state.audioBuffer;
  source.loop = true;
  source.loopStart = bounds.loopStart;
  source.loopEnd = bounds.loopEnd;
  source.connect(state.gainNode);
  state.currentSource = source;

  const startTime = audioCtx.currentTime;
  source.start(startTime, startOffset);
  state.segmentStartCtxTime = startTime;
  state.segmentInitialOffset = startOffset;
  state.lastCheckedPos = startOffset;

  if (state.monitorInterval) clearInterval(state.monitorInterval);
  state.monitorInterval = setInterval(() => {
    if (state.isStopped || !state.currentSource) { clearInterval(state.monitorInterval); return; }
    const now = audioCtx.currentTime;
    const currPos = getBufferPosAtTime(state, bounds, now);
    const prevPos = state.lastCheckedPos;
    state.lastCheckedPos = currPos;

    if (state.spActive) {
      const exitPoint = findExitPoint(prevPos, currPos, bounds.trimStart, bounds.loopEnd, phase.sps);
      if (exitPoint !== null) {
        clearInterval(state.monitorInterval);
        try { state.currentSource.stop(); } catch (e) {}
        const nextPhaseIndex = phaseIndex + 1;
        state.spActive = false;
        updateButtonVisualState(state.buttonEl, nextPhaseIndex, state.phases.length, false);
        playSmartSPSegment(state, nextPhaseIndex, getNormalizedPhaseBounds(state.phases[nextPhaseIndex], state.audioBuffer.duration).trimStart);
      }
    }
  }, 10);
}

function stopSmartSPEntry(state) {
  state.isStopped = true;
  if (state.monitorInterval) clearInterval(state.monitorInterval);
  if (state.currentSource) { try { state.currentSource.stop(); } catch (e) {} }
  smartSPMap.delete(state.soundId);
  clearButtonVisualState(state.buttonEl);
  updateMediaSessionMetadata();
}

function applyOverwriteRules(sound) {
  if (sound.overwriteMode === 'all') {
    activeSources.forEach(entry => {
      const sObj = sounds.find(s => s.id === entry.soundId);
      if (!sObj || !sObj.disableOverwrite) stopSoundEntry(entry);
    });
    smartSPMap.forEach((entry) => {
      const sObj = sounds.find(s => s.id === entry.soundId);
      if (!sObj || !sObj.disableOverwrite) stopSmartSPEntry(entry);
    });
  } else if (sound.overwriteMode === 'conditional' && sound.targetSoundId) {
    activeSources.forEach(entry => {
      if (entry.soundId === sound.targetSoundId) {
        const sObj = sounds.find(s => s.id === entry.soundId);
        if (!sObj || !sObj.disableOverwrite) stopSoundEntry(entry);
      }
    });
    smartSPMap.forEach((entry) => {
      if (entry.soundId === sound.targetSoundId) {
        const sObj = sounds.find(s => s.id === entry.soundId);
        if (!sObj || !sObj.disableOverwrite) stopSmartSPEntry(entry);
      }
    });
  }
}

function stopSoundEntry(entry) {
  try { entry.source.stop(); } catch (e) {}
  activeSources = activeSources.filter(item => item !== entry);
  if (!activeSources.some(item => item.soundId === entry.soundId)) entry.buttonEl.classList.remove('playing');
  updateMediaSessionMetadata();
}

function stopAllSounds() {
  activeSources.forEach(entry => { try { entry.source.stop(); } catch (e) {} entry.buttonEl.classList.remove('playing'); });
  activeSources = [];
  smartSPMap.forEach(state => stopSmartSPEntry(state));
  smartSPMap.clear();
  updateMediaSessionMetadata();
}

async function saveCategoryOrders() {
  for (let i = 0; i < categories.length; i++) {
    categories[i].order = i;
    await dbPut('categories', categories[i]);
  }
}

async function moveCategoryOrder(index, direction) {
  const targetIndex = index + direction;
  if (targetIndex < 0 || targetIndex >= categories.length) return;
  const [moved] = categories.splice(index, 1);
  categories.splice(targetIndex, 0, moved);
  await saveCategoryOrders();
  renderCategories();
}

async function moveSoundOrder(catSoundList, index, direction) {
  const targetIndex = index + direction;
  if (targetIndex < 0 || targetIndex >= catSoundList.length) return;
  const [moved] = catSoundList.splice(index, 1);
  catSoundList.splice(targetIndex, 0, moved);
  for (let i = 0; i < catSoundList.length; i++) {
    catSoundList[i].order = i;
    await dbPut('sounds', catSoundList[i]);
  }
  renderSounds();
}

function renderCategories() {
  const container = document.getElementById('category-tabs');
  container.innerHTML = '';
  categories.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  categories.forEach((cat, idx) => {
    const btn = document.createElement('button');
    btn.className = `cat-tab ${cat.id === currentCategoryId ? 'active' : ''}`;
    if (isEditMode) btn.classList.add('edit-draggable');

    if (isEditMode && idx > 0) {
      const leftBtn = document.createElement('span');
      leftBtn.className = 'cat-move-btn';
      leftBtn.textContent = '◀';
      leftBtn.onclick = (e) => { e.stopPropagation(); moveCategoryOrder(idx, -1); };
      btn.appendChild(leftBtn);
    }

    const titleSpan = document.createElement('span');
    titleSpan.textContent = cat.name;
    btn.appendChild(titleSpan);

    if (isEditMode && idx < categories.length - 1) {
      const rightBtn = document.createElement('span');
      rightBtn.className = 'cat-move-btn';
      rightBtn.textContent = '▶';
      rightBtn.onclick = (e) => { e.stopPropagation(); moveCategoryOrder(idx, 1); };
      btn.appendChild(rightBtn);
    }

    if (isEditMode && categories.length > 1) {
      const delX = document.createElement('span');
      delX.className = 'cat-del-x';
      delX.textContent = '×';
      delX.onclick = (e) => {
        e.stopPropagation();
        if (confirm(`カテゴリ「${cat.name}」を削除しますか？`)) deleteCategory(cat.id);
      };
      btn.appendChild(delX);
    }

    if (isEditMode) {
      btn.draggable = true;
      btn.ondragstart = (e) => { draggedCatId = cat.id; btn.classList.add('dragging'); };
      btn.ondragend = () => { draggedCatId = null; btn.classList.remove('dragging'); document.querySelectorAll('.cat-tab').forEach(el => el.classList.remove('drag-over')); };
      btn.ondragover = (e) => { if (!draggedCatId || draggedCatId === cat.id) return; e.preventDefault(); btn.classList.add('drag-over'); };
      btn.ondragleave = () => btn.classList.remove('drag-over');
      btn.ondrop = async (e) => {
        e.preventDefault();
        btn.classList.remove('drag-over');
        if (!draggedCatId || draggedCatId === cat.id) return;
        const fromIdx = categories.findIndex(c => c.id === draggedCatId);
        const toIdx = categories.findIndex(c => c.id === cat.id);
        if (fromIdx !== -1 && toIdx !== -1) {
          const [moved] = categories.splice(fromIdx, 1);
          categories.splice(toIdx, 0, moved);
          await saveCategoryOrders();
          renderCategories();
        }
      };
    }

    btn.onclick = () => { currentCategoryId = cat.id; renderCategories(); renderSounds(); };
    container.appendChild(btn);
  });
}

function renderSounds() {
  const grid = document.getElementById('sound-grid');
  grid.innerHTML = '';
  const filtered = sounds.filter(s => s.categoryId === currentCategoryId).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  filtered.forEach((sound, idx) => {
    const btn = document.createElement('button');
    btn.className = 'sound-btn';
    btn.style.backgroundColor = sound.color || '#d32f2f';
    if (sound.imageDataUrl) {
      btn.classList.add('has-image');
      btn.style.backgroundImage = `url("${sound.imageDataUrl}")`;
    }

    const labelSpan = document.createElement('span');
    labelSpan.className = 'sound-btn-label';
    labelSpan.textContent = sound.name;
    btn.appendChild(labelSpan);

    if (activeSources.some(item => item.soundId === sound.id)) btn.classList.add('playing');
    if (smartSPMap.has(sound.id)) {
      const st = smartSPMap.get(sound.id);
      btn.classList.add('playing');
      updateButtonVisualState(btn, st.currentPhase, st.phases.length, st.spActive);
    }

    if (isEditMode) {
      btn.classList.add('edit-draggable');
      btn.draggable = true;
      const badge = document.createElement('span');
      badge.className = 'edit-badge';
      badge.textContent = sound.playbackType === 'seamless' ? `編集[SP×${(sound.seamlessPhases||[]).length}]` : (sound.playbackType === 'loop' ? '編集[ループ]' : '編集');
      btn.appendChild(badge);

      const reorderBar = document.createElement('div');
      reorderBar.className = 'mobile-reorder-bar';
      const prevBtn = document.createElement('button');
      prevBtn.type = 'button';
      prevBtn.className = 'btn-reorder-arrow';
      prevBtn.textContent = '◀';
      prevBtn.disabled = idx === 0;
      prevBtn.onclick = (e) => { e.stopPropagation(); moveSoundOrder(filtered, idx, -1); };
      const nextBtn = document.createElement('button');
      nextBtn.type = 'button';
      nextBtn.className = 'btn-reorder-arrow';
      nextBtn.textContent = '▶';
      nextBtn.disabled = idx === filtered.length - 1;
      nextBtn.onclick = (e) => { e.stopPropagation(); moveSoundOrder(filtered, idx, 1); };
      reorderBar.appendChild(prevBtn);
      reorderBar.appendChild(nextBtn);
      btn.appendChild(reorderBar);

      btn.ondragstart = (e) => { draggedSoundId = sound.id; btn.classList.add('dragging'); };
      btn.ondragend = () => { draggedSoundId = null; btn.classList.remove('dragging'); document.querySelectorAll('.sound-btn').forEach(el => el.classList.remove('drag-over')); };
      btn.ondragover = (e) => { if (!draggedSoundId || draggedSoundId === sound.id) return; e.preventDefault(); btn.classList.add('drag-over'); };
      btn.ondragleave = () => btn.classList.remove('drag-over');
      btn.ondrop = async (e) => {
        e.preventDefault();
        btn.classList.remove('drag-over');
        if (!draggedSoundId || draggedSoundId === sound.id) return;
        const currentCatList = sounds.filter(s => s.categoryId === currentCategoryId).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        const fromIdx = currentCatList.findIndex(s => s.id === draggedSoundId);
        const toIdx = currentCatList.findIndex(s => s.id === sound.id);
        if (fromIdx !== -1 && toIdx !== -1) {
          const [moved] = currentCatList.splice(fromIdx, 1);
          currentCatList.splice(toIdx, 0, moved);
          for (let i = 0; i < currentCatList.length; i++) {
            currentCatList[i].order = i;
            await dbPut('sounds', currentCatList[i]);
          }
          renderSounds();
        }
      };
    }

    btn.onclick = () => { if (isEditMode) openEditModal(sound); else handleSoundButtonPress(sound, btn); };
    grid.appendChild(btn);
  });
}

async function deleteCategory(catId) {
  await dbDelete('categories', catId);
  for (const s of sounds.filter(s => s.categoryId === catId)) {
    await dbDelete('sounds', s.id);
    decodedBufferCache.delete(s.id);
  }
  categories = categories.filter(c => c.id !== catId);
  sounds = sounds.filter(s => s.categoryId !== catId);
  currentCategoryId = categories[0].id;
  await saveCategoryOrders();
  renderCategories();
  renderSounds();
}

let editorAudioBuffer = null;
let editorPeaks = [];
const HIGH_RES_BINS = 3600;
let waveZoomFactor = 1.0;
let waveViewStartRatio = 0.0;
let previewSource = null;
let previewGainNode = null;
let previewAnimFrame = null;
let previewPlayheadTime = 0;
let isPreviewPaused = false;
let lastPreviewMode = 'normal';
let previewSmartState = null;

const waveCanvas = document.getElementById('waveform-canvas');
const waveCtx = waveCanvas.getContext('2d');
const wavePlaceholder = document.getElementById('waveform-placeholder');
const waveTotalDurationEl = document.getElementById('wave-total-duration');
const waveCurrentTimeEl = document.getElementById('wave-current-time');
const waveZoomSlider = document.getElementById('wave-zoom-slider');
const waveZoomLabel = document.getElementById('wave-zoom-label');
const wavePanBar = document.getElementById('wave-pan-bar');
const wavePanSlider = document.getElementById('wave-pan-slider');
const previewPauseBtn = document.getElementById('preview-pause-btn');

const trimStartInput = document.getElementById('btn-trim-start');
const trimEndInput = document.getElementById('btn-trim-end');
const globalTrimBox = document.getElementById('global-trim-box');
const playbackTypeSelect = document.getElementById('btn-playback-type');
const singleLoopBox = document.getElementById('single-loop-box');
const singleLoopInputs = document.getElementById('single-loop-inputs');
const singleLoopStartInput = document.getElementById('single-loop-start');
const singleLoopEndInput = document.getElementById('single-loop-end');
const seamlessPhasesBox = document.getElementById('seamless-phases-box');
const partialLoopInput = document.getElementById('btn-partial-loop-input');
const previewStartModeSelect = document.getElementById('preview-start-mode');

const currentPhaseLabel = document.getElementById('current-phase-label');
const phaseTrimStartInput = document.getElementById('phase-trim-start-input');
const phaseTrimEndInput = document.getElementById('phase-trim-end-input');
const phasePartialLoopInput = document.getElementById('phase-partial-loop-input');
const phaseLoopInputsRow = document.getElementById('phase-loop-inputs-row');
const phaseStartInput = document.getElementById('phase-start-input');
const phaseEndInput = document.getElementById('phase-end-input');

let currentEditingPhase = 0;
let selectedSPIndex = 0;
let soundPhasesData = [];

function updateLiveTimeDisplay(sec) {
  waveCurrentTimeEl.textContent = (sec === null || isNaN(sec)) ? '0s' : `${Math.floor(sec)}s`;
}

function updatePauseButtonUI() {
  const isPlayingOrPaused = Boolean(previewSource || previewSmartState || isPreviewPaused);
  previewPauseBtn.disabled = !isPlayingOrPaused;
  if (isPreviewPaused) {
    previewPauseBtn.textContent = '▶ 再開';
    previewPauseBtn.classList.add('paused');
  } else {
    previewPauseBtn.textContent = '⏸ 一時停止';
    previewPauseBtn.classList.remove('paused');
  }
}

function getViewportRange() {
  const span = 1.0 / waveZoomFactor;
  return { start: Math.max(0, Math.min(waveViewStartRatio, 1.0 - span)), span };
}

function secToCanvasX(sec, duration, width) {
  if (!duration || duration <= 0) return 0;
  const { start, span } = getViewportRange();
  return (((sec / duration) - start) / span) * width;
}

function canvasXToSec(clientX, duration) {
  const rect = waveCanvas.getBoundingClientRect();
  const localRatio = Math.max(0, Math.min((clientX - rect.left) / rect.width, 1));
  const { start, span } = getViewportRange();
  return Math.max(0, Math.min(start + localRatio * span, 1)) * duration;
}

function setViewportStart(newStartRatio) {
  const span = 1.0 / waveZoomFactor;
  waveViewStartRatio = Math.max(0, Math.min(newStartRatio, Math.max(0, 1.0 - span)));
  wavePanSlider.max = Math.max(0, 1.0 - span).toFixed(4);
  wavePanSlider.value = waveViewStartRatio.toFixed(4);
  drawWaveformCanvas();
}

function applyWaveformZoom(factor, focusSec = null) {
  const oldRange = getViewportRange();
  const centerRatio = (focusSec !== null && editorAudioBuffer && editorAudioBuffer.duration > 0) ? (focusSec / editorAudioBuffer.duration) : (oldRange.start + oldRange.span / 2);
  waveZoomFactor = factor;
  waveZoomLabel.textContent = `${factor.toFixed(1)}x`;
  waveZoomSlider.value = factor;
  if (waveZoomFactor > 1.0) wavePanBar.classList.remove('hidden');
  else wavePanBar.classList.add('hidden');
  setViewportStart(centerRatio - (1.0 / waveZoomFactor) / 2);
}

waveZoomSlider.oninput = () => applyWaveformZoom(parseFloat(waveZoomSlider.value), previewPlayheadTime ?? 0);
document.getElementById('wave-zoom-reset-btn').onclick = () => applyWaveformZoom(1.0, 0);
wavePanSlider.oninput = () => setViewportStart(parseFloat(wavePanSlider.value));
document.getElementById('wave-center-playhead-btn').onclick = () => {
  if (!editorAudioBuffer) return;
  setViewportStart((previewPlayheadTime ?? 0) / editorAudioBuffer.duration - (1.0 / waveZoomFactor) / 2);
};

document.querySelectorAll('input[name="drag-target"]').forEach(radio => {
  radio.addEventListener('change', () => waveCanvas.classList.toggle('pan-cursor', radio.value === 'pan'));
});

function getSelectedSeekOffset(trimStart, loopStart, loopEnd, selectedSP) {
  const mode = previewStartModeSelect.value;
  if (mode === 'trimStart') return trimStart;
  if (mode === 'beforeSP' && selectedSP !== null) return Math.max(trimStart, selectedSP - 3.0);
  if (mode === 'beforeLoopEnd') return Math.max(loopStart, loopEnd - 3.0);
  return loopStart;
}

function renderPhaseTabs() {
  const container = document.getElementById('phase-tabs-header');
  container.innerHTML = '';
  soundPhasesData.forEach((_, idx) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = `phase-tab ${idx === currentEditingPhase ? 'active' : ''}`;
    tab.textContent = `フェーズ ${idx + 1}`;
    tab.onclick = () => {
      currentEditingPhase = idx;
      selectedSPIndex = 0;
      if (previewSource || previewSmartState || isPreviewPaused) stopEditorPreview();
      renderPhaseTabs();
      updatePhaseInputsUI();
      drawWaveformCanvas();
    };
    container.appendChild(tab);
  });
  document.getElementById('remove-phase-btn').disabled = soundPhasesData.length <= 1;
}

function renderSPList() {
  const container = document.getElementById('sp-list-container');
  container.innerHTML = '';
  const phase = soundPhasesData[currentEditingPhase];
  if (!phase.sps || phase.sps.length === 0) phase.sps = [Number((((phase.trimStart ?? 0) + (phase.trimEnd ?? 5)) / 2).toFixed(2))];
  if (selectedSPIndex >= phase.sps.length) selectedSPIndex = phase.sps.length - 1;

  phase.sps.forEach((spVal, idx) => {
    const row = document.createElement('div');
    row.className = `sp-item-row ${idx === selectedSPIndex ? 'selected' : ''}`;
    row.onclick = (e) => {
      if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;
      selectedSPIndex = idx;
      document.querySelectorAll('.sp-item-row').forEach((r, i) => r.classList.toggle('selected', i === idx));
      drawWaveformCanvas();
    };

    const label = document.createElement('span');
    label.className = 'sp-item-label';
    label.textContent = `SP ${idx + 1}:`;

    const input = document.createElement('input');
    input.type = 'number';
    input.step = '0.01';
    input.min = '0';
    input.className = 'sp-item-input';
    input.value = Number(spVal).toFixed(2);
    input.oninput = () => { const v = parseFloat(input.value); if (!isNaN(v)) { phase.sps[idx] = v; drawWaveformCanvas(); } };

    row.appendChild(label);
    row.appendChild(input);

    if (phase.sps.length > 1) {
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'sp-item-del';
      delBtn.textContent = '削除';
      delBtn.onclick = () => {
        phase.sps.splice(idx, 1);
        if (selectedSPIndex >= phase.sps.length) selectedSPIndex = phase.sps.length - 1;
        renderSPList();
        drawWaveformCanvas();
      };
      row.appendChild(delBtn);
    }
    container.appendChild(row);
  });
}

function updatePhaseInputsUI() {
  const p = soundPhasesData[currentEditingPhase];
  currentPhaseLabel.textContent = `フェーズ ${currentEditingPhase + 1} の個別設定`;
  const tStart = p.trimStart ?? p.start ?? 0;
  const tEnd = p.trimEnd ?? p.end ?? 5;
  p.trimStart = tStart;
  p.trimEnd = tEnd;
  phaseTrimStartInput.value = Number(tStart).toFixed(2);
  phaseTrimEndInput.value = Number(tEnd).toFixed(2);
  phasePartialLoopInput.checked = Boolean(p.isPartialLoop);
  phaseLoopInputsRow.classList.toggle('hidden', !p.isPartialLoop);
  if (!p.isPartialLoop) { p.start = tStart; p.end = tEnd; }
  phaseStartInput.value = Number(p.start).toFixed(2);
  phaseEndInput.value = Number(p.end).toFixed(2);
  renderSPList();
}

document.getElementById('add-phase-btn').onclick = () => {
  const dur = editorAudioBuffer ? editorAudioBuffer.duration : 15;
  const last = soundPhasesData[soundPhasesData.length - 1];
  const s = last ? (last.trimEnd ?? last.end) : 0;
  const e = Math.max(s + 1.0, dur);
  soundPhasesData.push({ trimStart: Number(s.toFixed(2)), trimEnd: Number(e.toFixed(2)), isPartialLoop: false, start: Number(s.toFixed(2)), end: Number(e.toFixed(2)), sps: [Number(((s + e) / 2).toFixed(2))] });
  currentEditingPhase = soundPhasesData.length - 1;
  selectedSPIndex = 0;
  renderPhaseTabs();
  updatePhaseInputsUI();
  drawWaveformCanvas();
};

document.getElementById('remove-phase-btn').onclick = () => {
  if (soundPhasesData.length <= 1) return;
  soundPhasesData.splice(currentEditingPhase, 1);
  if (currentEditingPhase >= soundPhasesData.length) currentEditingPhase = soundPhasesData.length - 1;
  selectedSPIndex = 0;
  renderPhaseTabs();
  updatePhaseInputsUI();
  drawWaveformCanvas();
};

document.getElementById('add-sp-btn').onclick = () => {
  const phase = soundPhasesData[currentEditingPhase];
  const s = phase.isPartialLoop ? phase.start : phase.trimStart;
  const e = phase.isPartialLoop ? phase.end : phase.trimEnd;
  phase.sps.push(Number(((s + e) / 2).toFixed(2)));
  selectedSPIndex = phase.sps.length - 1;
  renderSPList();
  drawWaveformCanvas();
};

function computeWaveformPeaks(audioBuffer, numBins = HIGH_RES_BINS) {
  const channelData = audioBuffer.getChannelData(0);
  const blockSize = Math.floor(channelData.length / numBins) || 1;
  const peaks = [];
  for (let i = 0; i < numBins; i++) {
    let max = 0;
    const start = i * blockSize;
    for (let j = 0; j < blockSize && start + j < channelData.length; j++) {
      const val = Math.abs(channelData[start + j]);
      if (val > max) max = val;
    }
    peaks.push(max);
  }
  return peaks;
}

function drawWaveformCanvas() {
  const width = waveCanvas.width;
  const height = waveCanvas.height;
  waveCtx.clearRect(0, 0, width, height);

  if (!editorAudioBuffer || editorPeaks.length === 0) {
    wavePlaceholder.classList.remove('hidden');
    return;
  }
  wavePlaceholder.classList.add('hidden');

  const duration = editorAudioBuffer.duration;
  const { start: viewStart, end: viewEnd, span: viewSpan } = getViewportRange();
  const pType = playbackTypeSelect.value;

  let activeTrimStart = 0;
  let activeTrimEnd = duration;
  if (pType === 'seamless') {
    const bounds = getNormalizedPhaseBounds(soundPhasesData[currentEditingPhase], duration);
    activeTrimStart = bounds.trimStart;
    activeTrimEnd = bounds.trimEnd;
  } else {
    activeTrimStart = Math.max(0, Math.min(parseFloat(trimStartInput.value) || 0, duration));
    activeTrimEnd = Math.max(activeTrimStart, Math.min(parseFloat(trimEndInput.value) || duration, duration));
  }

  const trimStartX = secToCanvasX(activeTrimStart, duration, width);
  const trimEndX = secToCanvasX(activeTrimEnd, duration, width);

  waveCtx.fillStyle = 'rgba(0, 0, 0, 0.68)';
  if (trimStartX > 0) waveCtx.fillRect(0, 0, Math.min(width, trimStartX), height);
  if (trimEndX < width) waveCtx.fillRect(Math.max(0, trimEndX), 0, width - Math.max(0, trimEndX), height);

  const totalBins = editorPeaks.length;
  const startBin = Math.floor(viewStart * totalBins);
  const endBin = Math.min(totalBins, Math.ceil(viewEnd * totalBins));
  const visibleBinsCount = Math.max(1, endBin - startBin);
  const barWidth = width / visibleBinsCount;
  const midY = height / 2;

  for (let idx = startBin; idx < endBin; idx++) {
    const x = (idx - startBin) * barWidth;
    const barHeight = Math.max(2, editorPeaks[idx] * (height * 0.76));
    const binSec = (idx / totalBins) * duration;
    waveCtx.fillStyle = (binSec >= activeTrimStart && binSec <= activeTrimEnd) ? '#4fc3f7' : '#333333';
    waveCtx.fillRect(x, midY - barHeight / 2, Math.max(1, barWidth - 0.3), barHeight);
  }

  waveCtx.strokeStyle = '#ffb74d';
  waveCtx.lineWidth = 2;
  waveCtx.beginPath();
  waveCtx.moveTo(trimStartX, 0); waveCtx.lineTo(trimStartX, height);
  waveCtx.moveTo(trimEndX, 0); waveCtx.lineTo(trimEndX, height);
  waveCtx.stroke();

  if (pType === 'seamless') {
    const p = soundPhasesData[currentEditingPhase];
    const bounds = getNormalizedPhaseBounds(p, duration);
    if (bounds.isPartialLoop) {
      waveCtx.strokeStyle = '#00e676'; waveCtx.beginPath(); waveCtx.moveTo(secToCanvasX(bounds.loopStart, duration, width), 0); waveCtx.lineTo(secToCanvasX(bounds.loopStart, duration, width), height); waveCtx.stroke();
      waveCtx.strokeStyle = '#ff5252'; waveCtx.beginPath(); waveCtx.moveTo(secToCanvasX(bounds.loopEnd, duration, width), 0); waveCtx.lineTo(secToCanvasX(bounds.loopEnd, duration, width), height); waveCtx.stroke();
    }
    (p.sps || []).forEach((spVal, idx) => {
      waveCtx.strokeStyle = idx === selectedSPIndex ? '#ffeb3b' : 'rgba(255, 235, 59, 0.55)';
      waveCtx.lineWidth = idx === selectedSPIndex ? 2.8 : 1.5;
      waveCtx.beginPath(); waveCtx.moveTo(secToCanvasX(spVal, duration, width), 0); waveCtx.lineTo(secToCanvasX(spVal, duration, width), height); waveCtx.stroke();
    });
  }

  if (duration > 0 && previewPlayheadTime !== null) {
    const playX = secToCanvasX(previewPlayheadTime, duration, width);
    waveCtx.strokeStyle = '#ffffff';
    waveCtx.lineWidth = 2;
    waveCtx.beginPath(); waveCtx.moveTo(playX, 0); waveCtx.lineTo(playX, height); waveCtx.stroke();
  }
}

async function loadBufferIntoEditor(arrayBuffer, tStart = null, tEnd = null, phases = null, lStart = null, lEnd = null) {
  ensureAudioContext();
  editorAudioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
  editorPeaks = computeWaveformPeaks(editorAudioBuffer, HIGH_RES_BINS);
  const dur = editorAudioBuffer.duration;
  waveTotalDurationEl.textContent = dur.toFixed(2);
  previewPlayheadTime = tStart !== null ? Number(tStart) : 0;
  updateLiveTimeDisplay(previewPlayheadTime);

  trimStartInput.max = dur.toFixed(2);
  trimEndInput.max = dur.toFixed(2);
  trimStartInput.value = tStart !== null ? Number(tStart).toFixed(2) : '0.00';
  trimEndInput.value = (tEnd !== null) ? Number(tEnd).toFixed(2) : dur.toFixed(2);

  if (phases && phases.length > 0) {
    soundPhasesData = JSON.parse(JSON.stringify(phases));
  } else {
    const step = dur / 3;
    soundPhasesData = [
      { trimStart: 0, trimEnd: Number(step.toFixed(2)), isPartialLoop: false, start: 0, end: Number(step.toFixed(2)), sps: [Number((step * 0.5).toFixed(2))] },
      { trimStart: Number(step.toFixed(2)), trimEnd: Number((step * 2).toFixed(2)), isPartialLoop: false, start: Number(step.toFixed(2)), end: Number((step * 2).toFixed(2)), sps: [Number((step * 1.5).toFixed(2))] },
      { trimStart: Number((step * 2).toFixed(2)), trimEnd: Number(dur.toFixed(2)), isPartialLoop: false, start: Number((step * 2).toFixed(2)), end: Number(dur.toFixed(2)), sps: [Number((step * 2.5).toFixed(2))] }
    ];
  }
  currentEditingPhase = 0;
  selectedSPIndex = 0;
  renderPhaseTabs();
  updatePhaseInputsUI();
  applyWaveformZoom(1.0, 0);
}

function clearRunningAudioNodesOnly() {
  if (previewSource) { try { previewSource.stop(); } catch (e) {} previewSource = null; }
  if (previewSmartState) {
    previewSmartState.isStopped = true;
    if (previewSmartState.monitorInterval) clearInterval(previewSmartState.monitorInterval);
    if (previewSmartState.currentSource) { try { previewSmartState.currentSource.stop(); } catch (e) {} }
    previewSmartState = null;
  }
  if (previewAnimFrame) { cancelAnimationFrame(previewAnimFrame); previewAnimFrame = null; }
}

function stopEditorPreview() {
  clearRunningAudioNodesOnly();
  isPreviewPaused = false;
  previewPlayheadTime = parseFloat(trimStartInput.value) || 0;
  updateLiveTimeDisplay(previewPlayheadTime);
  resetSPTestButtonUI();
  updatePauseButtonUI();
  drawWaveformCanvas();
}

function startEditorPreview(useSeekMode = false) {
  if (!editorAudioBuffer) { alert('先に音声ファイルを読み込んでください'); return; }
  clearRunningAudioNodesOnly();
  isPreviewPaused = false;
  lastPreviewMode = useSeekMode ? 'seek' : 'normal';
  resetSPTestButtonUI();

  const duration = editorAudioBuffer.duration;
  const pType = playbackTypeSelect.value;
  let tStart = Math.max(0, Math.min(parseFloat(trimStartInput.value) || 0, duration));
  let tEnd = Math.max(tStart + 0.05, Math.min(parseFloat(trimEndInput.value) || duration, duration));
  let lStart = tStart, lEnd = tEnd, isLoop = pType === 'loop' || pType === 'seamless', selSP = null;

  if (pType === 'seamless') {
    const p = soundPhasesData[currentEditingPhase];
    const bounds = getNormalizedPhaseBounds(p, duration);
    tStart = bounds.trimStart; tEnd = bounds.trimEnd; lStart = bounds.loopStart; lEnd = bounds.loopEnd;
    selSP = (p.sps && p.sps[selectedSPIndex] !== undefined) ? p.sps[selectedSPIndex] : null;
  }

  const offset = useSeekMode ? getSelectedSeekOffset(tStart, lStart, lEnd, selSP) : tStart;
  startEditorPreviewAtOffset(offset, isLoop, lStart, lEnd, tEnd);
}

function startEditorPreviewAtOffset(safeOffset, isLoop, lStart, lEnd, tEnd) {
  ensureAudioContext();
  clearRunningAudioNodesOnly();

  previewSource = audioCtx.createBufferSource();
  previewSource.buffer = editorAudioBuffer;
  if (isLoop) {
    previewSource.loop = true;
    previewSource.loopStart = lStart;
    previewSource.loopEnd = lEnd;
  } else {
    previewSource.loop = false;
  }

  previewGainNode = audioCtx.createGain();
  previewGainNode.gain.value = (Number(document.getElementById('btn-volume-input').value) || 100) / 100;
  previewSource.connect(previewGainNode);
  previewGainNode.connect(audioCtx.destination);

  const startCtxTime = audioCtx.currentTime;
  if (isLoop) previewSource.start(startCtxTime, safeOffset);
  else previewSource.start(startCtxTime, safeOffset, Math.max(0.05, tEnd - safeOffset));
  updatePauseButtonUI();

  function updatePlayhead() {
    if (!previewSource) return;
    let currentPos = safeOffset + (audioCtx.currentTime - startCtxTime);
    if (isLoop && currentPos >= lEnd) {
      const loopLen = lEnd - lStart;
      if (loopLen > 0) currentPos = lStart + ((currentPos - lStart) % loopLen);
    } else if (!isLoop && currentPos >= tEnd) {
      stopEditorPreview();
      return;
    }
    previewPlayheadTime = currentPos;
    updateLiveTimeDisplay(currentPos);
    drawWaveformCanvas();
    previewAnimFrame = requestAnimationFrame(updatePlayhead);
  }
  previewAnimFrame = requestAnimationFrame(updatePlayhead);
}

function startEditorSPPreview() {
  ensureAudioContext();
  if (previewSmartState && !previewSmartState.isPausedPlaceholder) {
    previewSmartState.spActive = !previewSmartState.spActive;
    updateSPTestButtonUI(previewSmartState.spActive);
    return;
  }
  if (!editorAudioBuffer) { alert('先に音声ファイルを読み込んでください'); return; }
  const p0 = soundPhasesData[currentEditingPhase];
  const bounds = getNormalizedPhaseBounds(p0, editorAudioBuffer.duration);
  const selSP = (p0.sps && p0.sps[selectedSPIndex] !== undefined) ? p0.sps[selectedSPIndex] : null;
  startEditorSPPreviewAtOffset(getSelectedSeekOffset(bounds.trimStart, bounds.loopStart, bounds.loopEnd, selSP), false);
}

function startEditorSPPreviewAtOffset(customOffset, initialSPActive) {
  ensureAudioContext();
  clearRunningAudioNodesOnly();
  isPreviewPaused = false;
  lastPreviewMode = 'sp';

  const gainNode = audioCtx.createGain();
  gainNode.gain.value = (Number(document.getElementById('btn-volume-input').value) || 100) / 100;
  gainNode.connect(audioCtx.destination);

  const state = {
    audioBuffer: editorAudioBuffer, phases: soundPhasesData, gainNode,
    currentPhase: currentEditingPhase, spActive: initialSPActive, currentSource: null,
    segmentStartCtxTime: 0, segmentInitialOffset: 0, lastCheckedPos: 0, monitorInterval: null, isStopped: false
  };
  previewSmartState = state;
  updateSPTestButtonUI(initialSPActive);
  updatePauseButtonUI();
  playEditorSPSegment(state, currentEditingPhase, customOffset);
}

function playEditorSPSegment(state, phaseIndex, startOffset) {
  if (state.isStopped) return;
  state.currentPhase = phaseIndex;
  const phase = state.phases[phaseIndex];
  const bounds = getNormalizedPhaseBounds(phase, state.audioBuffer.duration);

  const source = audioCtx.createBufferSource();
  source.buffer = state.audioBuffer;
  source.loop = true;
  source.loopStart = bounds.loopStart;
  source.loopEnd = bounds.loopEnd;
  source.connect(state.gainNode);
  state.currentSource = source;

  const startTime = audioCtx.currentTime;
  source.start(startTime, startOffset);
  state.segmentStartCtxTime = startTime;
  state.segmentInitialOffset = startOffset;
  state.lastCheckedPos = startOffset;

  if (state.monitorInterval) clearInterval(state.monitorInterval);
  state.monitorInterval = setInterval(() => {
    if (state.isStopped || !state.currentSource) { clearInterval(state.monitorInterval); return; }
    const now = audioCtx.currentTime;
    const currPos = getBufferPosAtTime(state, bounds, now);
    const prevPos = state.lastCheckedPos;
    state.lastCheckedPos = currPos;

    previewPlayheadTime = currPos;
    updateLiveTimeDisplay(currPos);
    drawWaveformCanvas();

    if (state.spActive) {
      const exitPoint = findExitPoint(prevPos, currPos, bounds.trimStart, bounds.loopEnd, phase.sps);
      if (exitPoint !== null) {
        clearInterval(state.monitorInterval);
        try { state.currentSource.stop(); } catch (e) {}
        const nextPhaseIndex = phaseIndex + 1;
        if (nextPhaseIndex >= state.phases.length) { stopEditorPreview(); return; }
        currentEditingPhase = nextPhaseIndex;
        renderPhaseTabs();
        updatePhaseInputsUI();
        state.spActive = false;
        updateSPTestButtonUI(false);
        playEditorSPSegment(state, nextPhaseIndex, getNormalizedPhaseBounds(state.phases[nextPhaseIndex], state.audioBuffer.duration).trimStart);
      }
    }
  }, 10);
}

function updateSPTestButtonUI(isOn) {
  const spBtn = document.getElementById('preview-sp-btn');
  if (isOn) {
    spBtn.textContent = '⚡ SP試聴 [ON 🟢]';
    spBtn.style.background = '#00e676';
    spBtn.style.color = '#000';
  } else {
    spBtn.textContent = (previewSmartState && !previewSmartState.isPausedPlaceholder) ? '⚡ SP試聴 [OFF 🔴]' : '⚡ SP試聴 [OFF]';
    spBtn.style.background = '#f57f17';
    spBtn.style.color = '#000';
  }
}

function resetSPTestButtonUI() {
  const spBtn = document.getElementById('preview-sp-btn');
  spBtn.textContent = '⚡ SP試聴 [OFF]';
  spBtn.style.background = '#f57f17';
  spBtn.style.color = '#000';
  previewSmartState = null;
}

let isDraggingWave = false;
let panDragStartX = 0;
let panInitialViewStart = 0;

function updateMarkerFromPointer(clientX, isDragEnd = false) {
  if (!editorAudioBuffer) return;
  const dur = editorAudioBuffer.duration;
  const targetMode = document.querySelector('input[name="drag-target"]:checked').value;

  if (targetMode === 'pan') {
    const rect = waveCanvas.getBoundingClientRect();
    setViewportStart(panInitialViewStart - (((clientX - panDragStartX) / rect.width) * (1.0 / waveZoomFactor)));
    return;
  }

  const clickedSec = canvasXToSec(clientX, dur);
  const pType = playbackTypeSelect.value;

  if (targetMode === 'playhead') {
    previewPlayheadTime = clickedSec;
    updateLiveTimeDisplay(clickedSec);
    drawWaveformCanvas();
    if (isDragEnd && !isPreviewPaused) {
      if (previewSmartState && !previewSmartState.isPausedPlaceholder) startEditorSPPreviewAtOffset(clickedSec, previewSmartState.spActive);
      else if (previewSource) startEditorPreview(lastPreviewMode === 'seek');
    }
    return;
  }

  if (targetMode === 'trimStart') {
    if (pType === 'seamless') {
      const p = soundPhasesData[currentEditingPhase];
      p.trimStart = Number(Math.max(0, Math.min(clickedSec, (p.trimEnd ?? dur) - 0.05)).toFixed(2));
      if (!p.isPartialLoop) p.start = p.trimStart;
      updatePhaseInputsUI();
    } else {
      trimStartInput.value = Math.max(0, Math.min(clickedSec, (parseFloat(trimEndInput.value) || dur) - 0.05)).toFixed(2);
    }
  } else if (targetMode === 'trimEnd') {
    if (pType === 'seamless') {
      const p = soundPhasesData[currentEditingPhase];
      p.trimEnd = Number(Math.min(dur, Math.max(clickedSec, (p.trimStart ?? 0) + 0.05)).toFixed(2));
      if (!p.isPartialLoop) p.end = p.trimEnd;
      updatePhaseInputsUI();
    } else {
      trimEndInput.value = Math.min(dur, Math.max(clickedSec, (parseFloat(trimStartInput.value) || 0) + 0.05)).toFixed(2);
    }
  } else if (targetMode === 'selectedSP' && pType === 'seamless') {
    const p = soundPhasesData[currentEditingPhase];
    const bounds = getNormalizedPhaseBounds(p, dur);
    p.sps[selectedSPIndex] = Number(Math.max(bounds.trimStart, Math.min(clickedSec, bounds.loopEnd)).toFixed(2));
    renderSPList();
  }

  if (previewSource || previewSmartState) stopEditorPreview();
  drawWaveformCanvas();
}

waveCanvas.addEventListener('pointerdown', (e) => {
  isDraggingWave = true;
  panDragStartX = e.clientX;
  panInitialViewStart = waveViewStartRatio;
  waveCanvas.setPointerCapture(e.pointerId);
  updateMarkerFromPointer(e.clientX, false);
});
waveCanvas.addEventListener('pointermove', (e) => { if (isDraggingWave) updateMarkerFromPointer(e.clientX, false); });
waveCanvas.addEventListener('pointerup', (e) => {
  if (isDraggingWave) {
    isDraggingWave = false;
    waveCanvas.releasePointerCapture(e.pointerId);
    updateMarkerFromPointer(e.clientX, true);
  }
});

document.querySelectorAll('.btn-nudge').forEach(btn => {
  btn.onclick = () => {
    if (!editorAudioBuffer) return;
    const target = btn.dataset.target;
    const delta = parseFloat(btn.dataset.delta);
    const dur = editorAudioBuffer.duration;
    const p = soundPhasesData[currentEditingPhase];

    if (target === 'phaseTrimStart') {
      p.trimStart = Number(Math.max(0, Math.min((p.trimStart ?? 0) + delta, (p.trimEnd ?? dur) - 0.01)).toFixed(2));
      if (!p.isPartialLoop) p.start = p.trimStart;
      updatePhaseInputsUI();
    } else if (target === 'phaseTrimEnd') {
      p.trimEnd = Number(Math.max((p.trimStart ?? 0) + 0.01, Math.min((p.trimEnd ?? dur) + delta, dur)).toFixed(2));
      if (!p.isPartialLoop) p.end = p.trimEnd;
      updatePhaseInputsUI();
    } else if (target === 'selectedSP') {
      const bounds = getNormalizedPhaseBounds(p, dur);
      p.sps[selectedSPIndex] = Number(Math.max(bounds.trimStart, Math.min((p.sps[selectedSPIndex] ?? bounds.trimStart) + delta, bounds.loopEnd)).toFixed(2));
      renderSPList();
    }
    if (previewSource || previewSmartState) stopEditorPreview();
    drawWaveformCanvas();
  };
});

document.getElementById('preview-play-btn').onclick = () => startEditorPreview(false);
document.getElementById('preview-loop-btn').onclick = () => startEditorPreview(true);
document.getElementById('preview-sp-btn').onclick = startEditorSPPreview;
previewPauseBtn.onclick = () => {
  if (!editorAudioBuffer) return;
  if (!isPreviewPaused && (previewSource || previewSmartState)) {
    const wasSP = Boolean(previewSmartState);
    const savedSPActive = wasSP ? previewSmartState.spActive : false;
    clearRunningAudioNodesOnly();
    isPreviewPaused = true;
    if (wasSP) previewSmartState = { isPausedPlaceholder: true, spActive: savedSPActive };
    updatePauseButtonUI();
    drawWaveformCanvas();
  } else if (isPreviewPaused) {
    isPreviewPaused = false;
    const resumePos = previewPlayheadTime ?? (parseFloat(trimStartInput.value) || 0);
    if (lastPreviewMode === 'sp') startEditorSPPreviewAtOffset(resumePos, previewSmartState ? previewSmartState.spActive : false);
    else startEditorPreview(lastPreviewMode === 'seek');
  }
};
document.getElementById('preview-stop-btn').onclick = stopEditorPreview;

const modal = document.getElementById('sound-modal');
const fileInput = document.getElementById('audio-file-input');
const nameInput = document.getElementById('btn-name-input');
const imageInput = document.getElementById('btn-image-input');
const clearImageBtn = document.getElementById('clear-image-btn');
const imagePreviewBox = document.getElementById('btn-image-preview-box');
const imagePreviewImg = document.getElementById('btn-image-preview');
const colorInput = document.getElementById('btn-color-input');
const volumeInput = document.getElementById('btn-volume-input');
const volumeLabel = document.getElementById('volume-label');
const deleteBtn = document.getElementById('delete-sound-btn');
const fileGroup = document.getElementById('file-input-group');
let currentImageDataUrl = null;

function setModalImagePreview(dataUrl) {
  currentImageDataUrl = dataUrl || null;
  if (currentImageDataUrl) {
    imagePreviewImg.src = currentImageDataUrl;
    imagePreviewBox.classList.remove('hidden');
    clearImageBtn.classList.remove('hidden');
  } else {
    imagePreviewImg.src = '';
    imagePreviewBox.classList.add('hidden');
    clearImageBtn.classList.add('hidden');
    imageInput.value = '';
  }
}

imageInput.onchange = () => {
  if (imageInput.files && imageInput.files[0]) {
    const reader = new FileReader();
    reader.onload = (e) => setModalImagePreview(e.target.result);
    reader.readAsDataURL(imageInput.files[0]);
  }
};
clearImageBtn.onclick = () => setModalImagePreview(null);

playbackTypeSelect.onchange = () => {
  const val = playbackTypeSelect.value;
  singleLoopBox.classList.toggle('hidden', val !== 'loop');
  seamlessPhasesBox.classList.toggle('hidden', val !== 'seamless');
  globalTrimBox.classList.toggle('hidden', val === 'seamless');
  document.getElementById('preview-sp-btn').classList.toggle('hidden', val !== 'seamless');
  document.getElementById('preview-loop-btn').classList.toggle('hidden', val === 'normal');
  document.getElementById('preview-seek-box').classList.toggle('hidden', val === 'normal');
  if (val === 'seamless') { renderPhaseTabs(); updatePhaseInputsUI(); }
  drawWaveformCanvas();
};

const overwriteModeSelect = document.getElementById('btn-overwrite-mode');
const targetSoundGroup = document.getElementById('target-sound-group');
const targetSoundSelect = document.getElementById('btn-target-sound');
const disableOverwriteInput = document.getElementById('btn-disable-overwrite');

overwriteModeSelect.onchange = () => {
  targetSoundGroup.classList.toggle('hidden', overwriteModeSelect.value !== 'conditional');
  if (overwriteModeSelect.value === 'conditional') {
    targetSoundSelect.innerHTML = '';
    sounds.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      targetSoundSelect.appendChild(opt);
    });
  }
};

function closeModal() { stopEditorPreview(); modal.classList.add('hidden'); }

function openAddModal() {
  editingSoundId = null;
  editorAudioBuffer = null;
  editorPeaks = [];
  waveTotalDurationEl.textContent = '0.00';
  previewPlayheadTime = 0;
  updateLiveTimeDisplay(0);
  applyWaveformZoom(1.0, 0);

  document.getElementById('modal-title').innerHTML = '新規音源を追加 <span class="ver-tag">ver5.3</span>';
  fileGroup.classList.remove('hidden');
  deleteBtn.classList.add('hidden');
  fileInput.value = '';
  nameInput.value = '';
  setModalImagePreview(null);
  colorInput.value = '#d32f2f';
  volumeInput.value = 100;
  volumeLabel.textContent = '100';

  soundPhasesData = [
    { trimStart: 0, trimEnd: 5, isPartialLoop: false, start: 0, end: 5, sps: [2.5] },
    { trimStart: 5, trimEnd: 10, isPartialLoop: false, start: 5, end: 10, sps: [7.5] },
    { trimStart: 10, trimEnd: 15, isPartialLoop: false, start: 10, end: 15, sps: [12.5] }
  ];
  currentEditingPhase = 0;
  selectedSPIndex = 0;
  playbackTypeSelect.value = 'normal';
  playbackTypeSelect.onchange();
  updatePauseButtonUI();
  modal.classList.remove('hidden');
}

async function openEditModal(sound) {
  editingSoundId = sound.id;
  document.getElementById('modal-title').innerHTML = 'ボタンを編集 <span class="ver-tag">ver5.3</span>';
  fileGroup.classList.add('hidden');
  deleteBtn.classList.remove('hidden');
  nameInput.value = sound.name;
  setModalImagePreview(sound.imageDataUrl || null);
  colorInput.value = sound.color;
  volumeInput.value = sound.volume ?? 100;
  volumeLabel.textContent = sound.volume ?? 100;
  playbackTypeSelect.value = sound.playbackType || 'normal';
  playbackTypeSelect.onchange();

  overwriteModeSelect.value = sound.overwriteMode || 'none';
  if (sound.overwriteMode === 'conditional') {
    targetSoundGroup.classList.remove('hidden');
    targetSoundSelect.innerHTML = '';
    sounds.forEach(s => {
      if (s.id !== sound.id) {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = s.name;
        targetSoundSelect.appendChild(opt);
      }
    });
    targetSoundSelect.value = sound.targetSoundId || '';
  } else {
    targetSoundGroup.classList.add('hidden');
  }
  disableOverwriteInput.checked = !!sound.disableOverwrite;
  updatePauseButtonUI();
  modal.classList.remove('hidden');

  if (sound.audioData) {
    await loadBufferIntoEditor(sound.audioData, sound.trimStart ?? 0, sound.trimEnd ?? null, sound.seamlessPhases ?? null);
  }
}

document.getElementById('stop-all-btn').onclick = stopAllSounds;
document.getElementById('toggle-edit-btn').onclick = (e) => {
  isEditMode = !isEditMode;
  e.target.textContent = `⚙ 編集: ${isEditMode ? 'ON' : 'OFF'}`;
  e.target.classList.toggle('active', isEditMode);
  document.getElementById('edit-mode-banner').classList.toggle('hidden', !isEditMode);
  renderCategories();
  renderSounds();
};

document.getElementById('add-category-btn').onclick = async () => {
  const name = prompt('新しいカテゴリ名を入力してください');
  if (!name || !name.trim()) return;
  const newCat = { id: 'cat_' + Date.now(), name: name.trim(), order: categories.length };
  await dbPut('categories', newCat);
  categories.push(newCat);
  currentCategoryId = newCat.id;
  renderCategories();
  renderSounds();
};

document.getElementById('export-backup-btn').onclick = async () => {
  try {
    stopAllSounds();
    const allCats = await dbGetAll('categories');
    const allSoundsRaw = await dbGetAll('sounds');
    const allSounds = allSoundsRaw.map(s => {
      let b64 = null;
      if (s.audioData) {
        const bytes = new Uint8Array(s.audioData);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
        b64 = btoa(binary);
      }
      return { ...s, audioDataB64: b64, audioData: undefined };
    });
    const backupData = { version: '5.3', exportDate: new Date().toISOString(), categories: allCats, sounds: allSounds };
    const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `soundboard_backup_lv5_${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err) {
    alert('バックアップの書き出しに失敗しました: ' + err.message);
  }
};

const importFileInput = document.getElementById('import-file-input');
const importModeModal = document.getElementById('import-mode-modal');
let pendingImportBackupData = null;

document.getElementById('import-backup-btn').onclick = () => importFileInput.click();

importFileInput.onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (event) => {
    try {
      const backup = JSON.parse(event.target.result);
      if (!backup.categories || !backup.sounds) throw new Error('無効なファイル形式です。');
      pendingImportBackupData = backup;
      importModeModal.classList.remove('hidden');
      importFileInput.value = '';
    } catch (err) {
      alert('ファイルの読み込みに失敗しました: ' + err.message);
      importFileInput.value = '';
    }
  };
  reader.readAsText(file);
};

document.getElementById('import-cancel-btn').onclick = () => { pendingImportBackupData = null; importModeModal.classList.add('hidden'); };

document.getElementById('import-merge-btn').onclick = async () => {
  if (!pendingImportBackupData) return;
  importModeModal.classList.add('hidden');
  try {
    stopAllSounds();
    const backup = pendingImportBackupData;
    pendingImportBackupData = null;
    const existingCats = await dbGetAll('categories');
    const existingSounds = await dbGetAll('sounds');
    const catMap = new Map();
    existingCats.forEach(c => catMap.set(c.name, c));
    let maxCatOrder = existingCats.reduce((m, c) => Math.max(m, c.order ?? 0), 0);

    for (const incCat of backup.categories) {
      if (!catMap.has(incCat.name)) {
        maxCatOrder++;
        const newCat = { ...incCat, order: maxCatOrder };
        await dbPut('categories', newCat);
        catMap.set(newCat.name, newCat);
      }
    }

    const soundNameSet = new Set(existingSounds.map(s => s.name));
    let maxSoundOrder = existingSounds.reduce((m, s) => Math.max(m, s.order ?? 0), 0);

    for (const incS of backup.sounds) {
      if (!soundNameSet.has(incS.name)) {
        let ab = null;
        if (incS.audioDataB64) {
          const bin = atob(incS.audioDataB64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          ab = bytes.buffer;
        }
        const matchedIncCat = backup.categories.find(c => c.id === incS.categoryId);
        const resolvedCat = catMap.get(matchedIncCat ? matchedIncCat.name : existingCats[0].name) || existingCats[0];
        maxSoundOrder++;
        await dbPut('sounds', {
          ...incS, id: 'snd_' + Date.now() + '_' + Math.floor(Math.random()*1000),
          categoryId: resolvedCat.id, order: maxSoundOrder, audioDataB64: undefined, audioData: ab
        });
        soundNameSet.add(incS.name);
      }
    }

    categories = await dbGetAll('categories');
    sounds = await dbGetAll('sounds');
    categories.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    currentCategoryId = categories.length > 0 ? categories[0].id : null;
    decodedBufferCache.clear();
    renderCategories();
    renderSounds();
    alert('スマート・マージ（追加統合）が完了しました！');
  } catch (err) {
    alert('マージ処理に失敗しました: ' + err.message);
  }
};

document.getElementById('import-overwrite-btn').onclick = async () => {
  if (!pendingImportBackupData) return;
  if (!confirm('現在のデータがすべて消去され、ファイルの状態に完全上書きされます。よろしいですか？')) return;
  importModeModal.classList.add('hidden');
  try {
    stopAllSounds();
    const backup = pendingImportBackupData;
    pendingImportBackupData = null;
    await dbClear('categories');
    await dbClear('sounds');
    decodedBufferCache.clear();

    for (const cat of backup.categories) await dbPut('categories', cat);
    for (const s of backup.sounds) {
      let ab = null;
      if (s.audioDataB64) {
        const bin = atob(s.audioDataB64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        ab = bytes.buffer;
      }
      await dbPut('sounds', { ...s, audioDataB64: undefined, audioData: ab });
    }

    categories = await dbGetAll('categories');
    sounds = await dbGetAll('sounds');
    categories.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    currentCategoryId = categories.length > 0 ? categories[0].id : null;
    renderCategories();
    renderSounds();
    alert('完全上書きによる復元・同期が完了しました！');
  } catch (err) {
    alert('上書き処理に失敗しました: ' + err.message);
  }
};

document.getElementById('open-add-modal-btn').onclick = openAddModal;
document.getElementById('cancel-modal-btn').onclick = closeModal;
document.getElementById('close-modal-x-btn').onclick = closeModal;

volumeInput.oninput = () => {
  volumeLabel.textContent = volumeInput.value;
  if (previewGainNode) previewGainNode.gain.value = Number(volumeInput.value) / 100;
};

document.querySelectorAll('.color-swatch').forEach(sw => sw.onclick = () => colorInput.value = sw.dataset.color);

fileInput.onchange = async () => {
  if (fileInput.files.length > 0) {
    const file = fileInput.files[0];
    if (!nameInput.value) nameInput.value = file.name.replace(/\.[^/.]+$/, '');
    try {
      const ab = await file.arrayBuffer();
      await loadBufferIntoEditor(ab);
    } catch (e) {
      try {
        const vEl = document.createElement('video');
        vEl.src = URL.createObjectURL(file);
        await new Promise((res, rej) => { vEl.onloadedmetadata = res; vEl.onerror = rej; });
        const res = await fetch(vEl.src);
        const ab = await res.arrayBuffer();
        URL.revokeObjectURL(vEl.src);
        await loadBufferIntoEditor(ab);
      } catch (err) {
        alert('ファイル読み込みに失敗しました。');
      }
    }
  }
};

document.getElementById('save-sound-btn').onclick = async () => {
  const name = nameInput.value.trim() || '無題のSE';
  const color = colorInput.value;
  const imageDataUrl = currentImageDataUrl;
  const volume = Number(volumeInput.value);
  const playbackType = playbackTypeSelect.value;
  const isPartialLoop = playbackType === 'loop' && partialLoopInput.checked;
  const trimStart = parseFloat(trimStartInput.value) || 0;
  const trimEnd = trimEndInput.value !== '' ? parseFloat(trimEndInput.value) : null;
  const seamlessPhases = JSON.parse(JSON.stringify(soundPhasesData));
  const overwriteMode = overwriteModeSelect.value;
  const targetSoundId = overwriteMode === 'conditional' ? targetSoundSelect.value : null;
  const disableOverwrite = disableOverwriteInput.checked;

  if (editingSoundId) {
    const target = sounds.find(s => s.id === editingSoundId);
    Object.assign(target, { name, color, imageDataUrl, volume, playbackType, isPartialLoop, trimStart, trimEnd, seamlessPhases, overwriteMode, targetSoundId, disableOverwrite });
    await dbPut('sounds', target);
  } else {
    if (!fileInput.files || fileInput.files.length === 0) { alert('音声または動画ファイルを選択してください！'); return; }
    const file = fileInput.files[0];
    let ab;
    try {
      ab = await file.arrayBuffer();
      ensureAudioContext();
      await audioCtx.decodeAudioData(ab.slice(0));
    } catch (e) {
      const vEl = document.createElement('video');
      vEl.src = URL.createObjectURL(file);
      await new Promise(r => vEl.onloadedmetadata = r);
      const res = await fetch(vEl.src);
      ab = await res.arrayBuffer();
      URL.revokeObjectURL(vEl.src);
    }
    const newSound = {
      id: 'snd_' + Date.now(), categoryId: currentCategoryId,
      order: sounds.filter(s => s.categoryId === currentCategoryId).length,
      name, color, imageDataUrl, volume, playbackType, isPartialLoop, trimStart, trimEnd,
      seamlessPhases, overwriteMode, targetSoundId, disableOverwrite, audioData: ab
    };
    await dbPut('sounds', newSound);
    sounds.push(newSound);
  }
  closeModal();
  renderSounds();
};

deleteBtn.onclick = async () => {
  if (!editingSoundId) return;
  if (confirm('このボタンを削除しますか？')) {
    await dbDelete('sounds', editingSoundId);
    decodedBufferCache.delete(editingSoundId);
    sounds = sounds.filter(s => s.id !== editingSoundId);
    const catSounds = sounds.filter(s => s.categoryId === currentCategoryId);
    for (let i = 0; i < catSounds.length; i++) { catSounds[i].order = i; await dbPut('sounds', catSounds[i]); }
    closeModal();
    renderSounds();
  }
};

(async function bootstrap() {
  await initDB();
  categories = await dbGetAll('categories');
  sounds = await dbGetAll('sounds');
  if (categories.length === 0) {
    const defaultCat = { id: 'cat_default', name: 'メイン', order: 0 };
    await dbPut('categories', defaultCat);
    categories.push(defaultCat);
  }
  categories.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  currentCategoryId = categories[0].id;
  renderCategories();
  renderSounds();
})();
