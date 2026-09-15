import React, { useState, useEffect, useRef } from 'react';
import { MidiDeviceManager } from './engine/midi/MidiDeviceManager';
import { PlaybackEngine } from './engine/audio/PlaybackEngine';
import { MidiParser } from './engine/parser/MidiParser';
import { StorageManager, SongMetadata } from './storage/StorageManager';
import { MidiSongData, EnsemblePreset, LaneSlot, MidiTrackInfo } from './models/SongModels';
import { UnifiedMidiEndpoint } from './engine/midi/types';
import { loadRegisteredPresets, registerMcuPreset, deleteRegisteredPreset, InstrumentPreset, NONE_PRESET } from './models/InstrumentPreset';
import { CanvasVisualizer } from './visualizer/CanvasVisualizer';
import { CircularColorPicker } from './components/CircularColorPicker';
import { CalibrationView } from './components/calibration/CalibrationView';

// デフォルトのチャンネル色配列 (カスタム未設定時に適用)
const DEFAULT_CHANNEL_COLORS = [
  '#FF4D4D', '#FF8533', '#FFC000', '#2ECC71',
  '#00D2D3', '#3498DB', '#9B59B6', '#E056FD',
  '#FF6B81', '#1DD1A1', '#F368E0', '#54A0FF',
  '#5F27CD', '#C8D6E5', '#FF9F43', '#10AC84'
];

