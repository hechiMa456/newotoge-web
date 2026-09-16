import {
  MidiSongData, MidiTrackInfo, MidiNote, TempoEvent,
  TimeSignatureEvent, BeatEvent, ChannelCache, LaneSlot
} from '../../models/SongModels';
import { INSTRUMENT_PRESETS } from '../../models/InstrumentPreset';

// デフォルトのチャンネル・トラック割り当て色
const DEFAULT_CHANNEL_COLORS = [
  '#FF4D4D', '#FF8533', '#FFC000', '#2ECC71',
  '#00D2D3', '#3498DB', '#9B59B6', '#E056FD',
  '#FF6B81', '#1DD1A1', '#F368E0', '#54A0FF',
  '#5F27CD', '#C8D6E5', '#FF9F43', '#10AC84'
];

class DataReader {
  private view: DataView;
  public offset: number = 0;

  constructor(buffer: ArrayBuffer) {
    this.view = new DataView(buffer);
  }

  get length(): number {
    return this.view.byteLength;
  }

  readByte(): number {
    if (this.offset >= this.length) throw new Error('Unexpected end of data');
    const b = this.view.getUint8(this.offset);
    this.offset += 1;
    return b;
  }

  peekByte(): number | null {
    if (this.offset >= this.length) return null;
    return this.view.getUint8(this.offset);
  }

  readBytes(count: number): Uint8Array {
    if (this.offset + count > this.length) throw new Error('Unexpected end of data');
    const bytes = new Uint8Array(this.view.buffer, this.offset, count);
    this.offset += count;
    return bytes;
  }

  readUInt16(): number {
    const val = this.view.getUint16(this.offset, false);
    this.offset += 2;
    return val;
  }

  readUInt32(): number {
    const val = this.view.getUint32(this.offset, false);
    this.offset += 4;
    return val;
  }

  readVariableLength(): number {
    let value = 0;
    while (true) {
      const b = this.readByte();
      value = (value << 7) | (b & 0x7f);
      if ((b & 0x80) === 0) break;
    }
    return value;
  }

  readString(length: number): string {
    const bytes = this.readBytes(length);
    return new TextDecoder('ascii').decode(bytes);
  }

  skip(count: number): void {
    this.offset = Math.min(this.length, this.offset + count);
  }
}

interface RawTrackEvent {
  tick: number;
  status: number;
  data1: number;
  data2: number;
  metaType?: number;
  metaData?: Uint8Array;
}

