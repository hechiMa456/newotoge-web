import React, { useState, useEffect } from 'react';
import { CalibrationSerialManager, CalibrationDeviceInfo } from '../../engine/calibration/CalibrationSerialManager';
import { CalibrationCore } from '../../engine/calibration/CalibrationCore';

const serialMgr = new CalibrationSerialManager();

// =====================================================
// newotoge-web 統一カラーパレット
// =====================================================
const APP_BG = '#0A0E1A';               // アプリ標準の最深背景色
const HEADER_BG = '#141D34';            // トランスポートバーと同系統のディープネイビー
const HEADER_BORDER = '#243254';        // UI区切り線ボーダー
const GRID_HEADER_BG = '#121727';       // テーブルヘッダーのトーン

const ROW_BG_EVEN = '#141622';          // トラックカード（無効時）と同等のダークスレート
const ROW_BG_ODD = '#181B2D';           // トラックカード（有効時）と同等のネイビー
const CELL_BG_EVEN = '#1B1E30';         // セル背景（偶数）
const CELL_BG_ODD = '#21253B';          // セル背景（奇数）
const BORDER_SUBTLE = '#191f33';        // 繊細な境界線

const TEXT_MAIN = '#E2EFFF';            // メインテキスト
const TEXT_MUTED = '#8FA4C4';           // サブテキスト・単位ラベル
const TEXT_ACCENT_BLUE = '#A4D3FF';     // 強調ブルー

const ACCENT_GREEN = '#9bc4dc';         // アクティブ/ニュートラル発光色
const ACCENT_GREEN_TEXT = '#0B2314';    // グリーン背景上の文字色
const ACCENT_GOLD = '#DBB28A';          // D-Ch用の上品なゴールド/ベージュ
const BTN_PRIMARY = '#5D7FAF';          // 標準ボタンのダスティブルー
const BTN_DANGER = '#BD425B';           // 切断・警告用のスレートレッド

// newotoge-web の世界観に調和させた段階ボタン（減算：スレートブルー / 加算：ローズレッド）
const DEC_COLORS = ['#234B73', '#2C5D8F', '#3772AD']; // -20, -5, -1
const INC_COLORS = ['#6E2B38', '#8A3546', '#A84156']; // +1, +5, +20

const STORAGE_KEY_MAX_NO = 'otoge_calibration_max_no_map';

// MCU_NAME に紐づく Max No. を取得（未登録時は 16）
const loadSavedMaxNo = (mcuName: string | undefined): number => {
  if (!mcuName || mcuName === '----') return 16;
  try {
    const raw = localStorage.getItem(STORAGE_KEY_MAX_NO);
    if (!raw) return 16;
    const map = JSON.parse(raw);
    const val = Number(map[mcuName]);
    return !isNaN(val) && val >= 1 ? val : 16;
  } catch {
    return 16;
  }
};

// MCU_NAME に紐づけて Max No. を保存
const saveMaxNoForMcu = (mcuName: string | undefined, value: number): void => {
  if (!mcuName || mcuName === '----') return;
  try {
    const raw = localStorage.getItem(STORAGE_KEY_MAX_NO);
    const map = raw ? JSON.parse(raw) : {};
    map[mcuName] = value;
    localStorage.setItem(STORAGE_KEY_MAX_NO, JSON.stringify(map));
  } catch {
    /* no-op */
  }
};

