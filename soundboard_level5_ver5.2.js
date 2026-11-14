// Custom Soundboard - Level 5 ver5.2 (Mobile Touch Reorder, Viewport Fix & iOS Background Play)
const AudioCtx = window.AudioContext || window.webkitAudioContext;
let audioCtx = null;
let activeSources = []; 
const decodedBufferCache = new Map();

// === iOS Safari スリープ・バックグラウンド再生維持エンジン ===
let bgKeepAliveAudio = null;

function createSilentWavDataUrl() {
  // 1秒間の極小・無音モノラルWAV (8000Hz, 8bit PCM) を動的生成
  const sampleRate = 8000;
  const numSamples = sampleRate;
  const buffer = new ArrayBuffer(44 + numSamples);
  const view = new DataView(buffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + numSamples, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  writeStr(36, 'data');
  view.setUint32(40, numSamples, true);

  for (let i = 0; i < numSamples; i++) {
    view.setUint8(44 + i, 128); // 無音値
  }

  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return 'data:audio/wav;base64,' + btoa(binary);
}

function initBackgroundKeepAlive() {
  if (bgKeepAliveAudio) return;
  bgKeepAliveAudio = new Audio();
  bgKeepAliveAudio.src = createSilentWavDataUrl();
  bgKeepAliveAudio.loop = true;
  bgKeepAliveAudio.volume = 0.01;
  bgKeepAliveAudio.setAttribute('playsinline', '');
}

function syncBackgroundKeepAliveState(latestTitle = 'Soundboard LV.5') {
  const hasAnyPlaying = activeSources.length > 0 || smartSPMap.size > 0;
  if (hasAnyPlaying) {
    initBackgroundKeepAlive();
    if (bgKeepAliveAudio.paused) {
      bgKeepAliveAudio.play().catch(() => {});
    }
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: latestTitle,
          artist: 'Custom Soundboard LV.5',
          album: 'Background Playback'
        });
        navigator.mediaSession.playbackState = 'playing';
        navigator.mediaSession.setActionHandler('pause', () => stopAllSounds());
        navigator.mediaSession.setActionHandler('stop', () => stopAllSounds());
      } catch (e) {}
    }
  } else {
    if (bgKeepAliveAudio && !bgKeepAliveAudio.paused) {
      bgKeepAliveAudio.pause();
    }
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.playbackState = 'none';
      } catch (e) {}
    }
  }
}

document.addEventListener('visibilitychange', () => {
  if (audioCtx && audioCtx.state === 'suspended' && (activeSources.length > 0 || smartSPMap.size > 0)) {
    audioCtx.resume().catch(() => {});
  }
});

function ensureAudioContext() {
  if (!audioCtx) audioCtx = new AudioCtx();
  if (audioCtx.state === 'suspended') audioCtx.resume();
}

const DB_NAME = 'CustomSoundboardDB_Lv5_ver5_1'; // ver5.1と同一DB名を継承して既存データ・JSON互換性を完全維持
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

// === スマートSP変調エンジン ===
let smartSPMap = new Map();

const PHASE_COLORS = ['#00e676', '#ffeb3b', '#ff5252', '#40c4ff', '#ea80fc', '#ff9100'];

function getPhaseColor(index) {
  return PHASE_COLORS[index % PHASE_COLORS.length];
}

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
  if (isWaiting) {
    buttonEl.classList.add('sp-waiting');
  } else {
    buttonEl.classList.remove('sp-waiting');
  }

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
  const validSPs = (spList || [])
    .filter(sp => sp >= activeStart && sp <= activeEnd)
    .sort((a, b) => a - b);

  if (currPos >= prevPos) {
    for (const sp of validSPs) {
      if (prevPos < sp && sp <= currPos) return sp;
    }
    if (prevPos < activeEnd && activeEnd <= currPos) return activeEnd;
  } else {
    for (const sp of validSPs) {
      if (prevPos < sp && sp <= activeEnd) return sp;
    }
    return activeEnd;
  }
  return null;
}

async function handleSoundButtonPress(sound, buttonEl) {
  ensureAudioContext();
  // ユーザー操作の瞬間にバックグラウンド維持用無音オーディオをプライミング
  initBackgroundKeepAlive();
  if (bgKeepAliveAudio.paused) {
    bgKeepAliveAudio.play().catch(() => {});
  }

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
    if (existingEntry) {
      stopSoundEntry(existingEntry);
      return;
    }
  }

  applyOverwriteRules(sound);

  let audioBuffer = decodedBufferCache.get(sound.id);
  if (!audioBuffer) {
    const bufferCopy = sound.audioData.slice(0);
    audioBuffer = await audioCtx.decodeAudioData(bufferCopy);
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
  syncBackgroundKeepAliveState(sound.name);

  source.onended = () => {
    activeSources = activeSources.filter(item => item !== playEntry);
    const stillPlaying = activeSources.some(item => item.soundId === sound.id);
    if (!stillPlaying) {
      buttonEl.classList.remove('playing');
    }
    syncBackgroundKeepAliveState();
  };

  if (sound.playbackType === 'loop') {
    source.start(0, trimStart);
  } else {
    source.start(0, trimStart, trimEnd - trimStart);
  }
}

async function startSmartSPPlayback(sound, buttonEl) {
  applyOverwriteRules(sound);

  let audioBuffer = decodedBufferCache.get(sound.id);
  if (!audioBuffer) {
    const bufferCopy = sound.audioData.slice(0);
    audioBuffer = await audioCtx.decodeAudioData(bufferCopy);
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
    soundId: sound.id,
    soundName: sound.name,
    buttonEl,
    audioBuffer,
    phases,
    gainNode,
    currentPhase: 0,
    spActive: false,
    currentSource: null,
    segmentStartCtxTime: 0,
    segmentInitialOffset: 0,
    lastCheckedPos: 0,
    monitorInterval: null,
    isStopped: false
  };

  smartSPMap.set(sound.id, state);
  syncBackgroundKeepAliveState(sound.name);

  const p0Bounds = getNormalizedPhaseBounds(phases[0], duration);
  playSmartSPSegment(state, 0, p0Bounds.trimStart);
}

function getBufferPosAtTime(state, bounds, ctxTime) {
  const elapsed = ctxTime - state.segmentStartCtxTime;
  const loopLen = bounds.loopEnd - bounds.loopStart;
  let pos = state.segmentInitialOffset + elapsed;
  if (pos >= bounds.loopEnd && loopLen > 0) {
    pos = bounds.loopStart + ((pos - bounds.loopStart) % loopLen);
  }
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
    if (state.isStopped || !state.currentSource) {
      clearInterval(state.monitorInterval);
      return;
    }

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
        const nextPhase = state.phases[nextPhaseIndex];
        const nextBounds = getNormalizedPhaseBounds(nextPhase, state.audioBuffer.duration);

        state.spActive = false;
        updateButtonVisualState(state.buttonEl, nextPhaseIndex, state.phases.length, false);

        playSmartSPSegment(state, nextPhaseIndex, nextBounds.trimStart);
      }
    }
  }, 10);
}

function stopSmartSPEntry(state) {
  state.isStopped = true;
  if (state.monitorInterval) clearInterval(state.monitorInterval);
  if (state.currentSource) {
    try { state.currentSource.stop(); } catch (e) {}
  }
  smartSPMap.delete(state.soundId);
  clearButtonVisualState(state.buttonEl);
  syncBackgroundKeepAliveState();
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
  const stillPlaying = activeSources.some(item => item.soundId === entry.soundId);
  if (!stillPlaying) {
    entry.buttonEl.classList.remove('playing');
  }
  syncBackgroundKeepAliveState();
}

