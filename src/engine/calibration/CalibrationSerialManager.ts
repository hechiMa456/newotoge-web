// =====================================================
// Calibration Serial Protocol Constants
// =====================================================
export const CMD_CONFIRM = 0x9F;

export const MODE_SETTING_ENTRY = 0x01; // Angle Load (角度データをPCに送信)
export const MODE_CALIBRATION   = 0x02; // Calibration (角度更新 + モータ回転)
export const MODE_WRITE         = 0x03; // Angle Write (フラッシュメモリ保存)
export const MODE_RESET         = 0x04; // Angle Reset (初期値へ戻す)
export const MODE_ID            = 0x05; // ID & MCU情報取得
export const MODE_RESTORE       = 0x06; // Angle Restore (RAMのみ更新・モータ回転なし)

export interface CalibrationDeviceInfo {
  instId: number;
  aliasName: string;
  pwmFrequencyHz: number;
  pwmMin: number;
  pwmMax: number;
}

export interface CalibrationLoadResult {
  success: boolean;
  servoAngle: number[][]; // [motor_idx][state_idx]
  motorNum: number;
  stateNum: number;
  stateCountPerMotor: number[];
}

export class CalibrationSerialManager {
  private port: any | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;

  private rxBuffer: number[] = [];
  public deviceInfo: CalibrationDeviceInfo | null = null;

  public isConnected(): boolean {
    return !!(this.port && this.port.readable && this.port.writable);
  }

  // --- 接続 / 切断 ---

  // --- 接続 / 切断 ---

  public async connect(targetPort?: any): Promise<boolean> {
    const nav = navigator as any;
    if (!nav.serial) {
      throw new Error('お使いのブラウザは Web Serial API に対応していません。Google Chrome をご利用ください。');
    }

    try {
      // ★ 接続試行前に既存の残存接続・ロックを完全にクリーンアップ
      await this.disconnect();

      if (targetPort) {
        this.port = targetPort;
      } else {
        this.port = await nav.serial.requestPort();
      }

      if (!this.port.readable) {
        await this.port.open({ baudRate: 115200 });
      }

      this.reader = this.port.readable.getReader();
      this.writer = this.port.writable.getWriter();
      this.rxBuffer = [];

      return true;
    } catch (err) {
      console.error('Serial connection error:', err);
      await this.disconnect();
      return false;
    }
  }

  public async disconnect(): Promise<void> {
    try {
      // 1. Reader のロック解放
      if (this.reader) {
        await this.reader.cancel().catch(() => {});
        this.reader.releaseLock();
        this.reader = null;
      }
      // 2. Writer のロック解放
      if (this.writer) {
        await this.writer.close().catch(() => {});
        this.writer.releaseLock();
        this.writer = null;
      }
      // 3. ブラウザ側のストリーム破棄ラグを待機
      await new Promise(resolve => setTimeout(resolve, 50));

      // 4. ポートのクローズ
      if (this.port) {
        await this.port.close().catch(() => {});
        this.port = null;
      }
    } catch (e) {
      console.warn('Error during disconnect:', e);
    } finally {
      this.port = null;
      this.reader = null;
      this.writer = null;
      this.rxBuffer = [];
      this.deviceInfo = null;
    }
  }

  // --- 低レイヤ シリアル送受信ヘルパー ---

  private async writeBytes(bytes: number[]): Promise<boolean> {
    if (!this.writer) return false;
    try {
      await this.writer.write(new Uint8Array(bytes));
      return true;
    } catch (err) {
      console.error('writeBytes error:', err);
      return false;
    }
  }

  private async readByte(timeoutMs: number = 1000): Promise<number> {
    const startTime = Date.now();

    while (this.rxBuffer.length === 0) {
      if (Date.now() - startTime > timeoutMs) {
        return -1; // タイムアウト
      }

      if (!this.reader) return -1;

      try {
        const readPromise = this.reader.read();
        const timeoutPromise = new Promise<{ value: undefined; done: boolean }>(resolve =>
          setTimeout(() => resolve({ value: undefined, done: false }), 50)
        );

        const result = await Promise.race([readPromise, timeoutPromise]);
        if (result.done) return -1;
        if (result.value) {
          for (let i = 0; i < result.value.length; i++) {
            this.rxBuffer.push(result.value[i]);
          }
        }
      } catch (err) {
        console.error('readByte error:', err);
        return -1;
      }
    }

    return this.rxBuffer.shift()!;
  }

  private async readBytes(count: number, timeoutMs: number = 1000): Promise<number[] | null> {
    const result: number[] = [];
    for (let i = 0; i < count; i++) {
      const b = await this.readByte(timeoutMs);
      if (b < 0) return null;
      result.push(b);
    }
    return result;
  }