export function App() {
  const [songs, setSongs] = useState<MidiSongData[]>([]);
  const [selectedSongId, setSelectedSongId] = useState<string | null>(null);
  const [endpoints, setEndpoints] = useState<UnifiedMidiEndpoint[]>([]);
  const [selectedEndpointId, setSelectedEndpointId] = useState<string | null>(null);
  // イベントリスナーから常に最新の選択状態を参照するための ref
  const currentSongRef = useRef<{ id: string | null; songs: MidiSongData[] }>({ id: null, songs: [] });
  useEffect(() => {
    currentSongRef.current = { id: selectedSongId, songs };
  }, [selectedSongId, songs]);

  const [knownPresets, setKnownPresets] = useState<InstrumentPreset[]>(() => loadRegisteredPresets());
  const [availableTargets, setAvailableTargets] = useState<InstrumentPreset[]>(() =>
    MidiDeviceManager.getInstance().getAvailableMcuTargets()
  );

  // サイドバー表示 & パネルリサイズ
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [devicePanelHeight, setDevicePanelHeight] = useState(260);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);

  // 楽器プリセット管理モーダル
  const [isManageModalOpen, setIsManageModalOpen] = useState(false);
  const [newMcuInput, setNewMcuInput] = useState('');

  // 編成プリセット
  const [presets, setPresets] = useState<EnsemblePreset[]>([{ id: 'default', name: 'プリセット 1', songSlots: {} }]);
  const [activePresetId, setActivePresetId] = useState('default');
  const [isPresetMenuOpen, setIsPresetMenuOpen] = useState(false);
  const presetMenuRef = useRef<HTMLDivElement | null>(null);

  // ビジュアライザー設定
  const [selectedTab, setSelectedTab] = useState<'visualizer' | 'settings' | 'calibration'>('visualizer');
  const [isControlBarOpen, setIsControlBarOpen] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentPlaybackMs, setCurrentPlaybackMs] = useState(0);
  const [isMetronome, setIsMetronome] = useState(true);
  const [isBgm, setIsBgm] = useState(true);
  const [isChromaKey, setIsChromaKey] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [showAllCh, setShowAllCh] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [scrollSpeed, setScrollSpeed] = useState(0.20);

  // オフセット（カウントイン）設定
  const [isMetroMenuOpen, setIsMetroMenuOpen] = useState(false);
  const [isCountInEnabled, setIsCountInEnabled] = useState(false);
  const [countInBars, setCountInBars] = useState(1);
  const metroMenuRef = useRef<HTMLDivElement | null>(null);

  // 楽曲リストのドラッグ＆ドロップ並び替え状態
  const [draggedSongIndex, setDraggedSongIndex] = useState<number | null>(null);
  const [dragOverSongIndex, setDragOverSongIndex] = useState<number | null>(null);

  // ストレージ情報
  const [isStorageMenuOpen, setIsStorageMenuOpen] = useState(false);
  const [storageInfo, setStorageInfo] = useState<{ usage: number; quota: number } | null>(null);
  const storageMenuRef = useRef<HTMLDivElement | null>(null);

  const [testPitch, setTestPitch] = useState(60);
  // 開いているカラーピッカーのスロットID
  const [activeColorPickerSlotId, setActiveColorPickerSlotId] = useState<string | null>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (presetMenuRef.current && !presetMenuRef.current.contains(target)) {
        setIsPresetMenuOpen(false);
      }
      if (storageMenuRef.current && !storageMenuRef.current.contains(target)) {
        setIsStorageMenuOpen(false);
      }
      if (metroMenuRef.current && !metroMenuRef.current.contains(target)) {
      setIsMetroMenuOpen(false);
    }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  const handleStartResize = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizingSidebar(true);
    const startY = e.clientY;
    const initialHeight = devicePanelHeight;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const deltaY = moveEvent.clientY - startY;
      const clamped = Math.min(Math.max(100, initialHeight - deltaY), 550);
      setDevicePanelHeight(clamped);
    };

    const onMouseUp = () => {
      setIsResizingSidebar(false);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  const handleOpenStorageInfo = async () => {
    if (navigator.storage && navigator.storage.estimate) {
      const estimate = await navigator.storage.estimate();
      setStorageInfo({
        usage: estimate.usage ?? 0,
        quota: estimate.quota ?? 0
      });
    }
    setIsStorageMenuOpen(prev => !prev);
  };

  const formatBytes = (bytes: number) => {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  const formatTime = (ms: number) => {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const formattedSec = seconds.toString().padStart(2, '0');

    if (hours > 0) {
      const formattedMin = minutes.toString().padStart(2, '0');
      return `${hours}:${formattedMin}:${formattedSec}`;
    }
    return `${minutes}:${formattedSec}`;
  };

  // 詳細設定を展開しているスロットIDの一覧
  const [expandedSlotIds, setExpandedSlotIds] = useState<Set<string>>(new Set());

  const toggleSlotDetails = (slotId: string) => {
    setExpandedSlotIds(prev => {
      const next = new Set(prev);
      if (next.has(slotId)) {
        next.delete(slotId);
      } else {
        next.add(slotId);
      }
      return next;
    });
  };

  // --- 1. 起動時ロード & デバイス購読 (初回マウント時のみ実行) ---
  useEffect(() => {
    const midiMgr = MidiDeviceManager.getInstance();
    midiMgr.initWebMidi();

    const unsubMidi = midiMgr.subscribe(newEndpoints => {
      setEndpoints(newEndpoints);
      setKnownPresets(loadRegisteredPresets());
      setAvailableTargets(midiMgr.getAvailableMcuTargets());

      // マイコン接続時に、現在選択されている楽曲のスロット設定を最新状態で再評価
      const { id, songs: currentSongList } = currentSongRef.current;
      if (id) {
        const active = currentSongList.find(s => s.id === id);
        if (active) PlaybackEngine.getInstance().updateSlotConfiguration(active);
      }
    });

    const engine = PlaybackEngine.getInstance();
    const unsubAudio = engine.subscribe((playing, ms) => {
      setIsPlaying(playing);
      setCurrentPlaybackMs(ms);
    });

    const initLoad = async () => {
      const storage = StorageManager.getInstance();

      let loadedPresets: EnsemblePreset[] = [{ id: 'default', name: 'プリセット 1', songSlots: {} }];
      let loadedActiveId = 'default';

      const presetData = await storage.loadPresetsData();
      if (presetData && presetData.presets.length > 0) {
        loadedPresets = presetData.presets;
        loadedActiveId = presetData.activePresetID;
        setPresets(loadedPresets);
        setActivePresetId(loadedActiveId);
      }

      const metadataList = await storage.loadSongMetadataList();
      const loadedSongs: MidiSongData[] = [];

      for (const meta of metadataList) {
        const midiBuffer = await storage.getBlob(meta.midiBlobKey);
        if (!midiBuffer) continue;

        const song = MidiParser.parse(midiBuffer, meta.fileName, meta.id);
        song.bgmBlobKey = meta.bgmBlobKey;
        song.bgmFileName = meta.bgmFileName;

        const activePreset = loadedPresets.find(p => p.id === loadedActiveId);
        if (activePreset && activePreset.songSlots[meta.id] && activePreset.songSlots[meta.id].length > 0) {
          song.slots = activePreset.songSlots[meta.id];
        } else if (meta.slots && meta.slots.length > 0) {
          song.slots = meta.slots;
        }

        loadedSongs.push(song);
      }

      if (loadedSongs.length > 0) {
        setSongs(loadedSongs);
        const first = loadedSongs[0];
        setSelectedSongId(first.id);
        engine.prepareSong(first);

        if (first.bgmBlobKey) {
          const bgmBuf = await storage.getBlob(first.bgmBlobKey);
          if (bgmBuf) await engine.setBgmAudio(bgmBuf);
        }
      }
    };

    initLoad();

    return () => {
      unsubMidi();
      unsubAudio();
    };
  }, []); // ← ここを [selectedSongId] から空配列 [] に変更

  useEffect(() => {
    if (!isPlaying) return;
    const timer = window.setInterval(() => {
      setCurrentPlaybackMs(PlaybackEngine.getInstance().getCurrentPlaybackMs());
    }, 50);
    return () => clearInterval(timer);
  }, [isPlaying]);

  const currentSong = songs.find(s => s.id === selectedSongId) ?? null;
  const currentEndpoint = endpoints.find(e => e.id === selectedEndpointId) ?? null;
  const activePreset = presets.find(p => p.id === activePresetId);

  // 楽曲のトラックまたはチャンネルの選択肢一覧を取得
  const getSourceOptions = (song: MidiSongData) => {
    const validTracks = song.tracks ? song.tracks.filter(t => t.notes.length > 0) : [];
    if (validTracks.length > 1) {
      // Format 1: トラック一覧を選択肢にする
      return validTracks.map(tr => ({
        trackIndex: tr.trackIndex,
        channel: tr.notes[0]?.channel ?? 0,
        label: `${tr.name} (${tr.notes.length} notes)`
      }));
    } else {
      // Format 0: チャンネル一覧を選択肢にする
      return (song.usedChannels ?? []).map(ch => ({
        trackIndex: undefined,
        channel: ch,
        label: `Ch ${ch + 1} (${song.channelCaches[ch]?.noteCount ?? 0} notes)`
      }));
    }
  };

  const persistAll = async (
    targetSongs: MidiSongData[] = songs,
    targetPresets: EnsemblePreset[] = presets,
    targetActivePresetId: string = activePresetId
  ) => {
    const storage = StorageManager.getInstance();

    const syncedPresets = targetPresets.map(p => {
      if (p.id === targetActivePresetId) {
        const slotsMap: Record<string, LaneSlot[]> = { ...p.songSlots };
        for (const s of targetSongs) {
          // 各スロットオブジェクトを確実に複製して保存
          slotsMap[s.id] = s.slots.map(slot => ({ ...slot }));
        }
        return { ...p, songSlots: slotsMap };
      }
      return p;
    });

    setPresets(syncedPresets);

    await storage.savePresetsData({
      activePresetID: targetActivePresetId,
      presets: syncedPresets
    });

    const metaList: SongMetadata[] = targetSongs.map(s => ({
      id: s.id,
      fileName: s.fileName,
      midiBlobKey: s.midiBlobKey,
      bgmBlobKey: s.bgmBlobKey,
      bgmFileName: s.bgmFileName,
      slots: s.slots
    }));
    await storage.saveSongMetadataList(metaList);
  };

  const handleMidiUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const newSongs: MidiSongData[] = [];
    const storage = StorageManager.getInstance();

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const buffer = await file.arrayBuffer();
      const parsed = MidiParser.parse(buffer, file.name);
      await storage.saveBlob(parsed.midiBlobKey, buffer);
      newSongs.push(parsed);
    }

    const updatedSongs = [...songs, ...newSongs];
    setSongs(updatedSongs);

    if (!selectedSongId && newSongs.length > 0) {
      const first = newSongs[0];
      setSelectedSongId(first.id);
      PlaybackEngine.getInstance().prepareSong(first);
    }

    await persistAll(updatedSongs);
  };

  const handleDeleteSong = async (songToDelete: MidiSongData) => {
    const storage = StorageManager.getInstance();
    await storage.deleteSong(songToDelete.id, songToDelete.midiBlobKey, songToDelete.bgmBlobKey);

    const updatedSongs = songs.filter(s => s.id !== songToDelete.id);
    setSongs(updatedSongs);

    const updatedPresets = presets.map(p => {
      const newSlots = { ...p.songSlots };
      delete newSlots[songToDelete.id];
      return { ...p, songSlots: newSlots };
    });

    if (selectedSongId === songToDelete.id) {
      if (updatedSongs.length > 0) {
        setSelectedSongId(updatedSongs[0].id);
        PlaybackEngine.getInstance().prepareSong(updatedSongs[0]);
      } else {
        setSelectedSongId(null);
        PlaybackEngine.getInstance().prepareSong(null);
      }
    }

    await persistAll(updatedSongs, updatedPresets);
  };

  const handleDropSong = async (targetIndex: number) => {
    if (draggedSongIndex === null || draggedSongIndex === targetIndex) {
      setDraggedSongIndex(null);
      setDragOverSongIndex(null);
      return;
    }

    const updated = [...songs];
    const [movedItem] = updated.splice(draggedSongIndex, 1);
    updated.splice(targetIndex, 0, movedItem);

    setSongs(updated);
    setDraggedSongIndex(null);
    setDragOverSongIndex(null);

    // 変更後の並び順をストレージへ保存
    await persistAll(updated);
  };

  const handleSelectSong = async (song: MidiSongData) => {
    if (selectedSongId === song.id) return;
    setSelectedSongId(song.id);
    const engine = PlaybackEngine.getInstance();
    engine.prepareSong(song);

    if (song.bgmBlobKey) {
      const bgmBuf = await StorageManager.getInstance().getBlob(song.bgmBlobKey);
      if (bgmBuf) await engine.setBgmAudio(bgmBuf);
    } else {
      engine.clearBgmAudio();
    }
  };

  const handleBgmUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !currentSong) return;

    const buffer = await file.arrayBuffer();
    const blobKey = `bgm_${currentSong.id}`;
    await StorageManager.getInstance().saveBlob(blobKey, buffer);
    await PlaybackEngine.getInstance().setBgmAudio(buffer);

    const updatedSongs = songs.map(s =>
      s.id === currentSong.id ? { ...s, bgmBlobKey: blobKey, bgmFileName: file.name } : s
    );
    setSongs(updatedSongs);
    await persistAll(updatedSongs);
  };

  const handleSelectPreset = async (targetId: string) => {
    if (activePresetId === targetId) return;

    const targetPreset = presets.find(p => p.id === targetId);
    if (!targetPreset) return;

    const updatedSongs = songs.map(song => {
      const savedSlots = targetPreset.songSlots[song.id];
      return savedSlots && savedSlots.length > 0 ? { ...song, slots: savedSlots } : song;
    });

    setActivePresetId(targetId);
    setSongs(updatedSongs);

    if (currentSong) {
      const currentUpdated = updatedSongs.find(s => s.id === currentSong.id);
      if (currentUpdated) {
        PlaybackEngine.getInstance().updateSlotConfiguration(currentUpdated);
      }
    }

    await persistAll(updatedSongs, presets, targetId);
  };

  const handleAddPreset = async () => {
    const newId = crypto.randomUUID();
    const newPreset: EnsemblePreset = {
      id: newId,
      name: `プリセット ${presets.length + 1}`,
      songSlots: {}
    };

    const updatedPresets = [...presets, newPreset];
    setPresets(updatedPresets);
    setActivePresetId(newId);

    await persistAll(songs, updatedPresets, newId);
  };

  const handleRenamePreset = async () => {
    if (!activePreset) return;
    const newName = window.prompt('編成プリセットの新しい名前を入力してください:', activePreset.name);
    if (!newName || !newName.trim()) return;

    const trimmed = newName.trim();
    const updatedPresets = presets.map(p =>
      p.id === activePresetId ? { ...p, name: trimmed } : p
    );
    setPresets(updatedPresets);
    await persistAll(songs, updatedPresets, activePresetId);
  };

  const handleDeletePreset = async () => {
    if (presets.length <= 1) {
      alert('これ以上プリセットを削除することはできません。');
      return;
    }
    if (!activePreset) return;

    const confirmDelete = window.confirm(`プリセット「${activePreset.name}」を削除してもよろしいですか？`);
    if (!confirmDelete) return;

    const targetIdx = presets.findIndex(p => p.id === activePresetId);
    const updatedPresets = presets.filter(p => p.id !== activePresetId);
    const nextPreset = updatedPresets[Math.max(0, targetIdx - 1)];
    const nextId = nextPreset.id;

    const updatedSongs = songs.map(song => {
      const savedSlots = nextPreset.songSlots[song.id];
      return savedSlots && savedSlots.length > 0 ? { ...song, slots: savedSlots } : song;
    });

    setActivePresetId(nextId);
    setPresets(updatedPresets);
    setSongs(updatedSongs);

    if (currentSong) {
      const currentUpdated = updatedSongs.find(s => s.id === currentSong.id);
      if (currentUpdated) {
        PlaybackEngine.getInstance().updateSlotConfiguration(currentUpdated);
      }
    }

    await persistAll(updatedSongs, updatedPresets, nextId);
  };

  // 通常のレーン追加（親スロットの追加）
  // 変更後: inheritPreset を受け取れるようにする（未指定時は NONE_PRESET）
  const handleAddSlot = async (inheritPreset: InstrumentPreset = NONE_PRESET) => {
    if (!currentSong) return;
    const defaultCh = currentSong.usedChannels[0] ?? 0;
    const newSlot: LaneSlot = {
      id: crypto.randomUUID(),
      isEnabled: true,
      selectedChannel: defaultCh,
      assignedPreset: inheritPreset,
      outputChannel: defaultCh,
      latencyOffsetMs: inheritPreset.defaultOffsetMs ?? 0.0,
      customColor: DEFAULT_CHANNEL_COLORS[defaultCh % 16]
    };
    const updatedSlots = [...currentSong.slots, newSlot];
    const updatedSong = { ...currentSong, slots: updatedSlots };
    const updatedSongs = songs.map(s => (s.id === currentSong.id ? updatedSong : s));

    setSongs(updatedSongs);
    PlaybackEngine.getInstance().updateSlotConfiguration(updatedSong);
    await persistAll(updatedSongs);
  };

  // 詳細設定内での「＋ サブチャンネルを追加」
  const handleAddChildSlot = async (parentSlot: LaneSlot) => {
    if (!currentSong) return;
    const existingChildren = currentSong.slots.filter(s => s.parentId === parentSlot.id);
    const nextOutputCh = Math.min(15, (parentSlot.outputChannel ?? 0) + existingChildren.length + 1);
    const defaultCh = currentSong.usedChannels[Math.min(currentSong.usedChannels.length - 1, existingChildren.length + 1)] ?? 0;

    // ★ 親チャンネルと同じ色を取得して初期値にセット
    const parentColor = parentSlot.customColor || DEFAULT_CHANNEL_COLORS[parentSlot.selectedChannel % 16];

    const newChildSlot: LaneSlot = {
      id: crypto.randomUUID(),
      parentId: parentSlot.id,
      isEnabled: true,
      selectedChannel: defaultCh,
      assignedPreset: parentSlot.assignedPreset,
      outputChannel: nextOutputCh,
      latencyOffsetMs: parentSlot.latencyOffsetMs,
      customColor: parentColor // ★ 親と同じ色
    };

    const updatedSlots = [...currentSong.slots, newChildSlot];
    const updatedSong = { ...currentSong, slots: updatedSlots };
    const updatedSongs = songs.map(s => (s.id === currentSong.id ? updatedSong : s));

    setSongs(updatedSongs);
    PlaybackEngine.getInstance().updateSlotConfiguration(updatedSong);
    await persistAll(updatedSongs);
  };

  // スロットの更新ハンドラ（未登録スロットの自動追加対応）
  const handleUpdateSlot = async (slotId: string, updates: Partial<LaneSlot>, fallbackTrack?: MidiTrackInfo) => {
    if (!currentSong) return;

    const exists = currentSong.slots.some(s => s.id === slotId);
    let updatedSlots: LaneSlot[];

    if (exists) {
      updatedSlots = currentSong.slots.map(s => {
        if (s.id === slotId) {
          return { ...s, ...updates };
        }
        return s;
      });
    } else {
      // ★ slotId が未保存の仮想スロット（auto_X）の場合、新規スロットとして登録
      const newSlot: LaneSlot = {
        id: crypto.randomUUID(),
        isEnabled: true,
        trackIndex: updates.trackIndex ?? fallbackTrack?.trackIndex ?? 0,
        selectedChannel: updates.selectedChannel ?? fallbackTrack?.notes[0]?.channel ?? 0,
        outputChannel: updates.outputChannel ?? fallbackTrack?.notes[0]?.channel ?? 0,
        assignedPreset: updates.assignedPreset ?? NONE_PRESET,
        latencyOffsetMs: updates.latencyOffsetMs ?? 0.0,
        customColor: updates.customColor ?? DEFAULT_CHANNEL_COLORS[(updates.trackIndex ?? 0) % 16],
        ...updates
      };
      updatedSlots = [...currentSong.slots, newSlot];
    }

    const updatedSong = { ...currentSong, slots: updatedSlots };
    const updatedSongs = songs.map(s => (s.id === currentSong.id ? updatedSong : s));

    setSongs(updatedSongs);
    PlaybackEngine.getInstance().updateSlotConfiguration(updatedSong);
    await persistAll(updatedSongs);
  };

  const handleDeleteSlot = async (slotId: string) => {
    if (!currentSong) return;
    // 対象スロット、およびそれを親とする子スロットもまとめて削除
    const updatedSlots = currentSong.slots.filter(s => s.id !== slotId && s.parentId !== slotId);
    const updatedSong = { ...currentSong, slots: updatedSlots };
    const updatedSongs = songs.map(s => (s.id === currentSong.id ? updatedSong : s));

    setSongs(updatedSongs);
    PlaybackEngine.getInstance().updateSlotConfiguration(updatedSong);
    await persistAll(updatedSongs);
  };

  // --- 楽器手動事前登録 ---
  const handleRegisterManualMcu = () => {
    const trimmed = newMcuInput.trim();
    if (!trimmed) return;
    registerMcuPreset(trimmed);
    setNewMcuInput('');
    setKnownPresets(loadRegisteredPresets());
    setAvailableTargets(MidiDeviceManager.getInstance().getAvailableMcuTargets());
  };

  // --- セーフティ付き 楽器プリセット削除 ---
  const handleDeletePresetSafely = async (preset: InstrumentPreset) => {
    const isOnline = endpoints.some(
      ep => ep.identifiedPreset && ep.identifiedPreset.mcuName.toLowerCase() === preset.mcuName.toLowerCase()
    );
    if (isOnline) {
      alert(`「${preset.name}」は現在マイコンが物理接続中のため削除できません。USB/Bluetoothを切断してから削除してください。`);
      return;
    }

    const usedSongs = songs.filter(s =>
      s.slots.some(slot => slot.assignedPreset?.mcuName.toLowerCase() === preset.mcuName.toLowerCase())
    );

    let confirmMsg = `楽器プリセット「${preset.name}」を削除しますか？`;
    if (usedSongs.length > 0) {
      confirmMsg =
        `「${preset.name}」は以下の楽曲のレーンで使用されています:\n` +
        usedSongs.map(s => `・${s.fileName}`).join('\n') +
        `\n\n削除すると、これらのレーンの送信先楽器は「None」に変更されます。本当に削除しますか？`;
    }

    if (!window.confirm(confirmMsg)) return;

    deleteRegisteredPreset(preset.mcuName);

    const updatedSongs = songs.map(song => {
      const nextSlots = song.slots.map(slot => {
        if (slot.assignedPreset?.mcuName.toLowerCase() === preset.mcuName.toLowerCase()) {
          return { ...slot, assignedPreset: NONE_PRESET, latencyOffsetMs: 0.0 };
        }
        return slot;
      });
      return { ...song, slots: nextSlots };
    });

    const updatedPresets = presets.map(p => {
      const nextSongSlots: Record<string, LaneSlot[]> = {};
      for (const [songId, slots] of Object.entries(p.songSlots)) {
        nextSongSlots[songId] = slots.map(slot => {
          if (slot.assignedPreset?.mcuName.toLowerCase() === preset.mcuName.toLowerCase()) {
            return { ...slot, assignedPreset: NONE_PRESET, latencyOffsetMs: 0.0 };
          }
          return slot;
        });
      }
      return { ...p, songSlots: nextSongSlots };
    });

    setSongs(updatedSongs);
    setPresets(updatedPresets);
    setKnownPresets(loadRegisteredPresets());
    setAvailableTargets(MidiDeviceManager.getInstance().getAvailableMcuTargets());

    if (currentSong) {
      const active = updatedSongs.find(s => s.id === currentSong.id);
      if (active) PlaybackEngine.getInstance().updateSlotConfiguration(active);
    }

    await persistAll(updatedSongs, updatedPresets);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#0A0E1A', color: '#E2EFFF', fontFamily: 'sans-serif' }}>
      {/* 1. トランスポートバー */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '8px 16px', background: '#141D34', borderBottom: '3px solid #72829F', gap: 12 }}>
        <button
          onClick={() => setIsSidebarOpen(prev => !prev)}
          title={isSidebarOpen ? 'サイドバーを隠す' : 'サイドバーを表示'}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '5px 8px',
            background: isSidebarOpen ? '#243B54' : '#1C2742',
            border: '1px solid #243B54',
            borderRadius: 6,
            color: '#A4D3FF',
            cursor: 'pointer'
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <line x1="9" y1="3" x2="9" y2="21" />
          </svg>
        </button>

        <button
          onClick={() => PlaybackEngine.getInstance().togglePlayPause()}
          style={{ padding: '6px 14px', background: '#587CEA', border: 'none', borderRadius: 6, fontWeight: 'bold', cursor: 'pointer', color: '#ffffff' }}
        >
          {isPlaying ? 'PAUSE' : 'PLAY'}
        </button>
        <button
          onClick={() => PlaybackEngine.getInstance().stop()}
          style={{ padding: '6px 11px', background: '#3E4163', border: 'none', borderRadius: 6, color: '#E2EFFF', cursor: 'pointer' }}
        >
          STOP
        </button>

        <input
          type="range"
          min={0}
          max={currentSong?.durationMs ?? 100}
          value={currentPlaybackMs}
          onChange={e => PlaybackEngine.getInstance().seek(Number(e.target.value))}
          style={{ flex: 1, accentColor: '#A4D3FF' }}
        />
        <span style={{ fontSize: 12, fontFamily: 'monospace', minWidth: 80, textAlign: 'center' }}>
          {formatTime(currentPlaybackMs)} / {formatTime(currentSong?.durationMs ?? 0)}
        </span>

        {/* Click スプリットボタン（左: ON/OFF切替 / 右: オフセット設定メニュー） */}
        <div
          ref={metroMenuRef}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            background: isMetronome ? '#706cad' : '#1C2742',
            borderRadius: 6,
            position: 'relative'
          }}
        >
          {/* 左側ボタンに minWidth を指定して幅の変動をロック */}
          <button
            onClick={() => {
              const next = !isMetronome;
              setIsMetronome(next);
              PlaybackEngine.getInstance().isMetronomeEnabled = next;
            }}
            style={{
              minWidth: 94, // ★ 幅をあらかじめ固定してレイアウトシフトをゼロにする
              textAlign: 'center',
              padding: '4px 6px',
              background: 'transparent',
              border: 'none',
              color: '#E2EFFF',
              fontSize: 11,
              cursor: 'pointer',
              fontWeight: 'bold',
              borderTopLeftRadius: 6,
              borderBottomLeftRadius: 6
            }}
          >
            Click {isMetronome ? 'ON' : 'OFF'}
            {isCountInEnabled && <span style={{ fontSize: 9, marginLeft: 3, opacity: 0.85 }}>({countInBars}小節)</span>}
          </button>

          {/* 細い区切り線 */}
          <div style={{ width: 1, height: 12, background: isMetronome ? 'rgba(255,255,255,0.25)' : '#243B54' }} />

          {/* 右側: ドロップダウンアクセスボタン */}
          <button
            onClick={() => setIsMetroMenuOpen(prev => !prev)}
            title="オフセット設定"
            style={{
              padding: '4px 6px',
              background: 'transparent',
              border: 'none',
              color: '#E2EFFF',
              fontSize: 8,
              cursor: 'pointer',
              borderTopRightRadius: 6,
              borderBottomRightRadius: 6,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            ▼
          </button>

          {/* ドロップダウンメニュー（オフセット設定のみ） */}
          {isMetroMenuOpen && (
            <div
              style={{
                position: 'absolute',
                top: 'calc(100% + 5px)',
                left: 0,
                width: 200,
                background: '#141D34',
                border: '1px solid #DBB28A',
                borderRadius: 6,
                boxShadow: '0 6px 18px rgba(0,0,0,0.6)',
                padding: '10px 12px',
                zIndex: 1000,
                display: 'flex',
                flexDirection: 'column',
                gap: 10
              }}
            >
              <div style={{ fontSize: 11, fontWeight: 'bold', color: '#8FA4C4', borderBottom: '1px solid #243B54', paddingBottom: 4 }}>
                オフセット再生設定
              </div>

              {/* オフセット有効/無効 */}
              <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12, cursor: 'pointer' }}>
                <span style={{ color: '#E2EFFF' }}>オフセット再生</span>
                <input
                  type="checkbox"
                  checked={isCountInEnabled}
                  onChange={e => {
                    const next = e.target.checked;
                    setIsCountInEnabled(next);
                    PlaybackEngine.getInstance().setCountInConfig(next, countInBars);
                  }}
                />
              </label>

              {/* オフセット小節数 */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', opacity: isCountInEnabled ? 1 : 0.45 }}>
                <span style={{ fontSize: 11, color: '#8FA4C4' }}>助走小節数:</span>
                <select
                  disabled={!isCountInEnabled}
                  value={countInBars}
                  onChange={e => {
                    const val = Number(e.target.value);
                    setCountInBars(val);
                    PlaybackEngine.getInstance().setCountInConfig(isCountInEnabled, val);
                  }}
                  style={{
                    background: '#1C2742',
                    color: '#E2EFFF',
                    border: '1px solid #243B54',
                    borderRadius: 4,
                    fontSize: 11,
                    padding: '2px 6px'
                  }}
                >
                  <option value={1}>1 小節</option>
                  <option value={2}>2 小節</option>
                  <option value={4}>4 小節</option>
                </select>
              </div>
            </div>
          )}
        </div>
        <button
          onClick={() => {
            const next = !isBgm;
            setIsBgm(next);
            PlaybackEngine.getInstance().isBgmEnabled = next;
          }}
          style={{ padding: '4px 8px', background: isBgm ? '#8871c4' : '#1C2742', border: 'none', borderRadius: 6, color: '#E2EFFF', fontSize: 11, cursor: 'pointer' }}
        >
          BGM {isBgm ? 'ON' : 'OFF'}
        </button>

        {/* 編成プリセット管理 */}
        <div ref={presetMenuRef} style={{ position: 'relative' }}>
          <button
            onClick={() => setIsPresetMenuOpen(prev => !prev)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: '#1C2742',
              color: '#E2EFFF',
              border: '1.5px solid #243B54',
              borderRadius: 6,
              padding: '5px 10px',
              fontSize: 12,
              cursor: 'pointer'
            }}
          >
            <span>{activePreset?.name ?? 'プリセット選択'}</span>
            <span style={{ fontSize: 9, color: '#A4D3FF' }}>▼</span>
          </button>

          {isPresetMenuOpen && (
            <div
              style={{
                position: 'absolute',
                top: 'calc(100% + 4px)',
                left: 0,
                minWidth: 200,
                background: '#141D34',
                border: '1px solid #e7cdad',
                borderRadius: 6,
                boxShadow: '0 6px 18px rgba(0,0,0,0.55)',
                padding: '4px 0',
                zIndex: 1000
              }}
            >
              <div style={{ padding: '5px 12px', fontSize: 10, fontWeight: 'bold', color: '#8FA4C4' }}>
                編成プリセット選択
              </div>
              {presets.map(p => (
                <div
                  key={p.id}
                  onClick={() => {
                    handleSelectPreset(p.id);
                    setIsPresetMenuOpen(false);
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '6px 12px',
                    fontSize: 12,
                    cursor: 'pointer',
                    background: p.id === activePresetId ? 'rgba(78, 167, 230, 0.15)' : 'transparent',
                    color: p.id === activePresetId ? '#A4D3FF' : '#E2EFFF'
                  }}
                  onMouseEnter={e => {
                    if (p.id !== activePresetId) e.currentTarget.style.background = '#1C2742';
                  }}
                  onMouseLeave={e => {
                    if (p.id !== activePresetId) e.currentTarget.style.background = 'transparent';
                  }}
                >
                  <span>{p.name}</span>
                  {p.id === activePresetId && <span style={{ fontSize: 11 }}>✓</span>}
                </div>
              ))}

              <div style={{ height: 1, background: '#243B54', margin: '4px 0' }} />

              <div
                onClick={() => {
                  setIsPresetMenuOpen(false);
                  handleAddPreset();
                }}
                style={{
                  padding: '6px 12px',
                  fontSize: 12,
                  cursor: 'pointer',
                  color: '#A4D3FF',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6
                }}
                onMouseEnter={e => (e.currentTarget.style.background = '#1C2742')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <span>＋</span>
                <span>プリセットを追加</span>
              </div>

              <div
                onClick={() => {
                  setIsPresetMenuOpen(false);
                  handleRenamePreset();
                }}
                style={{
                  padding: '6px 12px',
                  fontSize: 12,
                  cursor: 'pointer',
                  color: '#E2EFFF',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6
                }}
                onMouseEnter={e => (e.currentTarget.style.background = '#1C2742')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <span>✎</span>
                <span>プリセット名を変更</span>
              </div>

              {presets.length > 1 && (
                <div
                  onClick={() => {
                    setIsPresetMenuOpen(false);
                    handleDeletePreset();
                  }}
                  style={{
                    padding: '6px 12px',
                    fontSize: 12,
                    cursor: 'pointer',
                    color: '#ca697e',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 0
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#1C2742')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <span></span>
                  <span>⚠︎ 現在のプリセットを削除</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* タブ切り替え */}
        <div style={{ background: '#1e2844', borderRadius: 6, padding: 2, display: 'flex' }}>
          <button
            onClick={() => setSelectedTab('visualizer')}
            style={{ padding: '4px 10px', background: selectedTab === 'visualizer' ? '#5D7FAF' : 'transparent', color: selectedTab === 'visualizer' ? '#E2EFFF' : '#E2EFFF', border: 'none', borderRadius: 3, cursor: 'pointer', fontSize: 12, fontWeight: 'bold' }}
          >
            Visualizer
          </button>
          <button
            onClick={() => setSelectedTab('settings')}
            style={{ padding: '4px 10px', background: selectedTab === 'settings' ? '#5D7FAF' : 'transparent', color: selectedTab === 'settings' ? '#E2EFFF' : '#E2EFFF', border: 'none', borderRadius: 3, cursor: 'pointer', fontSize: 12, fontWeight: 'bold' }}
          >
            Track Settings
          </button>
          {/* ★ 追加: Calibration タブ */}
          <button
            type="button"
            onClick={() => setSelectedTab('calibration')}
            style={{
              padding: '4px 10px',
              background: selectedTab === 'calibration' ? '#5D7FAF' : 'transparent',
              color: '#E2EFFF',
              border: 'none',
              borderRadius: 3,
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 'bold'
            }}
          >
            Calibration
          </button>
        </div>

        {selectedTab === 'visualizer' ? (
          <button
            onClick={() => setIsControlBarOpen(prev => !prev)}
            title={isControlBarOpen ? 'コントロールバーを収納' : 'コントロールバーを展開'}
            style={{
              width: 32,
              height: 28,
              boxSizing: 'border-box',
              padding: 0,
              background: isControlBarOpen ? '#243B54' : '#1C2742',
              border: '1px solid #243B54',
              borderRadius: 6,
              color: isControlBarOpen ? '#A4D3FF' : '#8FA4C4',
              cursor: 'pointer',
              fontSize: 10,
              lineHeight: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0
            }}
          >
            {isControlBarOpen ? '▲' : '▼'}
          </button>
        ) : (
          <div ref={storageMenuRef} style={{ position: 'relative', width: 32, height: 28, flexShrink: 0 }}>
            <button
              onClick={handleOpenStorageInfo}
              title="ストレージ使用状況を確認"
              style={{
                width: 32,
                height: 28,
                boxSizing: 'border-box',
                padding: 0,
                background: isStorageMenuOpen ? '#243B54' : '#1C2742',
                border: '1px solid #243B54',
                borderRadius: 6,
                color: isStorageMenuOpen ? '#A4D3FF' : '#8FA4C4',
                cursor: 'pointer',
                fontSize: 10,
                lineHeight: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <ellipse cx="12" cy="5" rx="9" ry="3"></ellipse>
                <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path>
                <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path>
              </svg>
            </button>

            {isStorageMenuOpen && storageInfo && (
              <div
                style={{
                  position: 'absolute',
                  top: 'calc(100% + 6px)',
                  right: 0,
                  width: 230,
                  background: '#141D34',
                  border: '1px solid #e7cdad',
                  borderRadius: 6,
                  boxShadow: '0 6px 18px rgba(0,0,0,0.55)',
                  padding: '12px',
                  zIndex: 1000
                }}
              >
                <div style={{ fontSize: 11, fontWeight: 'bold', color: '#A4D3FF', marginBottom: 8 }}>
                  ローカルストレージ (IndexedDB)
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                  <span style={{ color: '#8FA4C4' }}>使用量:</span>
                  <span style={{ fontWeight: 'bold', color: '#E2EFFF' }}>{formatBytes(storageInfo.usage)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 8 }}>
                  <span style={{ color: '#8FA4C4' }}>割当上限:</span>
                  <span style={{ color: '#E2EFFF' }}>{formatBytes(storageInfo.quota)}</span>
                </div>

                <div style={{ width: '100%', height: 6, background: '#1C2742', borderRadius: 3, overflow: 'hidden', marginBottom: 6 }}>
                  <div
                    style={{
                      height: '100%',
                      width: `${Math.min(100, Math.max(1, (storageInfo.usage / (storageInfo.quota || 1)) * 100))}%`,
                      background: '#A4D3FF',
                      borderRadius: 3
                    }}
                  />
                </div>

                <div style={{ fontSize: 10, color: '#8FA4C4', textAlign: 'right' }}>
                  使用率: {((storageInfo.usage / (storageInfo.quota || 1)) * 100).toFixed(2)}%
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 2. メイン 2ペイン */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* 左ペイン */}
        {isSidebarOpen && (
          <div
            style={{
              width: 280,
              borderRight: '3px solid #72829F',
              display: 'flex',
              flexDirection: 'column',
              background: '#1D202C',
              position: 'relative' // ← absolute配置の基準にするため追加
            }}
          >
            {/* ★★★ 左側（左ペイン右上隅）の滑らかなアール ★★★ */}
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              style={{
                position: 'absolute',
                top: 0,
                right: 0,
                zIndex: 50,
                pointerEvents: 'none'
              }}
            >
              <path d="M 12 0 L 12 12 Q 12 0 0 0 Z" fill="#72829F" />
            </svg>

            {/* 楽曲リスト (残り高さいっぱいに広がり、最小100pxを確保) */}

            <div style={{ flex: 1, minHeight: 100, padding: 12, overflowY: 'auto' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 'bold', color: '#c1cfe3' }}>楽曲リスト ({songs.length})</span>
                <label style={{ fontSize: 11, background: '#5D7FAF', color: '#E2EFFF', padding: '2px 8px', borderRadius: 6, cursor: 'pointer', fontWeight: 'bold' }}>
                  + 追加
                  <input type="file" multiple accept=".mid,.midi" onChange={handleMidiUpload} style={{ display: 'none' }} />
                </label>
              </div>
              {songs.map((song, index) => {
                const isSelected = song.id === selectedSongId;
                const isDragging = draggedSongIndex === index;
                const isDragOver = dragOverSongIndex === index;

                return (
                  <div
                    key={song.id}
                    draggable
                    onDragStart={e => {
                      setDraggedSongIndex(index);
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragOver={e => {
                      e.preventDefault(); // ドロップを許可するために必須
                      if (dragOverSongIndex !== index) {
                        setDragOverSongIndex(index);
                      }
                    }}
                    onDragLeave={() => {
                      if (dragOverSongIndex === index) {
                        setDragOverSongIndex(null);
                      }
                    }}
                    onDrop={e => {
                      e.preventDefault();
                      handleDropSong(index);
                    }}
                    onDragEnd={() => {
                      setDraggedSongIndex(null);
                      setDragOverSongIndex(null);
                    }}
                    onClick={() => handleSelectSong(song)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      padding: '8px',
                      marginBottom: 4,
                      borderRadius: 6,
                      cursor: isDragging ? 'grabbing' : 'grab',
                      background: isSelected ? 'rgba(78, 167, 230, 0.12)' : '#181822',
                      border: isSelected ? '1px solid #8abfdb' : '1px solid transparent',
                      // ドラッグ中の要素は半透明化
                      opacity: isDragging ? 0.35 : 1.0,
                      // ★ borderTop をやめ、boxShadow で上部に青いインジケーター線を描画
                      boxShadow: isDragOver ? '0 -3px 0 0 #cbd9eb' : 'none',
                      transition: 'opacity 0.15s',
                      userSelect: 'none'
                    }}
                  >
                    <div style={{ flex: 1, overflow: 'hidden' }}>
                      <div
                        style={{
                          fontSize: 13,
                          fontWeight: isSelected ? 'bold' : 'normal',
                          whiteSpace: 'nowrap',
                          textOverflow: 'ellipsis',
                          overflow: 'hidden'
                        }}
                      >
                        {song.fileName.replace(/\.midi?$/i, '')}
                      </div>
                      <div style={{ fontSize: 11, color: '#8FA4C4', marginTop: 2 }}>
                        {formatTime(song.durationMs)} {song.bgmFileName && '• BGM付'}
                      </div>
                    </div>

                    <button
                      onClick={e => {
                        e.stopPropagation();
                        handleDeleteSong(song);
                      }}
                      title="楽曲を削除"
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: '#666',
                        cursor: 'pointer',
                        padding: 4,
                        fontSize: 12
                      }}
                      onMouseEnter={e => (e.currentTarget.style.color = '#FF4444')}
                      onMouseLeave={e => (e.currentTarget.style.color = '#666')}
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>

            {/* 上下ドラッグリサイズ用スプリッター境界線 */}
            <div
              onMouseDown={handleStartResize}
              title="上下にドラッグしてサイズを調整"
              style={{
                height: 4,
                cursor: 'row-resize',
                background: isResizingSidebar ? '#72829F' : '#72829F',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                userSelect: 'none',
                transition: 'background 0.15s',
                zIndex: 10,
                position: 'relative' // ★ 相対配置の基準にするため追加
              }}
              onMouseEnter={e => {
                if (!isResizingSidebar) e.currentTarget.style.background = '#72829F';
              }}
              onMouseLeave={e => {
                if (!isResizingSidebar) e.currentTarget.style.background = '#72829F';
              }}
            >
              {/* 控えめな1本バー */}
              <div
                style={{
                  width: 30,
                  height: 2,
                  background: isResizingSidebar ? '#e1f1ff' : '#29364d',
                  borderRadius: 2
                }}
              />

              {/* ★★★ 1. 上側の滑らかなアール (12px) ★★★ */}
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                style={{
                  position: 'absolute',
                  top: -12,
                  right: 0,
                  pointerEvents: 'none'
                }}
              >
                <path d="M 12 12 L 12 0 Q 12 12 0 12 Z" fill="#72829F" />
              </svg>

              {/* ★★★ 2. 下側の滑らかなアール (12px) ★★★ */}
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                style={{
                  position: 'absolute',
                  bottom: -12,
                  right: 0,
                  pointerEvents: 'none'
                }}
              >
                <path d="M 12 0 L 12 12 Q 12 0 0 0 Z" fill="#72829F" />
              </svg>
            </div>

            {/* MIDIデバイス一覧 */}
            <div style={{ height: devicePanelHeight, padding: 12, overflowY: 'auto', background: '#1D202C' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 'bold', color: '#c1cfe3' }}>デバイス一覧 ({endpoints.length})</span>
                <div style={{ display: 'flex', gap: 5 }}>
                  <button
                    onClick={() => setIsManageModalOpen(true)}
                    title="MIDIデバイスの登録・整理"
                    style={{ fontSize: 11, background: '#243B54', border: 'none', color: '#A4D3FF', padding: '3px 6px', borderRadius: 6, cursor: 'pointer', fontWeight: 'bold' }}
                  >
                    管理
                  </button>
                  <button
                    onClick={() => MidiDeviceManager.getInstance().probeSerialDeviceManually()}
                    title="USB接続されたマイコンから楽器名を直接取得して自動照合します"
                    style={{ fontSize: 11, background: '#175883', border: 'none', color: '#E2EFFF', padding: '3px 6px', borderRadius: 6, cursor: 'pointer', fontWeight: 'bold' }}
                  >
                    + USB
                  </button>
                  <button
                    onClick={() => MidiDeviceManager.getInstance().connectBleDevice()}
                    style={{ fontSize: 11, background: '#4058C2', border: 'none', color: '#E2EFFF', padding: '3px 6px', borderRadius: 6, cursor: 'pointer', fontWeight: 'bold' }}
                  >
                    + BLE
                  </button>
                </div>
              </div>

              {endpoints.length === 0 && (
                <div style={{ fontSize: 11, color: '#8FA4C4', padding: '4px 0' }}>接続中のデバイスはありません</div>
              )}

              {endpoints.map(ep => (
                <div
                  key={ep.id}
                  onClick={() => setSelectedEndpointId(ep.id)}
                  style={{
                    fontSize: 12,
                    padding: '8px',
                    marginBottom: 6,
                    borderRadius: 6,
                    cursor: 'pointer',
                    background: ep.id === selectedEndpointId ? 'rgba(78, 167, 230, 0.12)' : '#181822',
                    border: ep.id === selectedEndpointId ? '1px solid #DBB28A' : '0px solid #243B54'
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <span style={{ fontWeight: 'bold' }}>{ep.name}</span>
                    <span style={{ fontSize: 9, background: '#243B54', padding: '1px 5px', borderRadius: 3, color: '#A4D3FF' }}>
                      {ep.transport.toUpperCase()}
                    </span>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                    <span style={{ fontSize: 10, color: '#8FA4C4' }}>楽器:</span>
                    <select
                      value={ep.identifiedPreset?.id ?? 0}
                      onClick={e => e.stopPropagation()}
                      onChange={e => {
                        e.stopPropagation();
                        MidiDeviceManager.getInstance().setEndpointPreset(ep.id, Number(e.target.value));
                      }}
                      style={{
                        flex: 1,
                        background: '#243B54',
                        color: ep.identifiedPreset && ep.identifiedPreset.id !== 0 ? '#A4D3FF' : '#8FA4C4',
                        border: '1px solid #818cbd',
                        borderRadius: 3,
                        fontSize: 11,
                        padding: '2px 4px'
                      }}
                    >
                      {knownPresets.map(p => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              ))}

              {currentEndpoint && (
                <div style={{ marginTop: 10, padding: 8, background: '#1A1A24', borderRadius: 4 }}>
                  <div style={{ fontSize: 11, color: '#8FA4C4', marginBottom: 6 }}>
                    単音テスト [{currentEndpoint.name} → {currentEndpoint.identifiedPreset?.name ?? '未割当'}]
                  </div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input
                      type="number"
                      min={0}
                      max={127}
                      value={testPitch}
                      onChange={e => setTestPitch(Number(e.target.value))}
                      style={{ width: 45, background: '#243B54', color: '#E2EFFF', border: '1px solid #243B54', borderRadius: 3, fontSize: 11, padding: 2 }}
                    />
                    <button
                      onClick={() => MidiDeviceManager.getInstance().testSingleNote(currentEndpoint, 0, testPitch)}
                      style={{ fontSize: 11, background: '#5D7FAF', border: 'none', padding: '1px 8px', borderRadius: 3, cursor: 'pointer', fontWeight: 'bold', color: '#E2EFFF' }}
                    >
                      送信
                    </button>
                    <button
                      onClick={() => MidiDeviceManager.getInstance().sendAllNotesOff(currentEndpoint, 0)}
                      style={{ fontSize: 11, background: '#7a4699', color: '#E2EFFF', border: 'none', padding: '3px 6px', borderRadius: 3, cursor: 'pointer' }}
                    >
                      OFF
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* 右ペイン */}
        <div style={{ flex: 1, position: 'relative', display: 'flex', flexDirection: 'column' }}>
          
          {/* ★★★ ここに追加: 左ペインとトランスポートバーの直角を埋める滑らかなアール ★★★ */}
          {isSidebarOpen && (
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                zIndex: 50,
                pointerEvents: 'none'
              }}
            >
              <path d="M 0 0 L 0 12 Q 0 0 12 0 Z" fill="#72829F" />
            </svg>
          )}

          {/* ① Visualizer 画面 */}
          {selectedTab === 'visualizer' && (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' }}>
              {isControlBarOpen && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '6px 16px',
                    background: isChromaKey ? '#00CC00' : '#121217',
                    borderBottom: '1px solid #243B54',
                    fontSize: 12,
                    flexShrink: 0
                  }}
                >
                  <label style={{ color: isChromaKey ? '#101F33' : '#E2EFFF' }}>
                    速度:
                    <input
                      type="range"
                      min={0.05}
                      max={1.5}
                      step={0.01}
                      value={scrollSpeed}
                      onChange={e => setScrollSpeed(Number(e.target.value))}
                      style={{ marginLeft: 6, width: 80, verticalAlign: 'middle' }}
                    />
                    <span style={{ marginLeft: 4 }}>{scrollSpeed.toFixed(2)}</span>
                  </label>
                  <label style={{ color: isChromaKey ? '#331010' : '#E2EFFF', cursor: 'pointer' }}>
                    <input type="checkbox" checked={showGrid} onChange={e => setShowGrid(e.target.checked)} /> 拍グリッド
                  </label>
                  <label style={{ color: isChromaKey ? '#101F33' : '#E2EFFF', cursor: 'pointer' }}>
                    <input type="checkbox" checked={showAllCh} onChange={e => setShowAllCh(e.target.checked)} /> 全Ch表示
                  </label>
                  <label style={{ color: isChromaKey ? '#101F33' : '#E2EFFF', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={isChromaKey}
                     onChange={e => setIsChromaKey(e.target.checked)}
                    /> クロマキー
                  </label>
                  <label style={{ color: isChromaKey ? '#101F33' : '#E2EFFF', cursor: 'pointer' }}>
                    <input type="checkbox" checked={showDebug} onChange={e => setShowDebug(e.target.checked)} /> デバッグ
                  </label>
                </div>
              )}

              <div style={{ flex: 1, position: 'relative', minHeight: 0, overflow: 'hidden' }}>
                <CanvasVisualizer
                  song={currentSong}
                  scrollSpeedPxPerMs={scrollSpeed}
                  isChromaKeyEnabled={isChromaKey}
                  showGridLines={showGrid}
                  showAllChannels={showAllCh}
                  showDebugHUD={showDebug}
                />
              </div>
            </div>
          )}

          {/* ② Track Settings 画面 */}
          {selectedTab === 'settings' && (
            <div style={{ padding: '24px 32px', overflowY: 'auto', height: '100%', boxSizing: 'border-box' }}>
              {currentSong ? (
                <div style={{ maxWidth: 880, margin: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
                  
                  {/* 1. 上部BGM連携バー */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingBottom: 2 }}>
                    <label style={{ fontSize: 12, background: '#175883', color: '#E2EFFF', padding: '6px 12px', borderRadius: 6, cursor: 'pointer', fontWeight: 'bold' }}>
                      BGM音声を紐付け (.mp3, .wav, .ogg)
                      <input type="file" accept="audio/*" onChange={handleBgmUpload} style={{ display: 'none' }} />
                    </label>
                    {currentSong.bgmFileName && <span style={{ fontSize: 12, color: '#88D5DA' }}>{currentSong.bgmFileName}</span>}
                  </div>

                  {/* 2. トラックカード一覧 */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {(() => {
                      const tracks = currentSong.tracks && currentSong.tracks.length > 0
                        ? currentSong.tracks.filter(t => t.notes.length > 0)
                        : [];

                      return tracks.map((track, idx) => {
                        let slot = currentSong.slots.find(s => s.trackIndex === track.trackIndex);
                        if (!slot) {
                          slot = {
                            id: `auto_${track.trackIndex}`,
                            isEnabled: true,
                            trackIndex: track.trackIndex,
                            selectedChannel: track.notes[0]?.channel ?? 0,
                            outputChannel: track.notes[0]?.channel ?? 0,
                            assignedPreset: NONE_PRESET,
                            latencyOffsetMs: 0.0,
                            customColor: DEFAULT_CHANNEL_COLORS[idx % 16]
                          };
                        }

                        const currentColor = slot.customColor || DEFAULT_CHANNEL_COLORS[idx % 16];
                        const isColorPickerOpen = activeColorPickerSlotId === slot.id;

                        return (
                          <div
                            key={slot.id}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 12,
                              padding: '10px 14px',
                              background: slot.isEnabled ? '#181b2d' : '#141622',
                              border: '1px solid #30354E',
                              borderRadius: 6,
                              position: 'relative',
                              zIndex: isColorPickerOpen ? 60 : 1,
                              transition: 'background 0.15s'
                            }}
                          >
                            {/* 有効 / 無効 チェックボックス */}
                            <input
                              type="checkbox"
                              checked={slot.isEnabled}
                              onChange={e => handleUpdateSlot(slot.id, { isEnabled: e.target.checked }, track)}
                              style={{ width: 16, height: 16, cursor: 'pointer' }}
                            />

                            {/* トラック名 & ノート数バッジ */}
                            <div style={{ minWidth: 170, maxWidth: 220, overflow: 'hidden' }}>
                              <div
                                title={track.name}
                                style={{
                                  fontSize: 13,
                                  fontWeight: 'bold',
                                  color: slot.isEnabled ? '#E2EFFF' : '#6A789A',
                                  whiteSpace: 'nowrap',
                                  textOverflow: 'ellipsis',
                                  overflow: 'hidden'
                                }}
                              >
                                {track.name}
                              </div>
                              <div style={{ fontSize: 10, color: '#8FA4C4', marginTop: 2 }}>
                                {track.notes.length} notes • 元Ch: {(track.notes[0]?.channel ?? 0) + 1}
                              </div>
                            </div>

                            <span style={{ color: '#6A789A', fontSize: 12 }}>➔</span>

                            {/* 送信先ポート（デバイス） */}
                            <div style={{ flex: 1, minWidth: 140 }}>
                              <select
                                value={
                                  slot.assignedPreset?.endpointId ??
                                  (slot.assignedPreset?.instanceIndex
                                    ? `${slot.assignedPreset.mcuName}#${slot.assignedPreset.instanceIndex}`
                                    : slot.assignedPreset?.mcuName ?? 'None')
                                }
                                onChange={e => {
                                  const val = e.target.value;
                                  const target = availableTargets.find(
                                    t => (t.endpointId ? t.endpointId === val : t.mcuName === val)
                                  ) ?? NONE_PRESET;
                                  handleUpdateSlot(slot.id, {
                                    assignedPreset: target,
                                    latencyOffsetMs: target.defaultOffsetMs ?? slot.latencyOffsetMs
                                  }, track);
                                }}
                                style={{
                                  width: '100%',
                                  background: '#3D4764',
                                  color: slot.assignedPreset?.id !== 0 ? '#bab0ff' : '#E2EFFF',
                                  border: '1px solid #4e598c',
                                  borderRadius: 6,
                                  padding: '5px 8px',
                                  fontSize: 12
                                }}
                              >
                                {availableTargets.map(p => {
                                  const optValue = p.endpointId ?? p.mcuName;
                                  const statusLabel = p.id !== 0 ? (p.isOnline ? ' [接続中]' : ' [未接続]') : '';
                                  return (
                                    <option key={optValue} value={optValue}>
                                      {p.name}{statusLabel}
                                    </option>
                                  );
                                })}
                              </select>
                            </div>

                            {/* 送信チャンネル (Ch 1〜16) */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                              <span style={{ fontSize: 11, color: '#8FA4C4' }}>送信Ch:</span>
                              <select
                                value={slot.outputChannel ?? (track.notes[0]?.channel ?? 0)}
                                onChange={e => handleUpdateSlot(slot.id, { outputChannel: Number(e.target.value) }, track)}
                                style={{
                                  background: '#3D4764',
                                  color: '#E2EFFF',
                                  border: '1px solid #4e598c',
                                  borderRadius: 6,
                                  padding: '5px 6px',
                                  fontSize: 12
                                }}
                              >
                                {Array.from({ length: 16 }, (_, i) => (
                                  <option key={i} value={i}>
                                    Ch {i + 1}
                                  </option>
                                ))}
                              </select>
                            </div>

                            {/* ノーツ色 円形カラーピッカー */}
                            <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                              <button
                                type="button"
                                onClick={() => setActiveColorPickerSlotId(isColorPickerOpen ? null : slot.id)}
                                title="ノーツの色を変更"
                                style={{
                                  width: 24,
                                  height: 24,
                                  borderRadius: 6,
                                  background: currentColor,
                                  border: '2px solid #575B77',
                                  boxShadow: '0 1px 4px rgba(0,0,0,0.4)',
                                  cursor: 'pointer',
                                  padding: 0,
                                  outline: 'none'
                                }}
                              />
                              {isColorPickerOpen && (
                                <CircularColorPicker
                                  color={currentColor}
                                  onChange={newColor => handleUpdateSlot(slot.id, { customColor: newColor }, track)}
                                  onClose={() => setActiveColorPickerSlotId(null)}
                                />
                              )}
                            </div>

                            {/* 遅延補正スライダー */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                              <input
                                type="range"
                                min={-200}
                                max={200}
                                step={1}
                                value={slot.latencyOffsetMs}
                                onChange={e => handleUpdateSlot(slot.id, { latencyOffsetMs: Number(e.target.value) }, track)}
                                style={{ width: 75 }}
                              />
                              <span style={{ fontSize: 11, minWidth: 42, textAlign: 'right', fontFamily: 'monospace', color: '#8FA4C4' }}>
                                {slot.latencyOffsetMs}ms
                              </span>
                            </div>
                          </div>
                        );
                      });
                    })()}
                  </div>
                </div>
              ) : (
                <div style={{ color: '#8FA4C4', textAlign: 'center', marginTop: 40 }}>
                  左側の楽曲リストから楽曲を選択してください。
                </div>
              )}
            </div>
          )}

          {/* ★★★ ③ 追加: Calibration 画面 ★★★ */}
          {selectedTab === 'calibration' && (
            <div style={{ flex: 1, height: '100%', minHeight: 0, overflow: 'hidden' }}>
              <CalibrationView />
            </div>
          )}
        </div>
      </div>

      {/* 3. 楽器プリセット管理モーダル (セーフティ機能付き) */}
      {isManageModalOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.65)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 2000
          }}
          onClick={() => setIsManageModalOpen(false)}
        >
          <div
            style={{
              width: 520,
              background: '#141D34',
              border: '1.5px solid #DBB28A',
              borderRadius: 8,
              boxShadow: '0 8px 30px rgba(0,0,0,0.7)',
              padding: 20,
              display: 'flex',
              flexDirection: 'column',
              gap: 16
            }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0, color: '#DFEEFE' }}>デバイス管理</h3>
              <button
                onClick={() => setIsManageModalOpen(false)}
                style={{ background: 'transparent', border: 'none', color: '#8FA4C4', fontSize: 16, cursor: 'pointer' }}
              >
                ✕
              </button>
            </div>

            {/* 登録済み一覧 */}
            <div style={{ maxHeight: 250, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {knownPresets.filter(p => p.id !== 0 && p.mcuName !== 'None').length === 0 && (
                <div style={{ color: '#8FA4C4', fontSize: 12, padding: '12px 0', textAlign: 'center' }}>
                  登録されている楽器はありません。
                </div>
              )}

              {knownPresets.filter(p => p.id !== 0 && p.mcuName !== 'None').map(preset => {
                const isOnline = endpoints.some(
                  ep => ep.identifiedPreset && ep.identifiedPreset.mcuName.toLowerCase() === preset.mcuName.toLowerCase()
                );
                const usedCount = songs.reduce(
                  (acc, s) => acc + s.slots.filter(sl => sl.assignedPreset?.mcuName.toLowerCase() === preset.mcuName.toLowerCase()).length,
                  0
                );

                return (
                  <div
                    key={preset.mcuName}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '8px 12px',
                      background: '#1C2742',
                      border: '1px solid #243B54',
                      borderRadius: 4
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 'bold', fontSize: 13 }}>
                        {isOnline ? '🟢' : '⚪'} {preset.name}
                        
                      </div>
                      <div style={{ fontSize: 11, color: '#8FA4C4', marginTop: 2 }}>
                        {isOnline ? '実機接続中' : '未接続'} / {usedCount > 0 ? `${usedCount}箇所のスロットで使用中` : '未使用'}
                      </div>
                    </div>

                    <button
                      onClick={() => handleDeletePresetSafely(preset)}
                      disabled={isOnline}
                      title={isOnline ? '物理接続中のため削除できません' : 'プリセットを削除'}
                      style={{
                        padding: '4px 8px',
                        background: isOnline ? '#2C3446' : '#BD425C',
                        color: isOnline ? '#6A768F' : '#ffffff',
                        border: 'none',
                        borderRadius: 6,
                        fontSize: 11,
                        cursor: isOnline ? 'not-allowed' : 'pointer',
                        fontWeight: 'bold'
                      }}
                    >
                      {isOnline ? '接続中' : '削除 '}
                    </button>
                  </div>
                );
              })}
            </div>

            {/* 実機なし手動追加フォーム */}
            <div style={{ borderTop: '1px solid #243B54', paddingTop: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 'bold', color: '#8FA4C4', marginBottom: 6 }}>
                楽器名を事前登録
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type="text"
                  placeholder="ここに入力"
                  value={newMcuInput}
                  onChange={e => setNewMcuInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleRegisterManualMcu()}
                  style={{
                    flex: 1,
                    background: '#1C2742',
                    border: '1px solid #243B54',
                    borderRadius: 6,
                    color: '#E2EFFF',
                    padding: '6px 10px',
                    fontSize: 12
                  }}
                />
                <button
                  onClick={handleRegisterManualMcu}
                  style={{
                    background: '#5D7FAF',
                    border: 'none',
                    borderRadius: 6,
                    color: '#ffffff',
                    padding: '4px 12px',
                    fontSize: 12,
                    fontWeight: 'bold',
                    cursor: 'pointer'
                  }}
                >
                  + 追加
                </button>
              </div>
            </div>

            
          </div>
        </div>
      )}
    </div>
  );
}

export default App;