function stopAllSounds() {
  activeSources.forEach(entry => {
    try { entry.source.stop(); } catch (e) {}
    entry.buttonEl.classList.remove('playing');
  });
  activeSources = [];

  smartSPMap.forEach(state => {
    stopSmartSPEntry(state);
  });
  smartSPMap.clear();
  syncBackgroundKeepAliveState();
}

// === UI描画 ＆ PCドラッグ＆ドロップ + スマホ用ワンタップ順番変更 ===
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
      leftBtn.title = '左へ移動';
      leftBtn.onclick = (e) => {
        e.stopPropagation();
        moveCategoryOrder(idx, -1);
      };
      btn.appendChild(leftBtn);
    }

    const titleSpan = document.createElement('span');
    titleSpan.textContent = cat.name;
    btn.appendChild(titleSpan);

    if (isEditMode && idx < categories.length - 1) {
      const rightBtn = document.createElement('span');
      rightBtn.className = 'cat-move-btn';
      rightBtn.textContent = '▶';
      rightBtn.title = '右へ移動';
      rightBtn.onclick = (e) => {
        e.stopPropagation();
        moveCategoryOrder(idx, 1);
      };
      btn.appendChild(rightBtn);
    }

    if (isEditMode && categories.length > 1) {
      const delX = document.createElement('span');
      delX.className = 'cat-del-x';
      delX.textContent = '×';
      delX.title = 'カテゴリ削除';
      delX.onclick = (e) => {
        e.stopPropagation();
        if (confirm(`カテゴリ「${cat.name}」と中の音源を削除しますか？`)) {
          deleteCategory(cat.id);
        }
      };
      btn.appendChild(delX);
    }

    if (isEditMode) {
      btn.draggable = true;
      btn.ondragstart = (e) => {
        draggedCatId = cat.id;
        btn.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      };
      btn.ondragend = () => {
        draggedCatId = null;
        btn.classList.remove('dragging');
        document.querySelectorAll('.cat-tab').forEach(el => el.classList.remove('drag-over'));
      };
      btn.ondragover = (e) => {
        if (!draggedCatId || draggedCatId === cat.id) return;
        e.preventDefault();
        btn.classList.add('drag-over');
      };
      btn.ondragleave = () => {
        btn.classList.remove('drag-over');
      };
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

    btn.onclick = () => {
      currentCategoryId = cat.id;
      renderCategories();
      renderSounds();
    };
    container.appendChild(btn);
  });
}

function renderSounds() {
  const grid = document.getElementById('sound-grid');
  grid.innerHTML = '';

  const filtered = sounds
    .filter((s) => s.categoryId === currentCategoryId)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

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

    if (activeSources.some(item => item.soundId === sound.id)) {
      btn.classList.add('playing');
    }
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
      if (sound.playbackType === 'seamless') badge.textContent = `編集[SP×${(sound.seamlessPhases||[]).length}]`;
      else if (sound.playbackType === 'loop') badge.textContent = '編集[ループ]';
      else badge.textContent = '編集';
      btn.appendChild(badge);

      // スマホ・タブレットでもワンタップで順番を入れ替えられる矢印バー
      const reorderBar = document.createElement('div');
      reorderBar.className = 'mobile-reorder-bar';

      const prevBtn = document.createElement('button');
      prevBtn.type = 'button';
      prevBtn.className = 'btn-reorder-arrow';
      prevBtn.textContent = '◀';
      prevBtn.disabled = idx === 0;
      prevBtn.onclick = (e) => {
        e.stopPropagation();
        moveSoundOrder(filtered, idx, -1);
      };

      const nextBtn = document.createElement('button');
      nextBtn.type = 'button';
      nextBtn.className = 'btn-reorder-arrow';
      nextBtn.textContent = '▶';
      nextBtn.disabled = idx === filtered.length - 1;
      nextBtn.onclick = (e) => {
        e.stopPropagation();
        moveSoundOrder(filtered, idx, 1);
      };

      reorderBar.appendChild(prevBtn);
      reorderBar.appendChild(nextBtn);
      btn.appendChild(reorderBar);

      btn.ondragstart = (e) => {
        draggedSoundId = sound.id;
        btn.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      };
      btn.ondragend = () => {
        draggedSoundId = null;
        btn.classList.remove('dragging');
        document.querySelectorAll('.sound-btn').forEach(el => el.classList.remove('drag-over'));
      };
      btn.ondragover = (e) => {
        if (!draggedSoundId || draggedSoundId === sound.id) return;
        e.preventDefault();
        btn.classList.add('drag-over');
      };
      btn.ondragleave = () => {
        btn.classList.remove('drag-over');
      };
      btn.ondrop = async (e) => {
        e.preventDefault();
        btn.classList.remove('drag-over');
        if (!draggedSoundId || draggedSoundId === sound.id) return;

        const currentCatList = sounds
          .filter(s => s.categoryId === currentCategoryId)
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

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

    btn.onclick = () => {
      if (isEditMode) {
        openEditModal(sound);
      } else {
        handleSoundButtonPress(sound, btn);
      }
    };

    grid.appendChild(btn);
  });
}

async function deleteCategory(catId) {
  await dbDelete('categories', catId);
  const targetSounds = sounds.filter((s) => s.categoryId === catId);
  for (const s of targetSounds) {
    await dbDelete('sounds', s.id);
    decodedBufferCache.delete(s.id);
  }
  categories = categories.filter((c) => c.id !== catId);
  sounds = sounds.filter((s) => s.categoryId !== catId);
  currentCategoryId = categories[0].id;
  await saveCategoryOrders();
  renderCategories();
  renderSounds();
}

// === 波形エディタ＆プレビューエンジン ===
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
let soundPhasesData = [
  { trimStart: 0, trimEnd: 5, isPartialLoop: false, start: 0, end: 5, sps: [2.5] },
  { trimStart: 5, trimEnd: 10, isPartialLoop: false, start: 5, end: 10, sps: [7.5] },
  { trimStart: 10, trimEnd: 15, isPartialLoop: false, start: 10, end: 15, sps: [12.5] }
];

function updateLiveTimeDisplay(sec) {
  if (sec === null || sec === undefined || isNaN(sec)) {
    waveCurrentTimeEl.textContent = '0s';
  } else {
    waveCurrentTimeEl.textContent = `${Math.floor(sec)}s`;
  }
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
  const maxStart = Math.max(0, 1.0 - span);
  const start = Math.max(0, Math.min(waveViewStartRatio, maxStart));
  return { start, end: start + span, span, maxStart };
}

function secToCanvasX(sec, duration, width) {
  if (!duration || duration <= 0) return 0;
  const { start, span } = getViewportRange();
  const ratio = sec / duration;
  return ((ratio - start) / span) * width;
}

function canvasXToSec(clientX, duration) {
  const rect = waveCanvas.getBoundingClientRect();
  const localRatio = Math.max(0, Math.min((clientX - rect.left) / rect.width, 1));
  const { start, span } = getViewportRange();
  const globalRatio = Math.max(0, Math.min(start + localRatio * span, 1));
  return globalRatio * duration;
}

function setViewportStart(newStartRatio) {
  const span = 1.0 / waveZoomFactor;
  const maxStart = Math.max(0, 1.0 - span);
  waveViewStartRatio = Math.max(0, Math.min(newStartRatio, maxStart));
  wavePanSlider.max = maxStart.toFixed(4);
  wavePanSlider.value = waveViewStartRatio.toFixed(4);
  drawWaveformCanvas();
}