export class MidiParser {
  public static parse(buffer: ArrayBuffer, fileName: string, id: string = crypto.randomUUID()): MidiSongData {
    const reader = new DataReader(buffer);

    const headerTag = reader.readString(4);
    if (headerTag !== 'MThd') throw new Error('無効なMIDIファイルヘッダーです。');

    const headerLength = reader.readUInt32();
    const format = reader.readUInt16();
    const numTracks = reader.readUInt16();
    const timeDivision = reader.readUInt16();

    if (format !== 0 && format !== 1) {
      throw new Error(`未対応のMIDIフォーマットです (Format ${format})。`);
    }

    const ppq = timeDivision & 0x7fff;
    if (headerLength > 6) {
      reader.skip(headerLength - 6);
    }

    const rawTracks: RawTrackEvent[][] = [];
    const trackNames: string[] = [];

    for (let trackIdx = 0; trackIdx < numTracks; trackIdx++) {
      const trackTag = reader.readString(4);
      if (trackTag !== 'MTrk') throw new Error('無効なMIDIトラックヘッダーです。');

      const trackLength = reader.readUInt32();
      const trackEndOffset = reader.offset + trackLength;

      const events: RawTrackEvent[] = [];
      let currentTick = 0;
      let runningStatus = 0;
      let trackName = `Track ${trackIdx + 1}`;

      while (reader.offset < trackEndOffset) {
        const delta = reader.readVariableLength();
        currentTick += delta;

        const firstByte = reader.peekByte();
        if (firstByte === null) break;

        let status: number;
        if (firstByte >= 0x80) {
          status = reader.readByte();
          if (status < 0xf0) {
            runningStatus = status;
          }
        } else {
          status = runningStatus;
        }

        if (status === 0xff) {
          const metaType = reader.readByte();
          const length = reader.readVariableLength();
          const metaBytes = reader.readBytes(length);

          if (metaType === 0x03) {
            try {
              trackName = new TextDecoder('utf-8').decode(metaBytes).trim();
            } catch {
              trackName = new TextDecoder('shift-jis').decode(metaBytes).trim();
            }
          }

          events.push({
            tick: currentTick,
            status,
            data1: 0,
            data2: 0,
            metaType,
            metaData: metaBytes
          });
        } else if (status === 0xf0 || status === 0xf7) {
          const length = reader.readVariableLength();
          reader.readBytes(length);
        } else {
          const messageType = status & 0xf0;
          const data1 = reader.readByte();
          let data2 = 0;
          if (messageType !== 0xc0 && messageType !== 0xd0) {
            data2 = reader.readByte();
          }

          events.push({
            tick: currentTick,
            status,
            data1,
            data2
          });
        }
      }

      rawTracks.push(events);
      trackNames.push(trackName);
      reader.offset = trackEndOffset;
    }

    // テンポ・拍子解析
    const rawTempoEvents: { tick: number; mpq: number }[] = [];
    const rawTimeSignatures: { tick: number; num: number; denom: number }[] = [];

    for (const events of rawTracks) {
      for (const e of events) {
        if (e.status === 0xff && e.metaData) {
          if (e.metaType === 0x51 && e.metaData.length >= 3) {
            const mpq = (e.metaData[0] << 16) | (e.metaData[1] << 8) | e.metaData[2];
            rawTempoEvents.push({ tick: e.tick, mpq });
          } else if (e.metaType === 0x58 && e.metaData.length >= 2) {
            rawTimeSignatures.push({
              tick: e.tick,
              num: e.metaData[0],
              denom: 1 << e.metaData[1]
            });
          }
        }
      }
    }

    rawTempoEvents.sort((a, b) => a.tick - b.tick);
    if (rawTempoEvents.length === 0 || rawTempoEvents[0].tick !== 0) {
      rawTempoEvents.unshift({ tick: 0, mpq: 500000 }); // 120 BPM
    }

    // 重複 Tick 整理
    const cleanTempos: { tick: number; mpq: number }[] = [];
    for (const t of rawTempoEvents) {
      if (cleanTempos.length > 0 && cleanTempos[cleanTempos.length - 1].tick === t.tick) {
        cleanTempos[cleanTempos.length - 1].mpq = t.mpq;
      } else {
        cleanTempos.push({ ...t });
      }
    }

    const tempoEvents: TempoEvent[] = [];
    let lastTick = 0;
    let accumulatedMs = 0.0;

    for (const item of cleanTempos) {
      const dt = item.tick - lastTick;
      if (dt > 0 && tempoEvents.length > 0) {
        const lastMpq = tempoEvents[tempoEvents.length - 1].microsecondsPerQuarter;
        accumulatedMs += (dt / ppq) * (lastMpq / 1000.0);
      }
      lastTick = item.tick;
      tempoEvents.push({
        tick: item.tick,
        timeMs: accumulatedMs,
        bpm: 60000000.0 / item.mpq,
        microsecondsPerQuarter: item.mpq
      });
    }

    const calculateTickToMs = (targetTick: number): number => {
      let accMs = 0.0;
      let prevTick = 0;
      let currentMpq = tempoEvents[0]?.microsecondsPerQuarter ?? 500000;

      for (const te of tempoEvents) {
        if (targetTick < te.tick) break;
        const dt = te.tick - prevTick;
        accMs += (dt / ppq) * (currentMpq / 1000.0);
        prevTick = te.tick;
        currentMpq = te.microsecondsPerQuarter;
      }

      const remTicks = targetTick - prevTick;
      if (remTicks > 0) {
        accMs += (remTicks / ppq) * (currentMpq / 1000.0);
      }
      return accMs;
    };

    rawTimeSignatures.sort((a, b) => a.tick - b.tick);
    const timeSignatureEvents: TimeSignatureEvent[] = rawTimeSignatures.map(ts => ({
      tick: ts.tick,
      timeMs: calculateTickToMs(ts.tick),
      numerator: ts.num,
      denominator: ts.denom,
      clocksPerClick: 24,
      thirtySecondNotesPerQuarter: 8
    }));
    if (timeSignatureEvents.length === 0) {
      timeSignatureEvents.push({
        tick: 0,
        timeMs: 0,
        numerator: 4,
        denominator: 4,
        clocksPerClick: 24,
        thirtySecondNotesPerQuarter: 8
      });
    }

    // ノーツ抽出
    const parsedTracks: MidiTrackInfo[] = [];
    let maxTick = 0;
    const channelBuckets: Record<number, MidiNote[]> = {};
    for (let ch = 0; ch < 16; ch++) channelBuckets[ch] = [];

    let noteIdCounter = 0;

    for (let trackIdx = 0; trackIdx < rawTracks.length; trackIdx++) {
      const events = rawTracks[trackIdx];
      const activeNotes = new Map<number, { tick: number; vel: number }>();
      const trackNotes: MidiNote[] = [];

      for (const e of events) {
        if (e.tick > maxTick) maxTick = e.tick;
        const msgType = e.status & 0xf0;
        const ch = e.status & 0x0f;
        const pitch = e.data1;
        const vel = e.data2;
        const key = (ch << 8) | pitch;

        if (msgType === 0x90 && vel > 0) {
          const prev = activeNotes.get(key);
          if (prev) {
            const onMs = calculateTickToMs(prev.tick);
            const offMs = calculateTickToMs(e.tick);
            const note: MidiNote = {
              id: noteIdCounter++,
              trackIndex: trackIdx,
              channel: ch,
              pitch,
              velocity: prev.vel,
              startTick: prev.tick,
              endTick: e.tick,
              startTimeMs: onMs,
              endTimeMs: offMs,
              durationMs: Math.max(1.0, offMs - onMs)
            };
            trackNotes.push(note);
            channelBuckets[ch].push(note);
          }
          activeNotes.set(key, { tick: e.tick, vel });
        } else if (msgType === 0x80 || (msgType === 0x90 && vel === 0)) {
          const prev = activeNotes.get(key);
          if (prev) {
            activeNotes.delete(key);
            const onMs = calculateTickToMs(prev.tick);
            const offMs = calculateTickToMs(e.tick);
            const note: MidiNote = {
              id: noteIdCounter++,
              trackIndex: trackIdx,
              channel: ch,
              pitch,
              velocity: prev.vel,
              startTick: prev.tick,
              endTick: e.tick,
              startTimeMs: onMs,
              endTimeMs: offMs,
              durationMs: Math.max(1.0, offMs - onMs)
            };
            trackNotes.push(note);
            channelBuckets[ch].push(note);
          }
        }
      }

      trackNotes.sort((a, b) => a.startTimeMs - b.startTimeMs);
      parsedTracks.push({
        id: trackIdx,
        trackIndex: trackIdx,
        name: trackNames[trackIdx],
        channel: 0,
        notes: trackNotes
      });
    }

    const totalDurationMs = calculateTickToMs(maxTick);

    const channelCaches: Record<number, ChannelCache> = {};
    for (let ch = 0; ch < 16; ch++) {
      channelCaches[ch] = new ChannelCache(channelBuckets[ch]);
    }

    // 拍・小節イベント (BeatEvent) 生成
    const beatEvents: BeatEvent[] = [];
    if (totalDurationMs > 0) {
      let curTick = 0;
      let beatIndex = 0;
      const beatsPerBar = timeSignatureEvents[0]?.numerator ?? 4;

      while (curTick <= maxTick + ppq * 4) {
        const ms = calculateTickToMs(curTick);
        beatEvents.push({
          timeMs: ms,
          barIndex: Math.floor(beatIndex / beatsPerBar),
          beatIndex: beatIndex % beatsPerBar,
          isAccent: beatIndex % beatsPerBar === 0
        });
        curTick += ppq;
        beatIndex++;
      }
    }

    const usedChannels = Object.keys(channelCaches)
      .map(Number)
      .filter(ch => channelCaches[ch].noteCount > 0)
      .sort((a, b) => a - b);

    // ★ Format 0 (単一トラックに複数Ch混在) の場合はチャンネルごとに仮想トラックを生成
    let finalTracks = parsedTracks.filter(t => t.notes.length > 0);
    if (finalTracks.length <= 1 && usedChannels.length > 1) {
      finalTracks = usedChannels.map((ch, idx) => ({
        id: idx,
        trackIndex: idx,
        name: `Ch ${ch + 1}`,
        channel: ch,
        notes: channelBuckets[ch]
      }));
    }

    // トラック起点で初期スロットを生成
    const defaultSlots: LaneSlot[] = finalTracks.map((tr, idx) => {
      const primaryCh = tr.notes[0]?.channel ?? (tr.channel ?? 0);
      return {
        id: crypto.randomUUID(),
        isEnabled: true,
        trackIndex: tr.trackIndex,
        selectedChannel: primaryCh,
        outputChannel: -1,
        assignedPreset: INSTRUMENT_PRESETS[0], // None
        latencyOffsetMs: 0.0,
        customColor: DEFAULT_CHANNEL_COLORS[idx % 16]
      };
    });

    return {
      id,
      fileName,
      midiBlobKey: `midi_${id}`,
      ppq,
      durationMs: totalDurationMs,
      totalTicks: maxTick,
      tracks: finalTracks,
      slots: defaultSlots,
      tempoEvents,
      timeSignatureEvents,
      beatEvents,
      channelCaches,
      usedChannels
    };
  }
}