  /**
   * 0x9F (CMD_CONFIRM) が来るまでゴミデータを読み捨てながら待機
   */
  private async waitForConfirm(timeoutMs: number = 1000): Promise<number> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const b = await this.readByte(200);
      if (b === CMD_CONFIRM) {
        return CMD_CONFIRM;
      }
    }
    return -1;
  }

  /**
   * 設定モードに進入し、コマンドバイトを送信する
   */
  private async shiftToSettingMode(switchCmd: number, lastWaitFlag: boolean = false): Promise<number> {
    if (!this.isConnected()) return -1;

    // バッファに残った古いゴミデータをクリア
    this.rxBuffer = [];

    // [0x9F, 0x01, 0x01] 送信
    if (!(await this.writeBytes([0x9F, 0x01, 0x01]))) return -1;

    const ack = await this.waitForConfirm(1000);
    if (ack !== CMD_CONFIRM) return -1;

    // モードスイッチ送信
    if (!(await this.writeBytes([switchCmd]))) return -1;

    if (lastWaitFlag) {
      return await this.waitForConfirm(1000);
    }
    return 0;
  }

  // --- 高レイヤ プロトコル処理 ---

  /**
   * ハンドシェイクを実行し、InstID・MCU名・PWM周波数・クランプ値を取得
   */
  public async handshake(): Promise<CalibrationDeviceInfo | null> {
    if (!this.isConnected()) return null;

    try {
      this.rxBuffer = [];

      // Step 1: [0x9F, 0x01, 0x01] 送信
      if (!(await this.writeBytes([0x9F, 0x01, 0x01]))) return null;
      const ack = await this.waitForConfirm(1000);
      if (ack !== CMD_CONFIRM) return null;

      await new Promise(r => setTimeout(r, 60));

      // Step 2: [0x05] ID要求 送信
      if (!(await this.writeBytes([MODE_ID]))) return null;

      const flag = await this.readByte(1000);
      if (flag !== 0xFF) return null;

      const instId = await this.readByte(1000);
      if (instId < 0) return null;

      // Step 3: MCU名 (NUL終端文字列) の読み取り
      const nameBytes: number[] = [];
      while (true) {
        const b = await this.readByte(500);
        if (b <= 0) break; // NUL終端 または タイムアウト
        nameBytes.push(b);
      }
      const aliasName = new TextDecoder('ascii').decode(new Uint8Array(nameBytes)).trim() || '----';

      // Step 4: PWM周波数 (uint16 little-endian: 2 bytes)
      let pwmFrequencyHz = 50.0;
      const freqBytes = await this.readBytes(2, 500);
      if (freqBytes && freqBytes.length === 2) {
        const freq = freqBytes[0] | (freqBytes[1] << 8);
        if (freq > 0) pwmFrequencyHz = freq;
      }

      // Step 5: PWMクランプ (uint16_LE min / uint16_LE max: 4 bytes)
      let pwmMin = 0;
      let pwmMax = 4095;
      const clampBytes = await this.readBytes(4, 500);
      if (clampBytes && clampBytes.length === 4) {
        pwmMin = clampBytes[0] | (clampBytes[1] << 8);
        pwmMax = clampBytes[2] | (clampBytes[3] << 8);
      }

      this.deviceInfo = {
        instId,
        aliasName,
        pwmFrequencyHz,
        pwmMin,
        pwmMax
      };

      return this.deviceInfo;
    } catch (err) {
      console.error('Handshake error:', err);
      return null;
    }
  }

  /**
   * マイコンからサーボ角度データを読み込む (Angle Load)
   */
  public async loadServoAngles(): Promise<CalibrationLoadResult> {
    const fail: CalibrationLoadResult = {
      success: false,
      servoAngle: [],
      motorNum: 0,
      stateNum: 0,
      stateCountPerMotor: []
    };

    if (!this.isConnected()) return fail;

    try {
      const modeResult = await this.shiftToSettingMode(MODE_SETTING_ENTRY, false);
      if (modeResult === -1) return fail;

      await new Promise(r => setTimeout(r, 60));

      // 1. MOTOR_NUM
      const mFlag = await this.readByte(1000);
      if (mFlag !== 0xFF) return fail;
      const motorNum = await this.readByte(1000);
      if (motorNum <= 0) return fail;
      await this.writeBytes([CMD_CONFIRM]);

      await new Promise(r => setTimeout(r, 30));

      // 2. STATE_NUM (MAX_STATE_NUM)
      const sFlag = await this.readByte(1000);
      if (sFlag !== 0xFF) return fail;
      const stateNum = await this.readByte(1000);
      if (stateNum <= 0) return fail;
      await this.writeBytes([CMD_CONFIRM]);

      await new Promise(r => setTimeout(r, 30));

      // 3. StateCountPerMotor 受信
      const stateCountPerMotor: number[] = [];
      for (let i = 0; i < motorNum; i++) {
        const flag = await this.readByte(1000);
        if (flag !== 0xFF) return fail;
        const count = await this.readByte(1000);
        if (count < 0) return fail;
        await this.writeBytes([CMD_CONFIRM]);
        stateCountPerMotor.push(count);
      }

      await new Promise(r => setTimeout(r, 30));

      // 4. 可変長角度データ受信
      const totalExpectedWords = stateCountPerMotor.reduce((a, b) => a + b, 0);
      const allAngleBytes: number[] = [];

      for (let i = 0; i < totalExpectedWords * 2; i++) {
        const flag = await this.readByte(1000);
        if (flag !== 0xFF) return fail;
        const val = await this.readByte(1000);
        if (val < 0) return fail;
        await this.writeBytes([CMD_CONFIRM]);
        allAngleBytes.push(val);
      }

      // ファームウェア側の送信順序（State優先ループ）に合わせて [motor_idx][state_idx] へデコード
      const servoAngle: number[][] = Array.from({ length: motorNum }, () => Array(stateNum).fill(0));
      let byteIdx = 0;

      for (let s = 0; s < stateNum; s++) {
        for (let m = 0; m < motorNum; m++) {
          if (s >= stateCountPerMotor[m]) continue;
          const high = allAngleBytes[byteIdx];
          const low = allAngleBytes[byteIdx + 1];
          byteIdx += 2;
          servoAngle[m][s] = (high << 8) | low;
        }
      }

      return {
        success: true,
        servoAngle,
        motorNum,
        stateNum,
        stateCountPerMotor
      };
    } catch (err) {
      console.error('loadServoAngles error:', err);
      return fail;
    }
  }

  /**
   * リアルタイム角度送信 (Calibration: モーター回転あり)
   */
  public async sendServoAngleRealtime(motorIdx: number, stateIdx: number, angle: number): Promise<boolean> {
    if (!this.isConnected()) return false;

    // PWMクランプ適用
    let clampedAngle = angle;
    if (this.deviceInfo) {
      if (this.deviceInfo.pwmMin > 0) clampedAngle = Math.max(this.deviceInfo.pwmMin, clampedAngle);
      if (this.deviceInfo.pwmMax < 4095) clampedAngle = Math.min(this.deviceInfo.pwmMax, clampedAngle);
    }
    clampedAngle = Math.max(0, Math.min(4095, Math.round(clampedAngle)));

    try {
      const modeResult = await this.shiftToSettingMode(MODE_CALIBRATION, true);
      if (modeResult !== CMD_CONFIRM) return false;

      const payload = [
        motorIdx,
        stateIdx,
        (clampedAngle >> 8) & 0xFF,
        clampedAngle & 0xFF
      ];

      for (const byteVal of payload) {
        if (!(await this.writeBytes([byteVal]))) return false;
        const ack = await this.waitForConfirm(500);
        if (ack !== CMD_CONFIRM) return false;
      }

      return true;
    } catch (err) {
      console.error('sendServoAngleRealtime error:', err);
      return false;
    }
  }

  /**
   * CSVからの復元時用 (Restore: RAMのみ更新・モーター回転なし)
   */
  public async restoreServoAngles(servoAngles: number[][], stateCountPerMotor?: number[]): Promise<boolean> {
    if (!this.isConnected()) return false;

    const motorNum = servoAngles.length;
    const stateNum = servoAngles[0]?.length ?? 0;

    try {
      for (let m = 0; m < motorNum; m++) {
        const count = stateCountPerMotor?.[m] ?? stateNum;
        for (let s = 0; s < count; s++) {
          const modeResult = await this.shiftToSettingMode(MODE_RESTORE, true);
          if (modeResult !== CMD_CONFIRM) return false;

          const angle = Math.round(servoAngles[m][s]);
          const payload = [m, s, (angle >> 8) & 0xFF, angle & 0xFF];

          for (const byteVal of payload) {
            if (!(await this.writeBytes([byteVal]))) return false;
            const ack = await this.waitForConfirm(500);
            if (ack !== CMD_CONFIRM) return false;
          }
        }
      }
      return true;
    } catch (err) {
      console.error('restoreServoAngles error:', err);
      return false;
    }
  }

  /**
   * 現在のRAMデータをフラッシュメモリ (Play_ServoAngle.bin) に保存
   */
  public async writeServoAnglesToFile(): Promise<boolean> {
    if (!this.isConnected()) return false;

    try {
      const modeResult = await this.shiftToSettingMode(MODE_WRITE, false);
      if (modeResult === -1) return false;

      const ack = await this.waitForConfirm(2000);
      return ack === CMD_CONFIRM;
    } catch (err) {
      console.error('writeServoAnglesToFile error:', err);
      return false;
    }
  }

  /**
   * 初期値 (Save_ServoAngle_InProgram.bin) にリセット
   */
  public async resetServoAngles(): Promise<boolean> {
    if (!this.isConnected()) return false;

    try {
      const modeResult = await this.shiftToSettingMode(MODE_RESET, false);
      if (modeResult === -1) return false;

      const ack = await this.waitForConfirm(2000);
      return ack === CMD_CONFIRM;
    } catch (err) {
      console.error('resetServoAngles error:', err);
      return false;
    }
  }
}