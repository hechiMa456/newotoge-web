// =====================================================
// Calibration Core & CSV Handling Logic
// =====================================================

export const PWM_COUNTER_MAX = 4095;
export const PWM_COUNTER_STEPS = 4096;
export const SERVO_PULSE_MIN_MS = 0.5;
export const SERVO_PULSE_MAX_MS = 2.5;

export interface CSVParseResult {
  success: boolean;
  servoAngle: number[][];
  motorNum: number;
  stateNum: number;
  errorMessage?: string;
}

export class CalibrationCore {
  // 端数蓄積バッファ: key = `${motorIdx}_${stateIdx}`, value = float
  private static angleRemainders: Map<string, number> = new Map();

  // --- PWM / パルス計算 ---

  public static getPwmPeriodMs(pwmFrequencyHz: number): number {
    return pwmFrequencyHz <= 0 ? 0.0 : 1000.0 / pwmFrequencyHz;
  }

  public static getPwmCountsPerMs(pwmFrequencyHz: number): number {
    const periodMs = this.getPwmPeriodMs(pwmFrequencyHz);
    return periodMs <= 0 ? 0.0 : PWM_COUNTER_STEPS / periodMs;
  }

  public static getServoResolutionSteps(pwmFrequencyHz: number): number {
    const pulseRangeMs = Math.max(0.0, SERVO_PULSE_MAX_MS - SERVO_PULSE_MIN_MS);
    return pulseRangeMs * this.getPwmCountsPerMs(pwmFrequencyHz);
  }

  /**
   * ボタン倍率 (±1, ±5, ±20) に応じた float 差分カウントを算出
   */
  public static getServoAdjustmentCounts(multiplier: number, pwmFrequencyHz: number): number {
    const activeRangeSteps = this.getServoResolutionSteps(pwmFrequencyHz);
    const absMult = Math.abs(multiplier);
    const sign = multiplier >= 0 ? 1 : -1;

    try {
      if (absMult === 1) return 1.0 * sign;
      if (absMult === 5) return (activeRangeSteps / 60.0) * sign;
      if (absMult === 20) return (activeRangeSteps / 30.0) * sign;
      return 1.0 * sign;
    } catch {
      return 1.0 * sign;
    }
  }

  /**
   * 1.5ms ニュートラル時の PWM カウンタ値を算出
   */
  public static calculateNeutralPwmCount(pwmFrequencyHz: number): number {
    const hz = pwmFrequencyHz > 0 ? pwmFrequencyHz : 50.0;
    const neutralCount = Math.round((1.5 * hz / 1000.0) * 4096.0);
    return Math.max(0, Math.min(4095, neutralCount));
  }

  // --- 端数バッファ & クランプ処理 ---

  public static initRemainders(motorNum: number, stateNum: number): void {
    this.angleRemainders.clear();
    for (let m = 0; m < motorNum; m++) {
      for (let s = 0; s < stateNum; s++) {
        this.angleRemainders.set(`${m}_${s}`, 0.0);
      }
    }
  }

  /**
   * float 差分を蓄積し、整数デルタを返す (微小変動の取りこぼし防止)
   */
  public static addAndRoundCounts(motorIdx: number, stateIdx: number, countsFloat: number): number {
    const key = `${motorIdx}_${stateIdx}`;
    const rem = this.angleRemainders.get(key) ?? 0.0;
    const total = rem + countsFloat;
    let rounded = Math.round(total);

    if (rounded === 0 && Math.abs(countsFloat) > 0.0) {
      rounded = total > 0 ? 1 : -1;
    }

    const newRem = total - rounded;
    this.angleRemainders.set(key, newRem);
    return rounded;
  }

  public static clampServoAngle(angle: number, pwmMin: number = 0, pwmMax: number = 4095): number {
    let val = Math.max(0.0, Math.min(4095.0, Number(angle) || 0));
    if (pwmMin > 0) val = Math.max(pwmMin, val);
    if (pwmMax < 4095) val = Math.min(pwmMax, val);
    return val;
  }

  // --- CSV ファイルの読み書き ---

  /**
   * CSV 文字列のパース (Python 版の ConfigHandler.load_servo_angle_csv と完全互換)
   */
  public static parseServoAngleCSV(
    csvText: string,
    expectedMotorNum: number = -1,
    expectedStateNum: number = -1
  ): CSVParseResult {
    const lines = csvText
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l.length > 0);

    if (lines.length < 2) {
      return { success: false, servoAngle: [], motorNum: 0, stateNum: 0, errorMessage: 'CSVデータが短すぎます。' };
    }

    // 1行目: ヘッダー
    const headerCols = lines[0].split(',').map(c => c.trim());
    if (headerCols[0] !== 'Motor_Num' || headerCols[1] !== 'State_Num') {
      return { success: false, servoAngle: [], motorNum: 0, stateNum: 0, errorMessage: "ヘッダーが 'Motor_Num,State_Num' ではありません。" };
    }

    // 2行目: 次元の指定
    const dimCols = lines[1].split(',').map(c => c.trim());
    const motorNum = parseInt(dimCols[0], 10);
    const stateNum = parseInt(dimCols[1], 10);

