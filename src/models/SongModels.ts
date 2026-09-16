import { InstrumentPreset } from './InstrumentPreset';

export interface LaneSlot {
  id: string;
  isEnabled: boolean;
  selectedChannel: number;      // MIDIファイル内の抽出元Ch (0-15)
  trackIndex?: number;
  assignedPreset: InstrumentPreset; // 送信先マイコン
  outputChannel?: number;       // 送信先Ch / 弦指定 (0-15)
  latencyOffsetMs: number;
  customColor?: string;
  parentId?: string;            // 親スロットのID（子レーンのみ指定）
  channelColors?: Record<number, string>;
}

export interface EnsemblePreset {
  id: string; // UUID
  name: string;
  songSlots: Record<string, LaneSlot[]>; // [songId]: LaneSlot[]
}

export interface PresetsStorageData {
  activePresetID: string;
  presets: EnsemblePreset[];
}

export interface MidiNote {
  id: number;
  trackIndex: number;
  channel: number;
  pitch: number;
  velocity: number;
  startTick: number;
  endTick: number;
  startTimeMs: number;
  endTimeMs: number;
  durationMs: number;
}

export interface MidiTrackInfo {
  id: number;
  trackIndex: number;
  name: string;
  channel: number;
  notes: MidiNote[];
}

export interface TempoEvent {
  tick: number;
  timeMs: number;
  bpm: number;
  microsecondsPerQuarter: number;
}

export interface TimeSignatureEvent {
  tick: number;
  timeMs: number;
  numerator: number;
  denominator: number;
  clocksPerClick: number;
  thirtySecondNotesPerQuarter: number;
}

export interface BeatEvent {
  timeMs: number;
  barIndex: number;
  beatIndex: number;
  isAccent: boolean;
}

export class ChannelCache {
  public readonly channel: number;
  public readonly notes: MidiNote[];
  public readonly noteCount: number;
  public readonly minPitch: number;
  public readonly maxPitch: number;

  constructor(notes: MidiNote[]) {
    this.channel = notes[0]?.channel ?? 0;
    this.notes = [...notes].sort((a, b) => a.startTimeMs - b.startTimeMs);
    this.noteCount = this.notes.length;
    
    let minP = 127;
    let maxP = 0;
    for (const n of this.notes) {
      if (n.pitch < minP) minP = n.pitch;
      if (n.pitch > maxP) maxP = n.pitch;
    }
    this.minPitch = this.noteCount > 0 ? minP : 60;
    this.maxPitch = this.noteCount > 0 ? maxP : 60;
  }

  /**
   * 画面内に描画すべきノーツを二分探索で高速抽出
   */
  public visibleNotes(fromMs: Double, toMs: Double): MidiNote[] {
    if (this.notes.length === 0) return [];
    let low = 0;
    let high = this.notes.length;

    while (low < high) {
      const mid = (low + high) >> 1;
      if (this.notes[mid].endTimeMs < fromMs) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }

    const result: MidiNote[] = [];
    for (let i = low; i < this.notes.length; i++) {
      const note = this.notes[i];
      if (note.startTimeMs > toMs) break;
      result.push(note);
    }
    return result;
  }
}

export interface MidiSongData {
  id: string; // UUID
  fileName: string;
  midiBlobKey: string; // IndexedDB lookup key
  bgmBlobKey?: string;
  bgmFileName?: string;
  ppq: number;
  durationMs: number;
  totalTicks: number;
  tracks: MidiTrackInfo[];
  slots: LaneSlot[];
  tempoEvents: TempoEvent[];
  timeSignatureEvents: TimeSignatureEvent[];
  beatEvents: BeatEvent[];
  channelCaches: Record<number, ChannelCache>;
  usedChannels: number[];
}
type Double = number;