function centerViewportOnTime(targetSec) {
  if (!editorAudioBuffer) return;
  const dur = editorAudioBuffer.duration;
  const targetRatio = targetSec / dur;
  const span = 1.0 / waveZoomFactor;
  setViewportStart(targetRatio - span / 2);
}

function applyWaveformZoom(factor, focusSec = null) {
  const oldRange = getViewportRange();
  const centerRatio = (focusSec !== null && editorAudioBuffer && editorAudioBuffer.duration > 0)
    ? (focusSec / editorAudioBuffer.duration)
    : (oldRange.start + oldRange.span / 2);

  waveZoomFactor = factor;
  waveZoomLabel.textContent = `${factor.toFixed(1)}x`;
  waveZoomSlider.value = factor;

  const newSpan = 1.0 / waveZoomFactor;
  if (waveZoomFactor > 1.0) {
    wavePanBar.classList.remove('hidden');
  } else {
    wavePanBar.classList.add('hidden');
  }

  setViewportStart(centerRatio - newSpan / 2);
}

waveZoomSlider.oninput = () => {
  const focus = previewPlayheadTime ?? 0;
  applyWaveformZoom(parseFloat(waveZoomSlider.value), focus);
};

document.getElementById('wave-zoom-reset-btn').onclick = () => {
  applyWaveformZoom(1.0, 0);
};

wavePanSlider.oninput = () => {
  setViewportStart(parseFloat(wavePanSlider.value));
};

document.getElementById('wave-center-playhead-btn').onclick = () => {
  centerViewportOnTime(previewPlayheadTime ?? 0);
};

document.querySelectorAll('input[name="drag-target"]').forEach(radio => {
  radio.addEventListener('change', () => {
    waveCanvas.classList.toggle('pan-cursor', radio.value === 'pan');
  });
});