    if (isNaN(motorNum) || isNaN(stateNum) || motorNum <= 0 || stateNum <= 0) {
      return { success: false, servoAngle: [], motorNum: 0, stateNum: 0, errorMessage: '無効なモーター数またはステート数です。' };
    }

    if (expectedMotorNum > 0 && motorNum !== expectedMotorNum) {
      return { success: false, servoAngle: [], motorNum: 0, stateNum: 0, errorMessage: `モーター数が一致しません (期待: ${expectedMotorNum}, 実際: ${motorNum})。` };
    }

    if (expectedStateNum > 0 && stateNum !== expectedStateNum) {
      return { success: false, servoAngle: [], motorNum: 0, stateNum: 0, errorMessage: `ステート数が一致しません (期待: ${expectedStateNum}, 実際: ${stateNum})。` };
    }

    // 3行目以降: データ行
    const servoAngle: number[][] = [];
    const dataLines = lines.slice(2);

    for (let r = 0; r < motorNum; r++) {
      if (r >= dataLines.length) {
        return { success: false, servoAngle: [], motorNum: 0, stateNum: 0, errorMessage: `データ行が不足しています (必要: ${motorNum}行, 実際: ${dataLines.length}行)。` };
      }

      const cols = dataLines[r].split(',').map(c => c.trim());
      if (cols.length < stateNum) {
        return { success: false, servoAngle: [], motorNum: 0, stateNum: 0, errorMessage: `${r + 1}行目の列数が不足しています。` };
      }

      const rowAngles: number[] = [];
      for (let s = 0; s < stateNum; s++) {
        const val = parseInt(cols[s], 10);
        if (isNaN(val)) {
          return { success: false, servoAngle: [], motorNum: 0, stateNum: 0, errorMessage: `${r + 1}行${s + 1}列目の数値パースに失敗しました。` };
        }
        rowAngles.push(val);
      }
      servoAngle.push(rowAngles);
    }

    this.initRemainders(motorNum, stateNum);

    return {
      success: true,
      servoAngle,
      motorNum,
      stateNum
    };
  }

  /**
   * 角度データ配列から CSV 文字列を生成
   */
  public static generateServoAngleCSV(servoAngle: number[][], motorNum: number, stateNum: number): string {
    const lines: string[] = [];
    lines.push('Motor_Num,State_Num');
    lines.push(`${motorNum},${stateNum}`);

    for (let m = 0; m < motorNum; m++) {
      const row = servoAngle[m] ? servoAngle[m].slice(0, stateNum) : [];
      const rowStr = row.map(v => Math.round(Number(v) || 0)).join(',');
      lines.push(rowStr);
    }

    return lines.join('\r\n') + '\r\n';
  }

  // --- ローカルファイルの直接読み書き (File System Access API) ---

  /**
   * ファイルピッカーを開いて CSV を読み込み、ファイルハンドルごと保持する
   */
  public static async pickAndReadCSV(): Promise<{ filename: string; content: string; handle: any } | null> {
    if ('showOpenFilePicker' in window) {
      try {
        const [handle] = await (window as any).showOpenFilePicker({
          types: [{
            description: 'CSV Files',
            accept: { 'text/csv': ['.csv'] }
          }],
          multiple: false
        });
        const file = await handle.getFile();
        const content = await file.text();
        return { filename: file.name, content, handle };
      } catch (err: any) {
        if (err.name === 'AbortError') return null;
      }
    }

    return new Promise(resolve => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.csv';
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) {
          resolve(null);
          return;
        }
        const reader = new FileReader();
        reader.onload = e => {
          resolve({
            filename: file.name,
            content: (e.target?.result as string) || '',
            handle: null
          });
        };
        reader.onerror = () => resolve(null);
        reader.readAsText(file, 'utf-8');
      };
      input.click();
    });
  }

  /**
   * 指定したファイルハンドル、または新規選択したファイルへ直接上書き保存する
   */
  public static async saveOrOverwriteCSV(
    suggestedFilename: string,
    csvContent: string,
    existingHandle?: any
  ): Promise<{ success: boolean; handle: any }> {
    if ('showSaveFilePicker' in window) {
      try {
        let handle = existingHandle;

        if (!handle) {
          handle = await (window as any).showSaveFilePicker({
            suggestedName: suggestedFilename,
            types: [{
              description: 'CSV Files',
              accept: { 'text/csv': ['.csv'] }
            }]
          });
        }

        const writable = await handle.createWritable();
        await writable.write(csvContent);
        await writable.close();

        return { success: true, handle };
      } catch (err: any) {
        if (err.name === 'AbortError') return { success: false, handle: existingHandle };
        console.warn('File System Access API failed, fallback to download:', err);
      }
    }

    this.downloadCSV(suggestedFilename, csvContent);
    return { success: true, handle: null };
  }

  /**
   * フォールバック用: 従来のダウンロード保存
   */
  public static downloadCSV(filename: string, csvContent: string): void {
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }
}