export const CalibrationView: React.FC = () => {
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [deviceInfo, setDeviceInfo] = useState<CalibrationDeviceInfo | null>(null);
  const [servoAngle, setServoAngle] = useState<number[][]>([]);
  const [motorNum, setMotorNum] = useState<number>(0);
  const [stateNum, setStateNum] = useState<number>(0);
  const [stateCountPerMotor, setStateCountPerMotor] = useState<number[]>([]);
  const [maxNo, setMaxNo] = useState<number>(16);

  const [highlightedStates, setHighlightedStates] = useState<Record<number, number>>({});
  const [statusText, setStatusText] = useState<string>('Ready');
  const [statusColor, setStatusColor] = useState<string>(ACCENT_GREEN);

  const [editingCell, setEditingCell] = useState<{ motorIdx: number; stateIdx: number } | null>(null);
  const [editValue, setEditValue] = useState<string>('');
  const [isEditingMaxNo, setIsEditingMaxNo] = useState<boolean>(false);
  const [maxNoInput, setMaxNoInput] = useState<string>('16');
  const [currentFileHandle, setCurrentFileHandle] = useState<any>(null);

  // ★ タブから離れた（アンマウントされた）時にシリアルポートを確実に切断・解放する
  useEffect(() => {
    return () => {
      serialMgr.disconnect();
    };
  }, []);

  // --- 接続 / 切断 ---

  const handleConnectToggle = async () => {
    if (isConnected) {
      await serialMgr.disconnect();
      setIsConnected(false);
      setDeviceInfo(null);
      setServoAngle([]);
      setMotorNum(0);
      setStateNum(0);
      // ★ 切断時はデフォルト 16 にリセット
      setMaxNo(16);
      setMaxNoInput('16');
      setStatusText('Disconnected');
      setStatusColor(BTN_DANGER);
      return;
    }

    setStatusText('Connecting...');
    setStatusColor(ACCENT_GOLD);

    const ok = await serialMgr.connect();
    if (!ok) {
      setStatusText('Connection Failed');
      setStatusColor(BTN_DANGER);
      return;
    }

    setStatusText('Handshaking...');
    const info = await serialMgr.handshake();
    if (info) {
      setIsConnected(true);
      setDeviceInfo(info);

      // ★ MCU_NAME に紐づく保存済みの Max No. を自動適用
      const restoredMaxNo = loadSavedMaxNo(info.aliasName);
      setMaxNo(restoredMaxNo);
      setMaxNoInput(String(restoredMaxNo));

      setStatusText('Connected');
      setStatusColor(ACCENT_GREEN);
    } else {
      await serialMgr.disconnect();
      setIsConnected(false);
      setStatusText('Handshake Failed');
      setStatusColor(BTN_DANGER);
    }
  };

  // Max No. 入力確定 & 自動保存
  const handleCommitMaxNo = (inputStr: string) => {
    const n = parseInt(inputStr.trim(), 10);
    const upperBound = motorNum > 0 ? motorNum : 16;

    if (!isNaN(n) && n >= 1 && n <= upperBound) {
      setMaxNo(n);
      setMaxNoInput(String(n));
      // ★ 現在接続中の MCU_NAME と紐づけて保存
      if (deviceInfo?.aliasName) {
        saveMaxNoForMcu(deviceInfo.aliasName, n);
      }
    } else {
      setMaxNoInput(String(maxNo));
    }
    setIsEditingMaxNo(false);
  };

  // --- コマンド実行 (Load, Write, Restore, Reset) ---

  const handleAngleLoad = async () => {
    if (!isConnected) return;
    setStatusText('Loading from microcontroller...');
    setStatusColor(ACCENT_GOLD);

    const result = await serialMgr.loadServoAngles();
    if (result.success) {
      setServoAngle(result.servoAngle);
      setMotorNum(result.motorNum);
      setStateNum(result.stateNum);
      setStateCountPerMotor(result.stateCountPerMotor);
      CalibrationCore.initRemainders(result.motorNum, result.stateNum);
      setHighlightedStates({});
      setStatusText('Load complete');
      setStatusColor(ACCENT_GREEN);
    } else {
      setStatusText('Load failed');
      setStatusColor(BTN_DANGER);
      alert('マイコンからの角度データ読み込みに失敗しました。');
    }
  };

  const handleAngleWrite = async () => {
    if (!isConnected || motorNum === 0) {
      alert('操作の前に「Load」が必要です。');
      return;
    }

    const alias = deviceInfo?.aliasName && deviceInfo.aliasName !== '----' ? deviceInfo.aliasName : 'Backup_ServoAngle';
    const filename = `${alias}.csv`;

    const confirmMsg = currentFileHandle
      ? `角度データをマイコンに書き込み、ファイル「${filename}」に直接上書き保存しますか？`
      : '角度データをマイコンに書き込み、CSVファイルに保存しますか？';

    if (!window.confirm(confirmMsg)) return;

    setStatusText('Writing to microcontroller...');
    setStatusColor(ACCENT_GOLD);

    const ok = await serialMgr.writeServoAnglesToFile();
    if (ok) {
      const csvStr = CalibrationCore.generateServoAngleCSV(servoAngle, motorNum, stateNum);
      
      // ★ 記憶しているファイルハンドルへ直接上書き（未選択ならダイアログで指定）
      const saveResult = await CalibrationCore.saveOrOverwriteCSV(filename, csvStr, currentFileHandle);
      if (saveResult.handle) {
        setCurrentFileHandle(saveResult.handle);
      }

      setStatusText('Write & CSV Overwrite complete');
      setStatusColor(ACCENT_GREEN);
    } else {
      setStatusText('Write failed');
      setStatusColor(BTN_DANGER);
      alert('マイコンへの角度データ保存に失敗しました。');
    }
  };

  const handleAngleRestore = async () => {
    if (!isConnected || motorNum === 0) {
      alert('操作の前に「Load」が必要です。');
      return;
    }

    const file = await CalibrationCore.pickAndReadCSV();
    if (!file) return;

    const parsed = CalibrationCore.parseServoAngleCSV(file.content, motorNum, stateNum);
    if (!parsed.success) {
      alert(`CSVの復元に失敗しました: ${parsed.errorMessage}`);
      return;
    }

    // ★ 開いたファイルハンドルを記憶しておく
    if (file.handle) {
      setCurrentFileHandle(file.handle);
    }

    setStatusText('Restoring to RAM...');
    setStatusColor(TEXT_ACCENT_BLUE);

    const restoreOk = await serialMgr.restoreServoAngles(parsed.servoAngle, stateCountPerMotor);
    if (restoreOk) {
      await serialMgr.writeServoAnglesToFile();
      setServoAngle(parsed.servoAngle);
      setStatusText(`Restore & Save complete (${file.filename})`);
      setStatusColor(ACCENT_GREEN);
    } else {
      setStatusText('Restore failed');
      setStatusColor(BTN_DANGER);
      alert('マイコンへの角度復元に失敗しました。');
    }
  };

  const handleAngleReset = async () => {
    if (!isConnected || motorNum === 0) {
      alert('操作の前に「Load」が必要です。');
      return;
    }

    if (!window.confirm('初期値で上書きしてもよいですか？現在編集中のデータは削除されます。')) return;

    setStatusText('Resetting...');
    setStatusColor(ACCENT_GOLD);

    const ok = await serialMgr.resetServoAngles();
    if (ok) {
      setStatusText('Reset complete. Please reload.');
      setStatusColor(ACCENT_GREEN);
      setServoAngle([]);
      setMotorNum(0);
      setStateNum(0);
    } else {
      setStatusText('Reset failed');
      setStatusColor(BTN_DANGER);
      alert('角度データの初期化に失敗しました。');
    }
  };

  // --- 角度操作・リアルタイム送信 ---

  const handleAdjustAngle = async (motorIdx: number, stateIdx: number, multiplier: number) => {
    const pwmHz = deviceInfo?.pwmFrequencyHz ?? 50.0;
    const fractionalCounts = CalibrationCore.getServoAdjustmentCounts(multiplier, pwmHz);
    const delta = CalibrationCore.addAndRoundCounts(motorIdx, stateIdx, fractionalCounts);

    const currentVal = servoAngle[motorIdx]?.[stateIdx] ?? 0;
    const clamped = CalibrationCore.clampServoAngle(
      currentVal + delta,
      deviceInfo?.pwmMin ?? 0,
      deviceInfo?.pwmMax ?? 4095
    );

    const updated = servoAngle.map((row, m) =>
      m === motorIdx ? row.map((v, s) => (s === stateIdx ? clamped : v)) : row
    );
    setServoAngle(updated);
    setHighlightedStates(prev => ({ ...prev, [motorIdx]: stateIdx }));

    serialMgr.sendServoAngleRealtime(motorIdx, stateIdx, clamped);
  };

  const handleAngleCellClick = (motorIdx: number, stateIdx: number) => {
    setHighlightedStates(prev => ({ ...prev, [motorIdx]: stateIdx }));
    const angle = servoAngle[motorIdx]?.[stateIdx] ?? 0;
    serialMgr.sendServoAngleRealtime(motorIdx, stateIdx, angle);
  };

  const handleCommitValueEdit = () => {
    if (!editingCell) return;
    const { motorIdx, stateIdx } = editingCell;
    const val = parseInt(editValue.trim(), 10);

    if (isNaN(val) || val < 0 || val > 4095) {
      alert('0 〜 4095 の範囲で整数を入力してください。');
      return;
    }

    const clamped = CalibrationCore.clampServoAngle(
      val,
      deviceInfo?.pwmMin ?? 0,
      deviceInfo?.pwmMax ?? 4095
    );

    const updated = servoAngle.map((row, m) =>
      m === motorIdx ? row.map((v, s) => (s === stateIdx ? clamped : v)) : row
    );
    setServoAngle(updated);
    setHighlightedStates(prev => ({ ...prev, [motorIdx]: stateIdx }));
    setEditingCell(null);

    serialMgr.sendServoAngleRealtime(motorIdx, stateIdx, clamped);
  };

  const handleNeutralClick = (motorIdx: number) => {
    const pwmHz = deviceInfo?.pwmFrequencyHz ?? 50.0;
    const neutralCount = CalibrationCore.calculateNeutralPwmCount(pwmHz);
    const neutralStateIdx = stateCountPerMotor[motorIdx] ?? stateNum;

    setHighlightedStates(prev => ({ ...prev, [motorIdx]: neutralStateIdx }));
    serialMgr.sendServoAngleRealtime(motorIdx, neutralStateIdx, neutralCount);
  };

  const handleDChClick = (motorIdx: number) => {
    const count = stateCountPerMotor[motorIdx] ?? stateNum;
    if (count <= 0) return;

    const current = highlightedStates[motorIdx] ?? -1;
    const nextState = current < 0 ? 0 : (current + 1) % count;

    setHighlightedStates(prev => ({ ...prev, [motorIdx]: nextState }));
    const angle = servoAngle[motorIdx]?.[nextState] ?? 0;
    serialMgr.sendServoAngleRealtime(motorIdx, nextState, angle);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', background: APP_BG, color: TEXT_MAIN, userSelect: 'none' }}>
      {/* 1. 上部コントロールバー */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          height: 72,
          background: HEADER_BG,
          padding: '0 20px',
          gap: 16,
          borderBottom: `1px solid ${HEADER_BORDER}`
        }}
      >
        {/* ポート・接続ステータス */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 140 }}>
          <div style={{ fontSize: 14, fontWeight: 'bold', color: TEXT_MAIN }}>
            InstID: <span style={{ color: TEXT_ACCENT_BLUE }}>{deviceInfo ? deviceInfo.instId : '-'}</span>
          </div>
          <button
            type="button"
            onClick={handleConnectToggle}
            style={{
              marginTop: 4,
              padding: '4px 12px',
              background: isConnected ? BTN_DANGER : BTN_PRIMARY,
              color: '#FFF',
              border: 'none',
              borderRadius: 6,
              fontWeight: 'bold',
              cursor: 'pointer',
              fontSize: 12,
              boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
              transition: 'background 0.15s'
            }}
          >
            {isConnected ? 'Disconnect' : 'Connect COM'}
          </button>
        </div>

        <div style={{ width: 1, height: 36, background: HEADER_BORDER }} />

        {/* コマンドボタン群 */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div style={{ fontSize: 13, fontWeight: 'bold', color: TEXT_MUTED }}>
            MCU NAME: <span style={{ color: TEXT_MAIN }}>{deviceInfo ? deviceInfo.aliasName : '----'}</span>
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            {(['Reset', 'Load', 'Write', 'Restore'] as const).map(action => (
              <button
                key={action}
                type="button"
                onClick={() => {
                  if (action === 'Reset') handleAngleReset();
                  if (action === 'Load') handleAngleLoad();
                  if (action === 'Write') handleAngleWrite();
                  if (action === 'Restore') handleAngleRestore();
                }}
                disabled={!isConnected}
                style={{
                  padding: '5px 12px',
                  background: isConnected ? '#1C2742' : '#141A28',
                  color: isConnected ? TEXT_MAIN : '#4F5B75',
                  border: `1px solid ${isConnected ? HEADER_BORDER : 'transparent'}`,
                  borderRadius: 6,
                  fontWeight: 'bold',
                  fontSize: 12,
                  cursor: isConnected ? 'pointer' : 'not-allowed',
                  transition: 'background 0.15s, border-color 0.15s'
                }}
              >
                {action}
              </button>
            ))}
          </div>
        </div>

        <div style={{ width: 1, height: 36, background: HEADER_BORDER }} />

        {/* Max No. 設定 */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 75 }}>
          <div style={{ fontSize: 12, fontWeight: 'bold', color: TEXT_MUTED }}>Max No.</div>
          {isEditingMaxNo ? (
            <input
              type="number"
              value={maxNoInput}
              autoFocus
              onChange={e => setMaxNoInput(e.target.value)}
              onBlur={() => handleCommitMaxNo(maxNoInput)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleCommitMaxNo(maxNoInput);
                if (e.key === 'Escape') {
                  setMaxNoInput(String(maxNo));
                  setIsEditingMaxNo(false);
                }
              }}
              style={{
                width: 54,
                height: 24,
                background: '#0D1322',
                color: '#FFF',
                textAlign: 'center',
                borderRadius: 4,
                border: `1px solid ${TEXT_ACCENT_BLUE}`,
                marginTop: 4,
                fontSize: 12,
                outline: 'none'
              }}
            />
          ) : (
            <div
              onClick={() => {
                setMaxNoInput(String(maxNo));
                setIsEditingMaxNo(true);
              }}
              title="クリックして最大表示番号を変更"
              style={{
                width: 54,
                height: 24,
                lineHeight: '24px',
                textAlign: 'center',
                background: '#1C2742',
                border: `1px solid ${HEADER_BORDER}`,
                borderRadius: 4,
                fontWeight: 'bold',
                fontSize: 13,
                cursor: 'pointer',
                marginTop: 4
              }}
            >
              {maxNo}
            </div>
          )}
        </div>

        <div style={{ width: 1, height: 36, background: HEADER_BORDER }} />

        {/* PWM周波数表示 */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 75 }}>
          <div style={{ fontSize: 12, fontWeight: 'bold', color: TEXT_MUTED }}>PWM[Hz]</div>
          <div
            style={{
              width: 54,
              height: 24,
              lineHeight: '24px',
              textAlign: 'center',
              background: '#1C2742',
              border: `1px solid ${HEADER_BORDER}`,
              borderRadius: 4,
              fontWeight: 'bold',
              fontSize: 13,
              marginTop: 4
            }}
          >
            {deviceInfo ? Math.round(deviceInfo.pwmFrequencyHz) : 50}
          </div>
        </div>

        <div style={{ width: 1, height: 36, background: HEADER_BORDER }} />

        {/* ステータスメッセージ */}
        <div style={{ flex: 1, fontSize: 13, fontWeight: 'bold', color: statusColor, textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
          {statusText}
        </div>
      </div>

      {/* 2. グリッドテーブル見出し */}
      {motorNum > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            height: 34,
            background: GRID_HEADER_BG,
            padding: '0 20px',
            fontSize: 13,
            fontWeight: 'bold',
            color: TEXT_MUTED,
            borderBottom: `1px solid ${HEADER_BORDER}`
          }}
        >
          <div style={{ width: 56, textAlign: 'center' }}>No.</div>
          <div style={{ width: 68, textAlign: 'center', marginLeft: 8 }}>D-Ch</div>
          <div style={{ flex: 1, textAlign: 'center' }}>Servo States</div>
        </div>
      )}

      {/* 3. モーターグリッド一覧 */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 20px 30px 20px' }}>
        {motorNum === 0 ? (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', color: TEXT_MUTED, fontSize: 15 }}>
            {isConnected ? '「Load」ボタンを押してマイコンからデータを取得してください。' : 'COMポートを接続してください。'}
          </div>
        ) : (
          Array.from({ length: motorNum }, (_, visualIdx) => {
            const fretNum = (visualIdx % maxNo) + 1;
            if (fretNum > maxNo) return null;

            const motorIdx = visualIdx;
            const driverNum = Math.floor(motorIdx / 16);
            const channelNum = motorIdx % 16;
            const rowBg = visualIdx % 2 === 0 ? ROW_BG_EVEN : ROW_BG_ODD;

            const stateCount = stateCountPerMotor[motorIdx] ?? stateNum;
            const currentHighlight = highlightedStates[motorIdx] ?? -1;
            const isNeutralActive = currentHighlight === stateCount;

            return (
              <div
                key={motorIdx}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  background: rowBg,
                  padding: '6px 12px',
                  borderRadius: 6,
                  marginBottom: 6,
                  border: `1px solid ${BORDER_SUBTLE}`,
                  transition: 'background 0.15s'
                }}
              >
                {/* No. (ニュートラル送信ボタン) */}
                <div
                  onClick={() => handleNeutralClick(motorIdx)}
                  title="クリックで1.5msニュートラルパルスを送信"
                  style={{
                    width: 56,
                    height: 32,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: isNeutralActive ? ACCENT_GREEN : '#1C2742',
                    color: isNeutralActive ? ACCENT_GREEN_TEXT : ACCENT_GREEN,
                    border: `1px solid ${isNeutralActive ? ACCENT_GREEN : HEADER_BORDER}`,
                    borderRadius: 5,
                    fontWeight: 'bold',
                    fontSize: 14,
                    cursor: 'pointer',
                    marginRight: 8,
                    boxShadow: isNeutralActive ? '0 0 10px rgba(46, 204, 113, 0.4)' : 'none',
                    transition: 'all 0.15s'
                  }}
                >
                  {fretNum}
                </div>

                {/* D-Ch (ステート巡回ボタン) */}
                <div
                  onClick={() => handleDChClick(motorIdx)}
                  title="クリックでステートを順送り切り替え"
                  style={{
                    width: 68,
                    height: 32,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: '#1C2742',
                    color: ACCENT_GOLD,
                    border: `1px solid ${HEADER_BORDER}`,
                    borderRadius: 5,
                    fontWeight: 'bold',
                    fontSize: 14,
                    cursor: 'pointer',
                    marginRight: 14,
                    transition: 'border-color 0.15s'
                  }}
                >
                  {driverNum}-{channelNum}
                </div>

                {/* 各ステートのコントロールユニット */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, flex: 1 }}>
                  {Array.from({ length: stateCount }, (_, stateIdx) => {
                    const angle = servoAngle[motorIdx]?.[stateIdx] ?? 0;
                    const isCellActive = currentHighlight === stateIdx;
                    const isEditing = editingCell?.motorIdx === motorIdx && editingCell?.stateIdx === stateIdx;

                    return (
                      <div
                        key={stateIdx}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          height: 36,
                          background: visualIdx % 2 === 0 ? CELL_BG_EVEN : CELL_BG_ODD,
                          border: `1px solid ${isCellActive ? ACCENT_GREEN : BORDER_SUBTLE}`,
                          borderRadius: 5,
                          overflow: 'hidden',
                          boxShadow: isCellActive ? '0 0 8px rgba(46, 204, 113, 0.3)' : 'none',
                          transition: 'all 0.15s'
                        }}
                      >
                        {/* 減算ボタン群: -20, -5, -1 */}
                        {([-20, -5, -1] as const).map((mult, idx) => (
                          <button
                            key={mult}
                            type="button"
                            onClick={() => handleAdjustAngle(motorIdx, stateIdx, mult)}
                            style={{
                              flex: 1,
                              height: '100%',
                              background: DEC_COLORS[idx],
                              color: '#FFF',
                              border: 'none',
                              fontSize: 10,
                              fontWeight: 'bold',
                              cursor: 'pointer',
                              padding: 0,
                              opacity: 0.92,
                              transition: 'opacity 0.1s'
                            }}
                            onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
                            onMouseLeave={e => (e.currentTarget.style.opacity = '0.92')}
                          >
                            {mult === -20 ? '◀◀◀' : mult === -5 ? '◀◀' : '◀'}
                          </button>
                        ))}

                        {/* 中央: 角度表示 & 直接編集セル */}
                        <div
                          onClick={() => handleAngleCellClick(motorIdx, stateIdx)}
                          onDoubleClick={() => {
                            setEditingCell({ motorIdx, stateIdx });
                            setEditValue(String(angle));
                          }}
                          title="クリックで選択・送信、ダブルクリックで直接数値入力"
                          style={{
                            width: 62,
                            height: '100%',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'center',
                            background: isCellActive ? ACCENT_GREEN : 'transparent',
                            color: isCellActive ? ACCENT_GREEN_TEXT : TEXT_MAIN,
                            cursor: 'pointer'
                          }}
                        >
                          {isEditing ? (
                            <input
                              type="number"
                              value={editValue}
                              autoFocus
                              onChange={e => setEditValue(e.target.value)}
                              onBlur={handleCommitValueEdit}
                              onKeyDown={e => {
                                if (e.key === 'Enter') handleCommitValueEdit();
                                if (e.key === 'Escape') setEditingCell(null);
                              }}
                              style={{
                                width: '85%',
                                height: 24,
                                background: '#FFF',
                                color: '#000',
                                textAlign: 'center',
                                fontWeight: 'bold',
                                border: 'none',
                                borderRadius: 3,
                                outline: 'none',
                                fontSize: 12
                              }}
                            />
                          ) : (
                            <>
                              <span style={{ fontSize: 9, lineHeight: 1, color: isCellActive ? ACCENT_GREEN_TEXT : TEXT_MUTED }}>
                                S{stateIdx}
                              </span>
                              <span style={{ fontSize: 14, fontWeight: 'bold', lineHeight: 1.1 }}>
                                {angle}
                              </span>
                            </>
                          )}
                        </div>

                        {/* 加算ボタン群: +1, +5, +20 */}
                        {([1, 5, 20] as const).map((mult, idx) => (
                          <button
                            key={mult}
                            type="button"
                            onClick={() => handleAdjustAngle(motorIdx, stateIdx, mult)}
                            style={{
                              flex: 1,
                              height: '100%',
                              background: INC_COLORS[idx],
                              color: '#FFF',
                              border: 'none',
                              fontSize: 10,
                              fontWeight: 'bold',
                              cursor: 'pointer',
                              padding: 0,
                              opacity: 0.92,
                              transition: 'opacity 0.1s'
                            }}
                            onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
                            onMouseLeave={e => (e.currentTarget.style.opacity = '0.92')}
                          >
                            {mult === 1 ? '▶' : mult === 5 ? '▶▶' : '▶▶▶'}
                          </button>
                        ))}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};