import { MidiSongData, BeatEvent, LaneSlot, MidiNote } from '../../models/SongModels';
import { MidiDeviceManager } from '../midi/MidiDeviceManager';
import { UnifiedMidiEndpoint } from '../midi/types';

interface ScheduledNote {
  pitch: number;
  velocity: number;
  channel: number;
  endpointId?: string;
  adjustedOnTimeMs: number;
  adjustedOffTimeMs: number;
}

interface ActiveNote {
  channel: number;
  endpointId: string;
  pitch: number;
  offTimeMs: number;
}

export class PlaybackEngine {
  private static instance: PlaybackEngine;

  private audioCtx: AudioContext | null = null;
  private bgmBuffer: AudioBuffer | null = null;
  private bgmSource: AudioBufferSourceNode | null = null;
  private bgmGain: GainNode | null = null;

  private strongClickBuffer: AudioBuffer | null = null;
  private weakClickBuffer: AudioBuffer | null = null;

  // 再生タイムベース
  private isPlayingState = false;
  private playbackStartAudioTime = 0;
  private startOffsetPositionMs = 0;
  private pausedPositionMs = 0;
  public totalDurationMs = 0;

  public isMetronomeEnabled = true;

  // BGM 有効/無効フラグ
  private _isBgmEnabled = true;

  public get isBgmEnabled(): boolean {
    return this._isBgmEnabled;
  }

  public set isBgmEnabled(enabled: boolean) {
    this._isBgmEnabled = enabled;
    if (this.bgmGain && this.audioCtx) {
      this.bgmGain.gain.setValueAtTime(
        enabled ? 1 : 0,
        this.audioCtx.currentTime
      );
    }
  }

  // MIDIスケジューリング
  private activeSong: MidiSongData | null = null;
  private scheduledNotes: ScheduledNote[] = [];
  private nextNoteIdx = 0;
  private activeNotes: ActiveNote[] = [];
  private beatList: BeatEvent[] = [];
  private nextBeatIdx = 0;

  private timerWorkerId: number | null = null;
  private listeners: Set<(isPlaying: boolean, currentMs: number) => void> = new Set();

  // ★ カウントイン（オフセット/プリロール）設定
  public isCountInEnabled = false;
  public countInBars = 1;
  private prerollTargetMs = 0; // 本編アンミュート開始目標位置
  private isPrerollBgmStarted = false;

  // 現在プリロール中かどうか & 目標の再生開始位置 (ms) を公開
  public getPrerollInfo(): { isPrerolling: boolean; targetMs: number } {
    const curMs = this.getCurrentPlaybackMs();
    const isPrerolling = this.isPlayingState && this.isCountInEnabled && curMs < this.prerollTargetMs;
    return {
      isPrerolling,
      targetMs: this.prerollTargetMs
    };
  }

  private constructor() {}

  public static getInstance(): PlaybackEngine {
    if (!PlaybackEngine.instance) {
      PlaybackEngine.instance = new PlaybackEngine();
    }
    return PlaybackEngine.instance;
  }

  private initAudio(): AudioContext {
    if (!this.audioCtx) {
      const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.audioCtx = new AudioContextClass({ latencyHint: 'interactive' });

      this.bgmGain = this.audioCtx.createGain();
      this.bgmGain.gain.value = this._isBgmEnabled ? 1 : 0;
      this.bgmGain.connect(this.audioCtx.destination);

      this.createClickBuffers(this.audioCtx);
    }
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
    return this.audioCtx;
  }

  private createClickBuffers(ctx: AudioContext): void {
    const sampleRate = ctx.sampleRate;
    const length = Math.floor(sampleRate * 0.015);

    // 強拍: 1000Hz (amp: 0.7)
    const strong = ctx.createBuffer(1, length, sampleRate);
    const sData = strong.getChannelData(0);
    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      const env = 1.0 - i / length;
      sData[i] = Math.sin(2.0 * Math.PI * 1000.0 * t) * env * 0.7;
    }
    this.strongClickBuffer = strong;

