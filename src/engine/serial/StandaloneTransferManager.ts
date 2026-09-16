import { MidiTrackInfo } from '../../models/SongModels';

export interface TransferProgress {
  sent: number;
  total: number;
  percentage: number;
  message: string;
}

export class StandaloneTransferManager {
  /**
   * トラック情報からスタンドアロン演奏用の5バイトパケットバイナリを生成
   */
  public static compileTrackData(
    track: MidiTrackInfo,
    outputChannel: number
  ): { data: Uint8Array; totalEvents: number } {
    const rawEvents: Array<{
      timeMs: number;
      status: number;
      pitch: number;
      velocity: number;
    }> = [];

    const ch = Math.max(0, Math.min(15, outputChannel));

    // NoteOn と NoteOff をそれぞれ独立したイベントとして展開
    for (const note of track.notes) {
      // NoteOn
      rawEvents.push({
        timeMs: note.startTimeMs,
        status: 0x90 | ch,
        pitch: Math.max(0, Math.min(127, note.pitch)),
        velocity: Math.max(1, Math.min(127, note.velocity || 100))
      });
      // NoteOff
      rawEvents.push({
        timeMs: note.endTimeMs,
        status: 0x80 | ch,
        pitch: Math.max(0, Math.min(127, note.pitch)),
        velocity: 0
      });
    }

    // 時系列順にソート（同時刻なら NoteOff を優先）
    rawEvents.sort((a, b) => {
      if (a.timeMs !== b.timeMs) return a.timeMs - b.timeMs;
      return (a.status & 0xF0) === 0x80 ? -1 : 1;
    });

    const outputBytes: number[] = [];
    let prevMs = 0;

    for (const ev of rawEvents) {
      let delta = Math.round(ev.timeMs - prevMs);
      if (delta < 0) delta = 0;
      if (delta > 0xFFFF) delta = 0xFFFF; // 2バイト上限 (約65秒)

      outputBytes.push(
        ev.status,
        ev.pitch,
        ev.velocity,
        (delta >> 8) & 0xFF,
        delta & 0xFF
      );

      prevMs += delta;
    }

    return {
      data: new Uint8Array(outputBytes),
      totalEvents: rawEvents.length
    };
  }

  /**
   * Web Serial API 経由で M5Atom にデータを転送
   */
  public static async transferTrack(
    track: MidiTrackInfo,
    outputChannel: number,
    onProgress?: (progress: TransferProgress) => void
  ): Promise<{ success: boolean; error?: string }> {
    const nav = navigator as any;
    if (!nav.serial) {
      return { success: false, error: 'Web Serial API に未対応のブラウザです。Google Chromeをご利用ください。' };
    }

    const { data, totalEvents } = this.compileTrackData(track, outputChannel);
    if (totalEvents === 0) {
      return { success: false, error: '転送対象のノーツが存在しません。' };
    }

    let port: any = null;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;

    try {
      port = await nav.serial.requestPort();
      await port.open({ baudRate: 115200 });

      reader = port.readable.getReader();
      writer = port.writable.getWriter();

      // ★ reader / writer の null チェックと安全な参照スコープの確保
      if (!reader || !writer) {
        throw new Error('シリアルポートのストリーム取得に失敗しました。');
      }

      const currentReader = reader;
      const currentWriter = writer;

      // ★ 修正版 waitAck: 単一の readLoop を Promise.race でタイムアウト監視
      const waitAck = async (expected = 0x9E, timeoutMs = 6000): Promise<void> => {
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('マイコンからのACK応答（0x9E）がタイムアウトしました。')), timeoutMs)
        );

        const readLoop = async (): Promise<void> => {
          while (true) {
            const { value, done } = await currentReader.read();
            if (done) throw new Error('シリアルポートが切断されました。');
            if (value && value.length > 0) {
              for (let i = 0; i < value.length; i++) {
                if (value[i] === expected) return;
              }
            }
          }
        };

        await Promise.race([readLoop(), timeoutPromise]);
      };

      // 1. 開始合図 (0x9E)
      onProgress?.({ sent: 0, total: totalEvents, percentage: 0, message: '転送セッションを開始中...' });
      await currentWriter.write(new Uint8Array([0x9E]));
      await waitAck(0x9E, 3000);

      // 2. 総イベント数送信 (2バイト)
      const countHigh = (totalEvents >> 8) & 0xFF;
      const countLow = totalEvents & 0xFF;
      await currentWriter.write(new Uint8Array([countHigh, countLow]));
      await waitAck(0x9E, 3000);

      // 3. ノートパケット送信（バッファ溢れ防止のため 20ノーツ = 100B 単位で送信）
      const CHUNK_SIZE = 20 * 5;
      for (let i = 0; i < data.length; i += CHUNK_SIZE) {
        const chunk = data.subarray(i, Math.min(data.length, i + CHUNK_SIZE));
        await currentWriter.write(chunk);

        const currentSent = Math.min(totalEvents, Math.floor((i + chunk.length) / 5));
        const pct = Math.round((currentSent / totalEvents) * 100);
        onProgress?.({
          sent: currentSent,
          total: totalEvents,
          percentage: pct,
          message: `ノーツ転送中 (${currentSent} / ${totalEvents})`
        });

        // マイコンのフラッシュ書き込み猶予として 10ms 待機
        await new Promise(r => setTimeout(r, 10));
      }

      // 4. LittleFS 保存完了待機 (最長10秒)
      onProgress?.({ sent: totalEvents, total: totalEvents, percentage: 100, message: 'マイコンのフラッシュメモリに書き込み中...' });
      await waitAck(0x9E, 10000);

      return { success: true };
    } catch (err: any) {
      if (err.name === 'NotFoundError') {
        return { success: false, error: 'COMポートの選択がキャンセルされました。' };
      }
      return { success: false, error: err.message || '転送中にエラーが発生しました。' };
    } finally {
      try {
        if (reader) {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        if (writer) {
          await writer.close().catch(() => {});
          writer.releaseLock();
        }
        await new Promise(r => setTimeout(r, 50));
        if (port) {
          await port.close().catch(() => {});
        }
      } catch {
        /* no-op */
      }
    }
  }
}