function getSelectedSeekOffset(trimStart, loopStart, loopEnd, selectedSP) {
  const mode = previewStartModeSelect.value;
  if (mode === 'trimStart') {
    return trimStart;
  }
  if (mode === 'beforeSP' && selectedSP !== null && selectedSP !== undefined) {
    return Math.max(trimStart, selectedSP - 3.0);
  }
  if (mode === 'beforeLoopEnd') {
    return Math.max(loopStart, loopEnd - 3.0);
  }
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
  if (!phase.sps || phase.sps.length === 0) {
    const tS = phase.trimStart ?? phase.start ?? 0;
    const tE = phase.trimEnd ?? phase.end ?? 5;
    phase.sps = [Number(((tS + tE) / 2).toFixed(2))];
  }
  if (selectedSPIndex >= phase.sps.length) {
    selectedSPIndex = phase.sps.length - 1;
  }

  phase.sps.forEach((spVal, idx) => {
    const row = document.createElement('div');
    row.className = `sp-item-row ${idx === selectedSPIndex ? 'selected' : ''}`;

    row.addEventListener('click', (e) => {
      if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;
      selectedSPIndex = idx;
      document.querySelectorAll('.sp-item-row').forEach((r, i) => r.classList.toggle('selected', i === idx));
      drawWaveformCanvas();
    });

    const label = document.createElement('span');
    label.className = 'sp-item-label';
    label.textContent = `SP ${idx + 1}:`;

    const input = document.createElement('input');
    input.type = 'number';
    input.step = '0.01';
    input.min = '0';
    input.className = 'sp-item-input';
    input.value = Number(spVal).toFixed(2);

    input.addEventListener('focus', () => {
      selectedSPIndex = idx;
      document.querySelectorAll('.sp-item-row').forEach((r, i) => r.classList.toggle('selected', i === idx));
      drawWaveformCanvas();
    });

    input.addEventListener('input', () => {
      const val = parseFloat(input.value);
      if (!isNaN(val)) {
        phase.sps[idx] = val;
        drawWaveformCanvas();
      }
    });

    input.addEventListener('blur', () => {
      const val = parseFloat(input.value);
      if (!isNaN(val)) {
        const dur = editorAudioBuffer ? editorAudioBuffer.duration : 9999;
        const clamped = Math.max(0, Math.min(val, dur));
        phase.sps[idx] = Number(clamped.toFixed(2));
        input.value = phase.sps[idx].toFixed(2);
        drawWaveformCanvas();
      } else {
        input.value = Number(phase.sps[idx]).toFixed(2);
      }
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        input.blur();
      }
    });

    const unit = document.createElement('span');
    unit.style.fontSize = '0.75rem';
    unit.style.color = '#aaa';
    unit.textContent = '秒';

    row.appendChild(label);
    row.appendChild(input);
    row.appendChild(unit);

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

  if (!p.isPartialLoop) {
    p.start = tStart;
    p.end = tEnd;
  }
  phaseStartInput.value = Number(p.start).toFixed(2);
  phaseEndInput.value = Number(p.end).toFixed(2);

  renderSPList();
}

document.getElementById('add-phase-btn').onclick = () => {
  const dur = editorAudioBuffer ? editorAudioBuffer.duration : 15;
  const lastPhase = soundPhasesData[soundPhasesData.length - 1];
  const newStart = lastPhase ? (lastPhase.trimEnd ?? lastPhase.end) : 0;
  const newEnd = Math.max(newStart + 1.0, dur);
  const newSP = Number(((newStart + newEnd) / 2).toFixed(2));
  soundPhasesData.push({
    trimStart: Number(newStart.toFixed(2)),
    trimEnd: Number(newEnd.toFixed(2)),
    isPartialLoop: false,
    start: Number(newStart.toFixed(2)),
    end: Number(newEnd.toFixed(2)),
    sps: [newSP]
  });
  currentEditingPhase = soundPhasesData.length - 1;
  selectedSPIndex = 0;
  renderPhaseTabs();
  updatePhaseInputsUI();
  drawWaveformCanvas();
};

document.getElementById('remove-phase-btn').onclick = () => {
  if (soundPhasesData.length <= 1) return;
  soundPhasesData.splice(currentEditingPhase, 1);
  if (currentEditingPhase >= soundPhasesData.length) {
    currentEditingPhase = soundPhasesData.length - 1;
  }
  selectedSPIndex = 0;
  renderPhaseTabs();
  updatePhaseInputsUI();
  drawWaveformCanvas();
};

document.getElementById('add-sp-btn').onclick = () => {
  const phase = soundPhasesData[currentEditingPhase];
  const baseS = phase.isPartialLoop ? phase.start : phase.trimStart;
  const baseE = phase.isPartialLoop ? phase.end : phase.trimEnd;
  const mid = Number(((baseS + baseE) / 2).toFixed(2));
  phase.sps.push(mid);
  selectedSPIndex = phase.sps.length - 1;
  renderSPList();
  drawWaveformCanvas();
};

function computeWaveformPeaks(audioBuffer, numBins = HIGH_RES_BINS) {
  const channelData = audioBuffer.getChannelData(0);
  const blockSize = Math.floor(channelData.length / numBins) || 1;
  const peaks = [];
  for (let i = 0; i < numBins; i++) {
    let start = i * blockSize;
    let max = 0;
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
    const activeP = soundPhasesData[currentEditingPhase];
    const bounds = getNormalizedPhaseBounds(activeP, duration);
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

  if (pType === 'seamless') {
    const activeP = soundPhasesData[currentEditingPhase];
    const bounds = getNormalizedPhaseBounds(activeP, duration);
    const pStartX = secToCanvasX(bounds.loopStart, duration, width);
    const pEndX = secToCanvasX(bounds.loopEnd, duration, width);
    waveCtx.fillStyle = 'rgba(0, 230, 118, 0.16)';
    waveCtx.fillRect(pStartX, 0, Math.max(2, pEndX - pStartX), height);
  } else if (pType === 'loop') {
    const lStart = partialLoopInput.checked ? (parseFloat(singleLoopStartInput.value) || activeTrimStart) : activeTrimStart;
    const lEnd = partialLoopInput.checked ? (parseFloat(singleLoopEndInput.value) || activeTrimEnd) : activeTrimEnd;
    const lStartX = secToCanvasX(lStart, duration, width);
    const lEndX = secToCanvasX(lEnd, duration, width);
    waveCtx.fillStyle = 'rgba(0, 230, 118, 0.18)';
    waveCtx.fillRect(lStartX, 0, Math.max(2, lEndX - lStartX), height);
  }

  waveCtx.fillStyle = 'rgba(255, 255, 255, 0.35)';
  waveCtx.font = '10px sans-serif';
  const visibleDuration = duration * viewSpan;
  const stepSec = visibleDuration <= 10 ? 0.5 : (visibleDuration <= 25 ? 1 : (visibleDuration <= 60 ? 2 : 5));
  const firstTick = Math.ceil((viewStart * duration) / stepSec) * stepSec;
  const lastTick = viewEnd * duration;
  for (let s = firstTick; s <= lastTick; s += stepSec) {
    if (s <= 0) continue;
    const sx = secToCanvasX(s, duration, width);
    waveCtx.fillRect(sx, 0, 1, 6);
    const labelStr = Number.isInteger(s) ? `${s}s` : `${s.toFixed(1)}s`;
    waveCtx.fillText(labelStr, sx + 2, 11);
  }

  const totalBins = editorPeaks.length;
  const startBin = Math.floor(viewStart * totalBins);
  const endBin = Math.min(totalBins, Math.ceil(viewEnd * totalBins));
  const visibleBinsCount = Math.max(1, endBin - startBin);
  const barWidth = width / visibleBinsCount;
  const midY = height / 2;

  for (let idx = startBin; idx < endBin; idx++) {
    const localIdx = idx - startBin;
    const x = localIdx * barWidth;
    const barHeight = Math.max(2, editorPeaks[idx] * (height * 0.76));
    const binSec = (idx / totalBins) * duration;
    const isInsideTrim = binSec >= activeTrimStart && binSec <= activeTrimEnd;

    waveCtx.fillStyle = !isInsideTrim ? '#333333' : '#4fc3f7';
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
      const pStartX = secToCanvasX(bounds.loopStart, duration, width);
      const pEndX = secToCanvasX(bounds.loopEnd, duration, width);

      waveCtx.strokeStyle = '#00e676';
      waveCtx.lineWidth = 2;
      waveCtx.beginPath(); waveCtx.moveTo(pStartX, 0); waveCtx.lineTo(pStartX, height); waveCtx.stroke();

      waveCtx.strokeStyle = '#ff5252';
      waveCtx.lineWidth = 2;
      waveCtx.beginPath(); waveCtx.moveTo(pEndX, 0); waveCtx.lineTo(pEndX, height); waveCtx.stroke();
    }

    (p.sps || []).forEach((spVal, idx) => {
      const spX = secToCanvasX(spVal, duration, width);
      waveCtx.strokeStyle = idx === selectedSPIndex ? '#ffeb3b' : 'rgba(255, 235, 59, 0.55)';
      waveCtx.lineWidth = idx === selectedSPIndex ? 2.8 : 1.5;
      waveCtx.beginPath(); waveCtx.moveTo(spX, 0); waveCtx.lineTo(spX, height); waveCtx.stroke();
    });
  } else if (pType === 'loop' && partialLoopInput.checked) {
    const lStartX = secToCanvasX(parseFloat(singleLoopStartInput.value) || 0, duration, width);
    const lEndX = secToCanvasX(parseFloat(singleLoopEndInput.value) || duration, duration, width);

    waveCtx.strokeStyle = '#00e676';
    waveCtx.beginPath(); waveCtx.moveTo(lStartX, 0); waveCtx.lineTo(lStartX, height); waveCtx.stroke();

    waveCtx.strokeStyle = '#ff5252';
    waveCtx.beginPath(); waveCtx.moveTo(lEndX, 0); waveCtx.lineTo(lEndX, height); waveCtx.stroke();
  }

  if (duration > 0 && previewPlayheadTime !== null) {
    const playX = secToCanvasX(previewPlayheadTime, duration, width);
    if (playX >= -10 && playX <= width + 10) {
      waveCtx.strokeStyle = '#ffffff';
      waveCtx.lineWidth = 2;
      waveCtx.beginPath();
      waveCtx.moveTo(playX, 0); waveCtx.lineTo(playX, height);
      waveCtx.stroke();

      waveCtx.fillStyle = '#ffffff';
      waveCtx.beginPath();
      waveCtx.moveTo(playX - 6, 0);
      waveCtx.lineTo(playX + 6, 0);
      waveCtx.lineTo(playX, 8);
      waveCtx.closePath();
      waveCtx.fill();
    }
  }

  if (waveZoomFactor > 1.0) {
    const mapW = 76;
    const mapH = 10;
    const mapX = width - mapW - 6;
    const mapY = height - mapH - 5;

    waveCtx.fillStyle = 'rgba(0, 0, 0, 0.72)';
    waveCtx.fillRect(mapX, mapY, mapW, mapH);
    waveCtx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    waveCtx.lineWidth = 1;
    waveCtx.strokeRect(mapX, mapY, mapW, mapH);

    waveCtx.fillStyle = 'rgba(79, 195, 247, 0.65)';
    waveCtx.fillRect(mapX + viewStart * mapW, mapY + 1, Math.max(3, viewSpan * mapW), mapH - 2);

    if (duration > 0 && previewPlayheadTime !== null) {
      const miniPlayX = mapX + (previewPlayheadTime / duration) * mapW;
      waveCtx.fillStyle = '#ffffff';
      waveCtx.fillRect(miniPlayX, mapY, 1.5, mapH);
    }
  }
}

async function loadBufferIntoEditor(arrayBuffer, tStart = null, tEnd = null, phases = null, lStart = null, lEnd = null) {
  ensureAudioContext();
  const copy = arrayBuffer.slice(0);
  editorAudioBuffer = await audioCtx.decodeAudioData(copy);
  editorPeaks = computeWaveformPeaks(editorAudioBuffer, HIGH_RES_BINS);
  
  const dur = editorAudioBuffer.duration;
  waveTotalDurationEl.textContent = dur.toFixed(2);
  previewPlayheadTime = tStart !== null ? Number(tStart) : 0;
  updateLiveTimeDisplay(previewPlayheadTime);

  trimStartInput.max = dur.toFixed(2);
  trimEndInput.max = dur.toFixed(2);
  phaseTrimStartInput.max = dur.toFixed(2);
  phaseTrimEndInput.max = dur.toFixed(2);
  phaseStartInput.max = dur.toFixed(2);
  phaseEndInput.max = dur.toFixed(2);
  singleLoopStartInput.max = dur.toFixed(2);
  singleLoopEndInput.max = dur.toFixed(2);

  trimStartInput.value = tStart !== null ? Number(tStart).toFixed(2) : '0.00';
  trimEndInput.value = (tEnd !== null && tEnd !== '') ? Number(tEnd).toFixed(2) : dur.toFixed(2);

  singleLoopStartInput.value = lStart !== null ? Number(lStart).toFixed(2) : trimStartInput.value;
  singleLoopEndInput.value = lEnd !== null ? Number(lEnd).toFixed(2) : trimEndInput.value;

  if (phases && phases.length > 0) {
    soundPhasesData = JSON.parse(JSON.stringify(phases)).map(p => {
      const tS = p.trimStart ?? p.start ?? 0;
      const tE = p.trimEnd ?? p.end ?? dur;
      const isPart = p.isPartialLoop !== undefined ? Boolean(p.isPartialLoop) : (p.start !== undefined && (p.start !== tS || p.end !== tE));
      return {
        trimStart: tS,
        trimEnd: tE,
        isPartialLoop: isPart,
        start: p.start ?? tS,
        end: p.end ?? tE,
        sps: Array.isArray(p.sps) && p.sps.length > 0 ? p.sps : [p.sp ?? Number(((tS + tE) / 2).toFixed(2))]
      };
    });
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
  if (previewSource) {
    try { previewSource.stop(); } catch (e) {}
    previewSource = null;
  }
  if (previewSmartState) {
    previewSmartState.isStopped = true;
    if (previewSmartState.monitorInterval) clearInterval(previewSmartState.monitorInterval);
    if (previewSmartState.currentSource) {
      try { previewSmartState.currentSource.stop(); } catch (e) {}
    }
    previewSmartState = null;
  }
  if (previewAnimFrame) {
    cancelAnimationFrame(previewAnimFrame);
    previewAnimFrame = null;
  }
}

function stopEditorPreview() {
  clearRunningAudioNodesOnly();
  isPreviewPaused = false;
  const pType = playbackTypeSelect.value;
  let resetPos = parseFloat(trimStartInput.value) || 0;
  if (pType === 'seamless' && editorAudioBuffer) {
    const bounds = getNormalizedPhaseBounds(soundPhasesData[currentEditingPhase], editorAudioBuffer.duration);
    resetPos = bounds.trimStart;
  }
  previewPlayheadTime = resetPos;
  updateLiveTimeDisplay(resetPos);
  resetSPTestButtonUI();
  updatePauseButtonUI();
  drawWaveformCanvas();
}

function togglePauseEditorPreview() {
  if (!editorAudioBuffer) return;

  if (!isPreviewPaused && (previewSource || previewSmartState)) {
    const wasSP = Boolean(previewSmartState);
    const savedSPActive = previewSmartState ? previewSmartState.spActive : false;
    clearRunningAudioNodesOnly();
    isPreviewPaused = true;
    if (wasSP) {
      lastPreviewMode = 'sp';
      previewSmartState = { isPausedPlaceholder: true, spActive: savedSPActive };
    }
    updatePauseButtonUI();
    drawWaveformCanvas();
  } else if (isPreviewPaused) {
    isPreviewPaused = false;
    const resumePos = previewPlayheadTime ?? (parseFloat(trimStartInput.value) || 0);
    if (lastPreviewMode === 'sp') {
      const savedSPActive = previewSmartState ? previewSmartState.spActive : false;
      previewSmartState = null;
      startEditorSPPreviewAtOffset(resumePos, savedSPActive);
    } else {
      startEditorPreviewAtOffset(resumePos, lastPreviewMode === 'seek');
    }
  }
}

function startEditorPreview(useSeekMode = false) {
  if (!editorAudioBuffer) {
    alert('先に音声ファイルを読み込んでください');
    return;
  }
  clearRunningAudioNodesOnly();
  isPreviewPaused = false;
  lastPreviewMode = useSeekMode ? 'seek' : 'normal';
  resetSPTestButtonUI();

  const duration = editorAudioBuffer.duration;
  const pType = playbackTypeSelect.value;

  let tStart = Math.max(0, Math.min(parseFloat(trimStartInput.value) || 0, duration));
  let tEnd = Math.max(tStart + 0.05, Math.min(parseFloat(trimEndInput.value) || duration, duration));
  let lStart = tStart;
  let lEnd = tEnd;
  let selectedSP = null;

  if (pType === 'seamless') {
    const p = soundPhasesData[currentEditingPhase];
    const bounds = getNormalizedPhaseBounds(p, duration);
    tStart = bounds.trimStart;
    tEnd = bounds.trimEnd;
    lStart = bounds.loopStart;
    lEnd = bounds.loopEnd;
    selectedSP = (p.sps && p.sps[selectedSPIndex] !== undefined) ? p.sps[selectedSPIndex] : null;
  } else if (pType === 'loop') {
    if (partialLoopInput.checked) {
      lStart = Math.max(tStart, Math.min(parseFloat(singleLoopStartInput.value) || tStart, tEnd));
      lEnd = Math.max(lStart + 0.05, Math.min(parseFloat(singleLoopEndInput.value) || tEnd, tEnd));
    }
  }

  const offset = useSeekMode ? getSelectedSeekOffset(tStart, lStart, lEnd, selectedSP) : tStart;
  startEditorPreviewAtOffset(offset, useSeekMode);
}

function startEditorPreviewAtOffset(customOffset, isLoopModeContext = false) {
  ensureAudioContext();
  clearRunningAudioNodesOnly();
  isPreviewPaused = false;

  const duration = editorAudioBuffer.duration;
  const pType = playbackTypeSelect.value;

  let tStart = Math.max(0, Math.min(parseFloat(trimStartInput.value) || 0, duration));
  let tEnd = Math.max(tStart + 0.05, Math.min(parseFloat(trimEndInput.value) || duration, duration));
  let lStart = tStart;
  let lEnd = tEnd;
  let isLoop = false;

  if (pType === 'seamless') {
    const p = soundPhasesData[currentEditingPhase];
    const bounds = getNormalizedPhaseBounds(p, duration);
    tStart = bounds.trimStart;
    tEnd = bounds.trimEnd;
    lStart = bounds.loopStart;
    lEnd = bounds.loopEnd;
    isLoop = true;
  } else if (pType === 'loop') {
    isLoop = true;
    if (partialLoopInput.checked) {
      lStart = Math.max(tStart, Math.min(parseFloat(singleLoopStartInput.value) || tStart, tEnd));
      lEnd = Math.max(lStart + 0.05, Math.min(parseFloat(singleLoopEndInput.value) || tEnd, tEnd));
    }
  }

  const safeOffset = Math.max(0, Math.min(customOffset, duration - 0.02));

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
  if (isLoop) {
    previewSource.start(startCtxTime, safeOffset);
  } else {
    const playDur = Math.max(0.05, tEnd - safeOffset);
    previewSource.start(startCtxTime, safeOffset, playDur);
  }

  updatePauseButtonUI();

  function updatePlayhead() {
    if (!previewSource) return;
    const elapsed = audioCtx.currentTime - startCtxTime;
    let currentPos = safeOffset + elapsed;

    if (isLoop && currentPos >= lEnd) {
      const loopLen = lEnd - lStart;
      if (loopLen > 0) {
        currentPos = lStart + ((currentPos - lStart) % loopLen);
      }
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

  if (!editorAudioBuffer) {
    alert('先に音声ファイルを読み込んでください');
    return;
  }

  const p0 = soundPhasesData[currentEditingPhase];
  const bounds = getNormalizedPhaseBounds(p0, editorAudioBuffer.duration);
  const selSP = (p0.sps && p0.sps[selectedSPIndex] !== undefined) ? p0.sps[selectedSPIndex] : null;
  const initialStart = getSelectedSeekOffset(bounds.trimStart, bounds.loopStart, bounds.loopEnd, selSP);

  startEditorSPPreviewAtOffset(initialStart, false);
}

function startEditorSPPreviewAtOffset(customOffset, initialSPActive = false) {
  ensureAudioContext();
  clearRunningAudioNodesOnly();
  isPreviewPaused = false;
  lastPreviewMode = 'sp';

  const phases = soundPhasesData;
  const gainNode = audioCtx.createGain();
  gainNode.gain.value = (Number(document.getElementById('btn-volume-input').value) || 100) / 100;
  gainNode.connect(audioCtx.destination);

  const state = {
    audioBuffer: editorAudioBuffer,
    phases,
    gainNode,
    currentPhase: currentEditingPhase,
    spActive: initialSPActive,
    currentSource: null,
    segmentStartCtxTime: 0,
    segmentInitialOffset: 0,
    lastCheckedPos: 0,
    monitorInterval: null,
    isStopped: false
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
    if (state.isStopped || !state.currentSource) {
      clearInterval(state.monitorInterval);
      return;
    }

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
        if (nextPhaseIndex >= state.phases.length) {
          stopEditorPreview();
          return;
        }

        const nextPhase = state.phases[nextPhaseIndex];
        const nextBounds = getNormalizedPhaseBounds(nextPhase, state.audioBuffer.duration);
        currentEditingPhase = nextPhaseIndex;
        renderPhaseTabs();
        updatePhaseInputsUI();

        state.spActive = false;
        updateSPTestButtonUI(false);

        playEditorSPSegment(state, nextPhaseIndex, nextBounds.trimStart);
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
    if (previewSmartState && !previewSmartState.isPausedPlaceholder) {
      spBtn.textContent = '⚡ SP試聴 [OFF 🔴]';
      spBtn.style.background = '#ffeb3b';
      spBtn.style.color = '#000';
    } else {
      spBtn.textContent = '⚡ SP試聴 [OFF]';
      spBtn.style.background = '#f57f17';
      spBtn.style.color = '#000';
    }
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
    const deltaPx = clientX - panDragStartX;
    const { span } = getViewportRange();
    const deltaRatio = (deltaPx / rect.width) * span;
    setViewportStart(panInitialViewStart - deltaRatio);
    return;
  }

  const clickedSec = canvasXToSec(clientX, dur);
  const pType = playbackTypeSelect.value;

  if (targetMode === 'playhead') {
    previewPlayheadTime = clickedSec;
    updateLiveTimeDisplay(clickedSec);
    drawWaveformCanvas();

    if (isDragEnd && !isPreviewPaused) {
      if (previewSmartState && !previewSmartState.isPausedPlaceholder) {
        const keepSP = previewSmartState.spActive;
        startEditorSPPreviewAtOffset(clickedSec, keepSP);
      } else if (previewSource) {
        startEditorPreviewAtOffset(clickedSec, lastPreviewMode === 'seek');
      }
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
      const currentTrimEnd = parseFloat(trimEndInput.value) || dur;
      trimStartInput.value = Math.max(0, Math.min(clickedSec, currentTrimEnd - 0.05)).toFixed(2);
    }
  } else if (targetMode === 'trimEnd') {
    if (pType === 'seamless') {
      const p = soundPhasesData[currentEditingPhase];
      p.trimEnd = Number(Math.min(dur, Math.max(clickedSec, (p.trimStart ?? 0) + 0.05)).toFixed(2));
      if (!p.isPartialLoop) p.end = p.trimEnd;
      updatePhaseInputsUI();
    } else {
      const currentTrimStart = parseFloat(trimStartInput.value) || 0;
      trimEndInput.value = Math.min(dur, Math.max(clickedSec, currentTrimStart + 0.05)).toFixed(2);
    }
  } else if (targetMode === 'loopStart') {
    if (pType === 'seamless') {
      const p = soundPhasesData[currentEditingPhase];
      if (!p.isPartialLoop) {
        p.isPartialLoop = true;
        phasePartialLoopInput.checked = true;
      }
      p.start = Number(Math.max(p.trimStart, Math.min(clickedSec, p.end - 0.05)).toFixed(2));
      updatePhaseInputsUI();
    } else if (pType === 'loop') {
      const curEnd = parseFloat(singleLoopEndInput.value) || dur;
      singleLoopStartInput.value = Math.max(0, Math.min(clickedSec, curEnd - 0.05)).toFixed(2);
    }
  } else if (targetMode === 'loopEnd') {
    if (pType === 'seamless') {
      const p = soundPhasesData[currentEditingPhase];
      if (!p.isPartialLoop) {
        p.isPartialLoop = true;
        phasePartialLoopInput.checked = true;
      }
      p.end = Number(Math.min(p.trimEnd, Math.max(clickedSec, p.start + 0.05)).toFixed(2));
      updatePhaseInputsUI();
    } else if (pType === 'loop') {
      const curStart = parseFloat(singleLoopStartInput.value) || 0;
      singleLoopEndInput.value = Math.min(dur, Math.max(clickedSec, curStart + 0.05)).toFixed(2);
    }
  } else if (targetMode === 'selectedSP') {
    if (pType === 'seamless') {
      const p = soundPhasesData[currentEditingPhase];
      const bounds = getNormalizedPhaseBounds(p, dur);
      const clamped = Math.max(bounds.trimStart, Math.min(clickedSec, bounds.loopEnd));
      p.sps[selectedSPIndex] = Number(clamped.toFixed(2));
      renderSPList();
    }
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
waveCanvas.addEventListener('pointermove', (e) => {
  if (isDraggingWave) updateMarkerFromPointer(e.clientX, false);
});
waveCanvas.addEventListener('pointerup', (e) => {
  if (isDraggingWave) {
    isDraggingWave = false;
    waveCanvas.releasePointerCapture(e.pointerId);
    updateMarkerFromPointer(e.clientX, true);
  }
});

waveCanvas.addEventListener('wheel', (e) => {
  if (!editorAudioBuffer || waveZoomFactor <= 1.0) return;
  const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : (e.shiftKey ? e.deltaY : 0);
  if (delta !== 0) {
    e.preventDefault();
    const { span } = getViewportRange();
    setViewportStart(waveViewStartRatio + (delta * 0.001) * span);
  }
}, { passive: false });

document.querySelectorAll('.btn-nudge').forEach(btn => {
  btn.onclick = () => {
    if (!editorAudioBuffer) return;
    const target = btn.dataset.target;
    const delta = parseFloat(btn.dataset.delta);
    const dur = editorAudioBuffer.duration;

    if (target === 'phaseTrimStart') {
      const p = soundPhasesData[currentEditingPhase];
      p.trimStart = Number(Math.max(0, Math.min((p.trimStart ?? 0) + delta, (p.trimEnd ?? dur) - 0.01)).toFixed(2));
      if (!p.isPartialLoop) p.start = p.trimStart;
      updatePhaseInputsUI();
    } else if (target === 'phaseTrimEnd') {
      const p = soundPhasesData[currentEditingPhase];
      p.trimEnd = Number(Math.max((p.trimStart ?? 0) + 0.01, Math.min((p.trimEnd ?? dur) + delta, dur)).toFixed(2));
      if (!p.isPartialLoop) p.end = p.trimEnd;
      updatePhaseInputsUI();
    } else if (target === 'phaseStart') {
      const p = soundPhasesData[currentEditingPhase];
      p.start = Number(Math.max(p.trimStart ?? 0, Math.min(p.start + delta, p.end - 0.01)).toFixed(2));
      updatePhaseInputsUI();
    } else if (target === 'phaseEnd') {
      const p = soundPhasesData[currentEditingPhase];
      p.end = Number(Math.max(p.start + 0.01, Math.min(p.end + delta, p.trimEnd ?? dur)).toFixed(2));
      updatePhaseInputsUI();
    } else if (target === 'selectedSP') {
      const p = soundPhasesData[currentEditingPhase];
      const bounds = getNormalizedPhaseBounds(p, dur);
      const curSP = p.sps[selectedSPIndex] ?? bounds.trimStart;
      p.sps[selectedSPIndex] = Number(Math.max(bounds.trimStart, Math.min(curSP + delta, bounds.loopEnd)).toFixed(2));
      renderSPList();
    } else if (target === 'singleStart') {
      const cur = parseFloat(singleLoopStartInput.value) || 0;
      const maxEnd = (parseFloat(singleLoopEndInput.value) || dur) - 0.01;
      singleLoopStartInput.value = Math.max(0, Math.min(cur + delta, maxEnd)).toFixed(2);
    } else if (target === 'singleEnd') {
      const cur = parseFloat(singleLoopEndInput.value) || dur;
      const minStart = (parseFloat(singleLoopStartInput.value) || 0) + 0.01;
      singleLoopEndInput.value = Math.min(minStart, Math.min(cur + delta, dur)).toFixed(2);
    }

    if (previewSource || previewSmartState) stopEditorPreview();
    drawWaveformCanvas();
  };
});

document.getElementById('preview-play-btn').onclick = () => startEditorPreview(false);
document.getElementById('preview-loop-btn').onclick = () => startEditorPreview(true);
document.getElementById('preview-sp-btn').onclick = startEditorSPPreview;
previewPauseBtn.onclick = togglePauseEditorPreview;
document.getElementById('preview-stop-btn').onclick = stopEditorPreview;

// === モーダルUI制御 ===
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
    reader.onload = (e) => {
      setModalImagePreview(e.target.result);
    };
    reader.readAsDataURL(imageInput.files[0]);
  }
};

clearImageBtn.onclick = () => {
  setModalImagePreview(null);
};

playbackTypeSelect.onchange = () => {
  const val = playbackTypeSelect.value;
  const spRadioLabel = document.getElementById('drag-sp-label');
  const loopStartLabel = document.getElementById('drag-loop-start-label');
  const loopEndLabel = document.getElementById('drag-loop-end-label');
  const spPreviewBtn = document.getElementById('preview-sp-btn');
  const loopPreviewBtn = document.getElementById('preview-loop-btn');
  const seekBox = document.getElementById('preview-seek-box');

  if (val === 'loop') {
    singleLoopBox.classList.remove('hidden');
    seamlessPhasesBox.classList.add('hidden');
    globalTrimBox.classList.remove('hidden');
    singleLoopInputs.classList.toggle('hidden', !partialLoopInput.checked);
    loopStartLabel.classList.remove('hidden');
    loopEndLabel.classList.remove('hidden');
    spRadioLabel.classList.add('hidden');
    spPreviewBtn.classList.add('hidden');
    loopPreviewBtn.classList.remove('hidden');
    seekBox.classList.remove('hidden');
  } else if (val === 'seamless') {
    singleLoopBox.classList.add('hidden');
    seamlessPhasesBox.classList.remove('hidden');
    globalTrimBox.classList.add('hidden');
    loopStartLabel.classList.remove('hidden');
    loopEndLabel.classList.remove('hidden');
    spRadioLabel.classList.remove('hidden');
    spPreviewBtn.classList.remove('hidden');
    loopPreviewBtn.classList.remove('hidden');
    seekBox.classList.remove('hidden');
    renderPhaseTabs();
    updatePhaseInputsUI();
  } else {
    singleLoopBox.classList.add('hidden');
    seamlessPhasesBox.classList.add('hidden');
    globalTrimBox.classList.remove('hidden');
    loopStartLabel.classList.add('hidden');
    loopEndLabel.classList.add('hidden');
    spRadioLabel.classList.add('hidden');
    spPreviewBtn.classList.add('hidden');
    loopPreviewBtn.classList.add('hidden');
    seekBox.classList.add('hidden');
    const checkedRadio = document.querySelector('input[name="drag-target"]:checked');
    if (checkedRadio && ['loopStart', 'loopEnd', 'selectedSP'].includes(checkedRadio.value)) {
      document.querySelector('input[name="drag-target"][value="playhead"]').checked = true;
    }
  }
  drawWaveformCanvas();
};

partialLoopInput.onchange = () => {
  singleLoopInputs.classList.toggle('hidden', !partialLoopInput.checked);
  drawWaveformCanvas();
};

phaseTrimStartInput.oninput = () => {
  const p = soundPhasesData[currentEditingPhase];
  const val = parseFloat(phaseTrimStartInput.value);
  if (!isNaN(val)) {
    p.trimStart = val;
    if (!p.isPartialLoop) {
      p.start = val;
      phaseStartInput.value = val.toFixed(2);
    }
    drawWaveformCanvas();
  }
};

phaseTrimEndInput.oninput = () => {
  const p = soundPhasesData[currentEditingPhase];
  const val = parseFloat(phaseTrimEndInput.value);
  if (!isNaN(val)) {
    p.trimEnd = val;
    if (!p.isPartialLoop) {
      p.end = val;
      phaseEndInput.value = val.toFixed(2);
    }
    drawWaveformCanvas();
  }
};

phasePartialLoopInput.onchange = () => {
  const p = soundPhasesData[currentEditingPhase];
  p.isPartialLoop = phasePartialLoopInput.checked;
  phaseLoopInputsRow.classList.toggle('hidden', !p.isPartialLoop);
  if (!p.isPartialLoop) {
    p.start = p.trimStart;
    p.end = p.trimEnd;
    phaseStartInput.value = Number(p.start).toFixed(2);
    phaseEndInput.value = Number(p.end).toFixed(2);
  }
  drawWaveformCanvas();
};

phaseStartInput.oninput = () => {
  const val = parseFloat(phaseStartInput.value);
  if (!isNaN(val)) {
    soundPhasesData[currentEditingPhase].start = val;
    drawWaveformCanvas();
  }
};
phaseEndInput.oninput = () => {
  const val = parseFloat(phaseEndInput.value);
  if (!isNaN(val)) {
    soundPhasesData[currentEditingPhase].end = val;
    drawWaveformCanvas();
  }
};

singleLoopStartInput.oninput = drawWaveformCanvas;
singleLoopEndInput.oninput = drawWaveformCanvas;
trimStartInput.oninput = drawWaveformCanvas;
trimEndInput.oninput = drawWaveformCanvas;

const overwriteModeSelect = document.getElementById('btn-overwrite-mode');
const targetSoundGroup = document.getElementById('target-sound-group');
const targetSoundSelect = document.getElementById('btn-target-sound');
const disableOverwriteInput = document.getElementById('btn-disable-overwrite');

overwriteModeSelect.onchange = () => {
  if (overwriteModeSelect.value === 'conditional') {
    targetSoundGroup.classList.remove('hidden');
    updateTargetSoundDropdown();
  } else {
    targetSoundGroup.classList.add('hidden');
  }
};

function updateTargetSoundDropdown(excludeId = null) {
  targetSoundSelect.innerHTML = '';
  sounds.forEach(s => {
    if (s.id !== excludeId) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      targetSoundSelect.appendChild(opt);
    }
  });
}

function closeModal() {
  stopEditorPreview();
  modal.classList.add('hidden');
}

function openAddModal() {
  editingSoundId = null;
  editorAudioBuffer = null;
  editorPeaks = [];
  waveTotalDurationEl.textContent = '0.00';
  previewPlayheadTime = 0;
  updateLiveTimeDisplay(0);
  applyWaveformZoom(1.0, 0);

  document.getElementById('modal-title').innerHTML = '新規音源を追加 <span class="ver-tag">ver5.2</span>';
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
  partialLoopInput.checked = false;
  playbackTypeSelect.onchange();
  updatePhaseInputsUI();
  trimStartInput.value = '0.00';
  trimEndInput.value = '0.00';

  overwriteModeSelect.value = 'none';
  targetSoundGroup.classList.add('hidden');
  disableOverwriteInput.checked = false;
  updatePauseButtonUI();
  modal.classList.remove('hidden');
}

async function openEditModal(sound) {
  editingSoundId = sound.id;
  document.getElementById('modal-title').innerHTML = 'ボタンを編集 <span class="ver-tag">ver5.2</span>';
  fileGroup.classList.add('hidden');
  deleteBtn.classList.remove('hidden');
  nameInput.value = sound.name;
  setModalImagePreview(sound.imageDataUrl || null);
  colorInput.value = sound.color;
  volumeInput.value = sound.volume ?? 100;
  volumeLabel.textContent = sound.volume ?? 100;
  
  playbackTypeSelect.value = sound.playbackType || 'normal';
  partialLoopInput.checked = !!sound.isPartialLoop;
  playbackTypeSelect.onchange();

  overwriteModeSelect.value = sound.overwriteMode || 'none';
  if (sound.overwriteMode === 'conditional') {
    targetSoundGroup.classList.remove('hidden');
    updateTargetSoundDropdown(sound.id);
    targetSoundSelect.value = sound.targetSoundId || '';
  } else {
    targetSoundGroup.classList.add('hidden');
  }
  
  disableOverwriteInput.checked = !!sound.disableOverwrite;
  updatePauseButtonUI();
  modal.classList.remove('hidden');

  if (sound.audioData) {
    await loadBufferIntoEditor(
      sound.audioData, 
      sound.trimStart ?? 0, 
      sound.trimEnd ?? null, 
      sound.seamlessPhases ?? null,
      sound.loopStart ?? null,
      sound.loopEnd ?? null
    );
  }
}

// === イベントリスナー ===
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

// === バックアップの書き出し (Export JSON / ver5.1互換) ===
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
        for (let i = 0; i < bytes.byteLength; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        b64 = btoa(binary);
      }
      return { ...s, audioDataB64: b64, audioData: undefined };
    });

    const backupData = {
      version: '5.2',
      exportDate: new Date().toISOString(),
      categories: allCats,
      sounds: allSounds
    };

    const jsonStr = JSON.stringify(backupData, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `soundboard_backup_lv5_${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error(err);
    alert('バックアップの書き出しに失敗しました: ' + err.message);
  }
};

// === バックアップの読み込み・同期 (Import JSON / ver5.1互換) ===
const importFileInput = document.getElementById('import-file-input');
document.getElementById('import-backup-btn').onclick = () => {
  if (confirm('現在のサウンドボードのデータがすべて、バックアップファイルの状態に上書き（同期）されます。よろしいですか？')) {
    importFileInput.click();
  }
};

importFileInput.onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  try {
    stopAllSounds();
    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const backup = JSON.parse(event.target.result);
        if (!backup.categories || !backup.sounds) {
          throw new Error('無効なバックアップファイル形式です。');
        }

        await dbClear('categories');
        await dbClear('sounds');
        decodedBufferCache.clear();

        for (const cat of backup.categories) {
          await dbPut('categories', cat);
        }

        for (const s of backup.sounds) {
          let ab = null;
          if (s.audioDataB64) {
            const binaryString = atob(s.audioDataB64);
            const len = binaryString.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) {
              bytes[i] = binaryString.charCodeAt(i);
            }
            ab = bytes.buffer;
          }
          const restoredSound = {
            ...s,
            audioDataB64: undefined,
            audioData: ab
          };
          await dbPut('sounds', restoredSound);
        }

        categories = await dbGetAll('categories');
        sounds = await dbGetAll('sounds');
        categories.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        currentCategoryId = categories.length > 0 ? categories[0].id : null;

        renderCategories();
        renderSounds();
        importFileInput.value = '';
        alert('バックアップの復元・同期が正常に完了しました！');
      } catch (parseErr) {
        console.error(parseErr);
        alert('ファイルの読み込みに失敗しました: ' + parseErr.message);
      }
    };
    reader.readAsText(file);
  } catch (err) {
    console.error(err);
    alert('インポート処理に失敗しました。');
  }
};

document.getElementById('open-add-modal-btn').onclick = openAddModal;
document.getElementById('cancel-modal-btn').onclick = closeModal;
document.getElementById('close-modal-x-btn').onclick = closeModal;

volumeInput.oninput = () => {
  volumeLabel.textContent = volumeInput.value;
  if (previewGainNode) previewGainNode.gain.value = Number(volumeInput.value) / 100;
};

document.querySelectorAll('.color-swatch').forEach((swatch) => {
  swatch.onclick = () => { colorInput.value = swatch.dataset.color; };
});

fileInput.onchange = async () => {
  if (fileInput.files.length > 0) {
    const file = fileInput.files[0];
    if (!nameInput.value) nameInput.value = file.name.replace(/\.[^/.]+$/, '');
    const arrayBuffer = await file.arrayBuffer();
    await loadBufferIntoEditor(arrayBuffer);
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
  const loopStart = parseFloat(singleLoopStartInput.value) || trimStart;
  const loopEnd = parseFloat(singleLoopEndInput.value) || trimEnd;
  const seamlessPhases = JSON.parse(JSON.stringify(soundPhasesData));

  const overwriteMode = overwriteModeSelect.value;
  const targetSoundId = overwriteMode === 'conditional' ? targetSoundSelect.value : null;
  const disableOverwrite = disableOverwriteInput.checked;

  if (editingSoundId) {
    const target = sounds.find((s) => s.id === editingSoundId);
    target.name = name;
    target.color = color;
    target.imageDataUrl = imageDataUrl;
    target.volume = volume;
    target.playbackType = playbackType;
    target.isPartialLoop = isPartialLoop;
    target.trimStart = trimStart;
    target.trimEnd = trimEnd;
    target.loopStart = loopStart;
    target.loopEnd = loopEnd;
    target.seamlessPhases = seamlessPhases;
    target.overwriteMode = overwriteMode;
    target.targetSoundId = targetSoundId;
    target.disableOverwrite = disableOverwrite;
    await dbPut('sounds', target);
  } else {
    if (!fileInput.files || fileInput.files.length === 0) {
      alert('音声ファイルを選択してください！');
      return;
    }
    const file = fileInput.files[0];
    const arrayBuffer = await file.arrayBuffer();
    const catSoundsCount = sounds.filter(s => s.categoryId === currentCategoryId).length;
    const newSound = {
      id: 'snd_' + Date.now(),
      categoryId: currentCategoryId,
      order: catSoundsCount,
      name,
      color,
      imageDataUrl,
      volume,
      playbackType,
      isPartialLoop,
      trimStart,
      trimEnd,
      loopStart,
      loopEnd,
      seamlessPhases,
      overwriteMode,
      targetSoundId,
      disableOverwrite,
      audioData: arrayBuffer
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
    sounds = sounds.filter((s) => s.id !== editingSoundId);
    const catSounds = sounds.filter(s => s.categoryId === currentCategoryId);
    for (let i = 0; i < catSounds.length; i++) {
      catSounds[i].order = i;
      await dbPut('sounds', catSounds[i]);
    }
    closeModal();
    renderSounds();
  }
};

// === 初期化 ===
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