    // 弱拍: 800Hz (amp: 0.35)
    const weak = ctx.createBuffer(1, length, sampleRate);
    const wData = weak.getChannelData(0);
    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      const env = 1.0 - i / length;
      wData[i] = Math.sin(2.0 * Math.PI * 800.0 * t) * env * 0.35;
    }
    this.weakClickBuffer = weak;
  }

  public async setBgmAudio(arrayBuffer: ArrayBuffer): Promise<void> {
    const ctx = this.initAudio();
    this.bgmBuffer = await ctx.decodeAudioData(arrayBuffer);
  }

  public clearBgmAudio(): void {
    this.bgmBuffer = null;
    this.stopBgm();
  }

  public prepareSong(song: MidiSongData | null): void {
    this.stop();
    this.activeSong = song;
    this.totalDurationMs = song?.durationMs ?? 0;
    this.pausedPositionMs = 0;
    this.startOffsetPositionMs = 0;
  }

  public getCurrentPlaybackMs(): number {
    if (!this.isPlayingState || !this.audioCtx) {
      return this.pausedPositionMs;
    }
    const elapsedSec = this.audioCtx.currentTime - this.playbackStartAudioTime;
    return this.startOffsetPositionMs + elapsedSec * 1000.0;
  }

  public setCountInConfig(enabled: boolean, bars: number): void {
    this.isCountInEnabled = enabled;
    this.countInBars = bars;
  }

  private getFirstNoteTimeMs(): number {
    if (!this.activeSong) return Infinity;
    let firstMs = Infinity;
    for (const cache of Object.values(this.activeSong.channelCaches)) {
      if (cache && cache.notes.length > 0) {
        if (cache.notes[0].startTimeMs < firstMs) {
          firstMs = cache.notes[0].startTimeMs;
        }
      }
    }
    return firstMs;
  }

  public getMainTempoBpm(): number {
    if (!this.activeSong || this.activeSong.beatEvents.length === 0) return 120;

    const firstNoteMs = this.getFirstNoteTimeMs();
    const beats = this.activeSong.beatEvents;

    const targetIdx = firstNoteMs === Infinity
      ? 0
      : beats.findIndex(b => b.timeMs >= firstNoteMs - 20);

    const validIdx = targetIdx >= 0 ? targetIdx : 0;

    if (validIdx < beats.length - 1) {
      const delta = beats[validIdx + 1].timeMs - beats[validIdx].timeMs;
      if (delta > 0) return Math.round(60000 / delta);
    } else if (validIdx > 0) {
      const delta = beats[validIdx].timeMs - beats[validIdx - 1].timeMs;
      if (delta > 0) return Math.round(60000 / delta);
    }

    return 120;
  }

  public togglePlayPause(): void {
    if (this.isPlayingState) {
      this.pause();
    } else {
      this.play();
    }
  }

  public play(): void {
    if (this.isPlayingState || !this.activeSong) return;
    const ctx = this.initAudio();

    if (this.pausedPositionMs >= this.totalDurationMs) {
      this.pausedPositionMs = 0;
    }

    const targetMs = this.pausedPositionMs;
    this.prerollTargetMs = targetMs;
    this.isPrerollBgmStarted = false;

    // 案A: オフセットが有効な場合、指定小節数分だけ手前から再生スタート
    if (this.isCountInEnabled) {
      const bpm = this.getMainTempoBpm();
      const beatMs = 60000 / bpm;
      const barMs = beatMs * 4; // 4/4拍子
      const prerollMs = this.countInBars * barMs;

      this.startOffsetPositionMs = targetMs - prerollMs;
    } else {
      this.startOffsetPositionMs = targetMs;
    }

    this.playbackStartAudioTime = ctx.currentTime;
    this.isPlayingState = true;

    // MIDIノートは targetMs 以降のみをスケジュール（プリロール中は発音しない）
    this.rebuildSchedule(targetMs);

    // ビート（メトロノーム）は preroll 開始位置から設定
    this.setupBeatSchedule(this.startOffsetPositionMs);

    // プリロールが不要（または0ms手前でない）ならBGM即時再生
    if (!this.isCountInEnabled) {
      this.playBgm(targetMs);
      this.isPrerollBgmStarted = true;
    }

    this.timerWorkerId = window.setInterval(() => {
      this.processTick();
    }, 3);

    this.notifyState();
  }

  public pause(): void {
    if (!this.isPlayingState) return;
    const curMs = this.getCurrentPlaybackMs();
    this.pausedPositionMs = Math.max(0, curMs);
    this.isPlayingState = false;

    if (this.timerWorkerId !== null) {
      clearInterval(this.timerWorkerId);
      this.timerWorkerId = null;
    }
    this.stopBgm();
    this.sendAllActiveNotesOff();
    this.notifyState();
  }

  public stop(): void {
    this.pause();
    this.pausedPositionMs = 0;
    this.startOffsetPositionMs = 0;
    this.notifyState();
  }

  public seek(toMs: number): void {
    const clamped = Math.max(0, Math.min(toMs, this.totalDurationMs));
    const wasPlaying = this.isPlayingState;
    if (wasPlaying) this.pause();
    this.pausedPositionMs = clamped;
    this.startOffsetPositionMs = clamped;
    if (wasPlaying) this.play();
    this.notifyState();
  }

  public updateSlotConfiguration(song: MidiSongData): void {
    this.activeSong = song;
    if (this.isPlayingState) {
      const curMs = this.getCurrentPlaybackMs();
      this.rebuildSchedule(Math.max(this.prerollTargetMs, curMs));
    }
  }

  private setupBeatSchedule(fromMs: number): void {
    if (!this.activeSong) return;
    const baseBeats = [...this.activeSong.beatEvents];

    // 0ms手前の負の時間がある場合、本編BPMで負の拍を合成
    if (fromMs < 0) {
      const bpm = this.getMainTempoBpm();
      const beatMs = 60000 / bpm;
      const syntheticBeats: BeatEvent[] = [];

      let currentT = 0;
      let count = 0;
      while (currentT > fromMs - beatMs) {
        currentT -= beatMs;
        count++;
        syntheticBeats.unshift({
          timeMs: Math.round(currentT),
          isAccent: count % 4 === 0,
          // ★ 不足していたプロパティを追加（0ms手前の負の小節・拍を計算）
          barIndex: -Math.ceil(count / 4),
          beatIndex: (4 - (count % 4)) % 4
        });
      }
      this.beatList = [...syntheticBeats, ...baseBeats];
    } else {
      this.beatList = baseBeats;
    }

    this.nextBeatIdx = this.beatList.findIndex(b => b.timeMs >= fromMs);
    if (this.nextBeatIdx === -1) this.nextBeatIdx = this.beatList.length;
  }

  private rebuildSchedule(fromMs: number): void {
    if (!this.activeSong) return;
    const midiMgr = MidiDeviceManager.getInstance();
    const endpoints = midiMgr.getEndpoints();
    const items: ScheduledNote[] = [];

    for (const slot of this.activeSong.slots) {
      if (!slot.isEnabled || !slot.assignedPreset || slot.assignedPreset.id === 0 || slot.assignedPreset.mcuName === 'None') continue;

      // ★ スロットに紐づくノート一覧を取得（元Chのフィルタリングに対応）
      let notesToSchedule: MidiNote[] = [];
      if (typeof slot.trackIndex === 'number' && this.activeSong.tracks) {
        const targetTrack = this.activeSong.tracks.find(t => t.trackIndex === slot.trackIndex);
        if (targetTrack) {
          notesToSchedule = (typeof slot.selectedChannel === 'number' && slot.selectedChannel >= 0)
            ? targetTrack.notes.filter(n => n.channel === slot.selectedChannel)
            : targetTrack.notes;
        }
      }
      
      // トラックが見つからない、または旧データの場合は従来の channelCaches から取得（完全な後方互換）
      if (notesToSchedule.length === 0) {
        const cache = this.activeSong.channelCaches[slot.selectedChannel];
        if (cache && cache.noteCount > 0) {
          notesToSchedule = cache.notes;
        }
      }

      if (notesToSchedule.length === 0) continue;

      const candidates = endpoints.filter(
        ep =>
          ep.identifiedPreset &&
          ep.identifiedPreset.id !== 0 &&
          ep.identifiedPreset.mcuName.toLowerCase() === slot.assignedPreset.mcuName.toLowerCase()
      );

      let matchedEp: UnifiedMidiEndpoint | undefined;
      if (slot.assignedPreset.endpointId) {
        matchedEp = candidates.find(ep => ep.id === slot.assignedPreset.endpointId);
      }
      if (!matchedEp && slot.assignedPreset.instanceIndex && slot.assignedPreset.instanceIndex <= candidates.length) {
        matchedEp = candidates[slot.assignedPreset.instanceIndex - 1];
      }
      if (!matchedEp) {
        matchedEp = candidates[0];
      }

      const offset = slot.latencyOffsetMs;
      // 送信チャンネル (outputChannel が未設定なら selectedChannel)
      const sendChannel = slot.outputChannel ?? slot.selectedChannel;

      for (const note of notesToSchedule) {
        const onMs = note.startTimeMs + offset;
        const offMs = note.endTimeMs + offset;
        if (offMs > fromMs) {
          items.push({
            pitch: note.pitch,
            velocity: note.velocity,
            channel: sendChannel,
            endpointId: matchedEp?.id,
            adjustedOnTimeMs: onMs,
            adjustedOffTimeMs: offMs
          });
        }
      }
    }

    items.sort((a, b) => a.adjustedOnTimeMs - b.adjustedOnTimeMs);
    this.scheduledNotes = items;
    this.nextNoteIdx = items.findIndex(n => n.adjustedOnTimeMs >= fromMs);
    if (this.nextNoteIdx === -1) this.nextNoteIdx = items.length;
  }

  private processTick(): void {
    const curMs = this.getCurrentPlaybackMs();
    const midiMgr = MidiDeviceManager.getInstance();
    const epMap = new Map(midiMgr.getEndpoints().map(ep => [ep.id, ep]));

    // プリロール終了判定: targetMs に到達したらBGMを開始
    if (!this.isPrerollBgmStarted && curMs >= this.prerollTargetMs) {
      this.playBgm(this.prerollTargetMs);
      this.isPrerollBgmStarted = true;
    }

    // ★ 1. Note Off を先に送信（DAW準拠: Note On より先に旧音を切る）
    let i = 0;
    while (i < this.activeNotes.length) {
      if (this.activeNotes[i].offTimeMs <= curMs) {
        const record = this.activeNotes[i];
        if (epMap.has(record.endpointId)) {
          const ep = epMap.get(record.endpointId)!;
          const status = 0x80 | (record.channel & 0x0f);
          midiMgr.sendBytes(ep, [status, record.pitch & 0x7f, 0]);
        }
        this.activeNotes.splice(i, 1);
      } else {
        i++;
      }
    }

    // ★ 2. Note On 送信（プリロール目標位置に到達している場合のみ）
    // ★ 修正: プリロール目標位置の「手前（最大遅延補正 200ms 分）」から先行 Note On の送信を許可
    // これにより、0ms冒頭のノートに対して -50ms や -100ms の先行発火が正常にマイコンへ届きます
    const ALLOW_PRE_SEND_MS = 250; // 最大レイテンシー補正マージン
    if (curMs >= (this.prerollTargetMs - ALLOW_PRE_SEND_MS)) {
      while (
        this.nextNoteIdx < this.scheduledNotes.length &&
        this.scheduledNotes[this.nextNoteIdx].adjustedOnTimeMs <= curMs
      ) {
        const item = this.scheduledNotes[this.nextNoteIdx++];
        if (item.endpointId && epMap.has(item.endpointId)) {
          const ep = epMap.get(item.endpointId)!;

          // 同一ピッチの先行NoteOff
          const existingIdx = this.activeNotes.findIndex(
            an => an.endpointId === item.endpointId && an.channel === item.channel && an.pitch === item.pitch
          );
          if (existingIdx !== -1) {
            midiMgr.sendBytes(ep, [0x80 | (item.channel & 0x0f), item.pitch & 0x7f, 0]);
            this.activeNotes.splice(existingIdx, 1);
          }

          const status = 0x90 | (item.channel & 0x0f);
          midiMgr.sendBytes(ep, [status, item.pitch & 0x7f, item.velocity & 0x7f]);
          this.activeNotes.push({
            channel: item.channel,
            endpointId: item.endpointId,
            pitch: item.pitch,
            offTimeMs: item.adjustedOffTimeMs
          });
        }
      }
    }

    // 3. メトロノーム クリック再生
    if (this.nextBeatIdx < this.beatList.length && this.beatList[this.nextBeatIdx].timeMs <= curMs) {
      const beat = this.beatList[this.nextBeatIdx++];
      if (this.isMetronomeEnabled) {
        this.checkAndPlayBeat(beat);
      }
    }

    // 曲末尾終了
    if (curMs >= this.totalDurationMs && this.totalDurationMs > 0) {
      this.stop();
    }
  }

  private checkAndPlayBeat(beat: BeatEvent): void {
    const firstNoteMs = this.getFirstNoteTimeMs();

    // 負の拍（0ms未満のカウントイン）は本編テンポで生成されているため常に鳴らす
    if (beat.timeMs >= 0 && beat.timeMs < firstNoteMs - 20) {
      const mainBpm = this.getMainTempoBpm();
      const idx = this.beatList.indexOf(beat);
      let currentBeatBpm = 120;

      if (idx >= 0 && idx < this.beatList.length - 1) {
        const delta = this.beatList[idx + 1].timeMs - beat.timeMs;
        if (delta > 0) currentBeatBpm = Math.round(60000 / delta);
      } else if (idx > 0) {
        const delta = beat.timeMs - this.beatList[idx - 1].timeMs;
        if (delta > 0) currentBeatBpm = Math.round(60000 / delta);
      }

      // 本編BPMと異なるデフォルトテンポ（120等）であればミュート
      if (Math.abs(currentBeatBpm - mainBpm) >= 2) {
        return;
      }
    }

    this.playClick(beat.isAccent);
  }

  private playClick(isAccent: boolean): void {
    if (!this.audioCtx) return;
    const buf = isAccent ? this.strongClickBuffer : this.weakClickBuffer;
    if (!buf) return;

    const source = this.audioCtx.createBufferSource();
    source.buffer = buf;
    source.connect(this.audioCtx.destination);
    source.start(this.audioCtx.currentTime);
  }

  private playBgm(fromMs: number): void {
    if (!this.audioCtx || !this.bgmBuffer) return;
    this.stopBgm();

    const startSec = Math.max(0, fromMs) / 1000.0;
    if (startSec >= this.bgmBuffer.duration) return;

    if (this.bgmGain) {
      this.bgmGain.gain.setValueAtTime(this._isBgmEnabled ? 1 : 0, this.audioCtx.currentTime);
    }

    this.bgmSource = this.audioCtx.createBufferSource();
    this.bgmSource.buffer = this.bgmBuffer;
    this.bgmSource.connect(this.bgmGain!);
    this.bgmSource.start(0, startSec);
  }

  private stopBgm(): void {
    if (this.bgmSource) {
      try { this.bgmSource.stop(); } catch { /* no-op */ }
      this.bgmSource.disconnect();
      this.bgmSource = null;
    }
  }

  private sendAllActiveNotesOff(): void {
    const midiMgr = MidiDeviceManager.getInstance();
    const epMap = new Map(midiMgr.getEndpoints().map(ep => [ep.id, ep]));
    for (const record of this.activeNotes) {
      const ep = epMap.get(record.endpointId);
      if (ep) {
        midiMgr.sendBytes(ep, [0x80 | (record.channel & 0x0f), record.pitch & 0x7f, 0]);
      }
    }
    this.activeNotes = [];
  }

  public subscribe(cb: (isPlaying: boolean, currentMs: number) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notifyState(): void {
    const cur = this.getCurrentPlaybackMs();
    this.listeners.forEach(cb => cb(this.isPlayingState, cur));
  }
}