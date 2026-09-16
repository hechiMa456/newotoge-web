import React, { useRef, useEffect, useState, useMemo } from 'react';
import { MidiSongData, MidiNote } from '../models/SongModels';
import { PlaybackEngine } from '../engine/audio/PlaybackEngine';



interface Props {
  song: MidiSongData | null;
  scrollSpeedPxPerMs?: number;
  isChromaKeyEnabled?: boolean;
  showGridLines?: boolean;
  showAllChannels?: boolean;
  showDebugHUD?: boolean;
}

// デフォルトのチャンネルカラー
export const DEFAULT_CHANNEL_COLORS = [
  '#FF4D4D', '#FF8533', '#FFC000', '#2ECC71',
  '#00D2D3', '#3498DB', '#9B59B6', '#E056FD',
  '#FF6B81', '#1DD1A1', '#F368E0', '#54A0FF',
  '#5F27CD', '#C8D6E5', '#FF9F43', '#10AC84'
];

// ノーツ色に白をブレンドして「光り輝くネオン色」を生成するヘルパー
function getHitLuminescentColor(hexColor: string): string {
  let r = 255, g = 255, b = 255;
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hexColor);
  if (match) {
    r = parseInt(match[1], 16);
    g = parseInt(match[2], 16);
    b = parseInt(match[3], 16);
  } else if (hexColor.startsWith('rgb')) {
    const nums = hexColor.match(/\d+/g);
    if (nums && nums.length >= 3) {
      r = Number(nums[0]);
      g = Number(nums[1]);
      b = Number(nums[2]);
    }
  }

  // 白 (255, 255, 255) を 65% ブレンドして元の色相を残したまま強烈に発光させる
  const blendR = Math.round(r * 0.35 + 255 * 0.65);
  const blendG = Math.round(g * 0.35 + 255 * 0.65);
  const blendB = Math.round(b * 0.35 + 255 * 0.65);
  return `rgb(${blendR}, ${blendG}, ${blendB})`;
}

// レーン内で統合描画される各チャンネル（親ChまたはサブCh）の情報
interface VisualizerSubTrack {
  channel: number;
  trackIndex?: number; // ★ この行を追加
  color: string;
  latencyOffsetMs: number;
}

interface VisualizerLane {
  id: string;
  title: string;
  presetId: number;
  isAssigned: boolean;
  color: string; // ヘッダーアンダーライン用の代表色
  subTracks: VisualizerSubTrack[];
  totalNoteCount: number;
}

// レーン情報の算出 (通常モード: 割り当て済み楽器のみ / 全Ch表示モード: Noneも含めた全貌表示)
function getRenderLanes(song: MidiSongData | null, showAllChannels: boolean): VisualizerLane[] {
  if (!song) return [];

  const grayColor = 'rgba(115, 115, 122, 0.45)';

  if (!showAllChannels) {
    // 【通常モード】楽器が割り当てられている（None ではない）スロットのみを抽出し、同一楽器ごとに統合
    const map = new Map<string, VisualizerLane>();

    for (const slot of song.slots) {
      // 無効化されているスロットはスキップ
      if (!slot.isEnabled) continue;

      const preset = slot.assignedPreset;
      const isAssigned = !!(preset && preset.id !== 0 && preset.mcuName !== 'None');

      // ★ バグ修正1: 送信先が None (未割当) のトラックは通常ビジュアライザーには表示しない
      if (!isAssigned) continue;

      // 対象トラックを取得してノート数をチェック
      const track = song.tracks?.find(t => t.trackIndex === slot.trackIndex);
      const noteCount = track ? track.notes.length : (song.channelCaches[slot.selectedChannel]?.noteCount ?? 0);
      if (noteCount === 0) continue;

      // 同一ポート/同一MCUごとにグループ化
      const groupKey = preset.endpointId ? `${preset.mcuName}_${preset.endpointId}` : preset.mcuName;
      const slotColor = slot.customColor || DEFAULT_CHANNEL_COLORS[(slot.trackIndex ?? slot.selectedChannel) % 16];

      if (!map.has(groupKey)) {
        map.set(groupKey, {
          id: groupKey,
          title: preset.name,
          presetId: preset.id,
          isAssigned: true,
          color: slotColor,
          subTracks: [],
          totalNoteCount: 0
        });
      }

      const lane = map.get(groupKey)!;
      lane.subTracks.push({
        channel: slot.selectedChannel,
        trackIndex: slot.trackIndex,
        color: slotColor,
        latencyOffsetMs: slot.latencyOffsetMs || 0
      });
      lane.totalNoteCount += noteCount;
    }

    return Array.from(map.values());
  } else {
    // 【全Ch表示（全トラックデバッグ）モード】
    // 存在する全トラックを並べる。楽器割当済みは独自色＆楽器名、None はグレー＆「None」表記
    const tracksToDisplay = (song.tracks && song.tracks.length > 0) ? song.tracks : [];

    return tracksToDisplay
      .filter(tr => tr.notes.length > 0)
      .map((tr, idx) => {
        const slot = song.slots.find(s => s.trackIndex === tr.trackIndex);
        const isAssigned = !!(
          slot &&
          slot.isEnabled &&
          slot.assignedPreset &&
          slot.assignedPreset.id !== 0 &&
          slot.assignedPreset.mcuName !== 'None'
        );

        // ★ バグ修正2: 割当済みなら楽器名と設定色、未割当(None)なら「None」とグレー色を適用
        const laneTitle = isAssigned && slot ? `${slot.assignedPreset.name} (${tr.name})` : `None (${tr.name})`;
        const laneColor = isAssigned && slot
          ? (slot.customColor || DEFAULT_CHANNEL_COLORS[idx % 16])
          : grayColor;

        return {
          id: `tr_${tr.trackIndex}`,
          title: laneTitle,
          presetId: isAssigned && slot ? slot.assignedPreset.id : 0,
          isAssigned,
          color: laneColor,
          subTracks: [{
            channel: tr.notes[0]?.channel ?? 0,
            trackIndex: tr.trackIndex,
            color: laneColor,
            latencyOffsetMs: isAssigned && slot ? (slot.latencyOffsetMs || 0) : 0
          }],
          totalNoteCount: tr.notes.length
        };
      });
  }
}

export const CanvasVisualizer: React.FC<Props> = ({
  song,
  scrollSpeedPxPerMs = 0.20,
  isChromaKeyEnabled = false,
  showGridLines = true,
  showAllChannels = false,
  showDebugHUD = false
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hudRef = useRef<HTMLDivElement | null>(null); // ★ 追加: DOMを直接操作するref

  // ★ 修正: useMemo でメモ化し、50msごとの無駄な再生成・タイマーリセットを完全に防ぐ
  const lanes = useMemo(() => getRenderLanes(song, showAllChannels), [song, showAllChannels]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    let animId: number;
    let lastTime = performance.now();
    let frameCount = 0;
    let lastFpsUpdate = performance.now();

    const render = () => {
      const now = performance.now();
      const delta = now - lastTime;
      lastTime = now;
      frameCount++;

      if (now - lastFpsUpdate >= 500) {
        const fps = (frameCount * 1000) / (now - lastFpsUpdate);
        // ★ 修正: 直接テキストを書き込む (Reactの再描画を発生させない)
        if (hudRef.current) {
          hudRef.current.textContent = `FPS: ${fps.toFixed(1)} | Delta: ${delta.toFixed(1)}ms`;
        }
        frameCount = 0;
        lastFpsUpdate = now;
      }

      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = width * dpr;
        canvas.height = height * dpr;
      }
      ctx.save();
      ctx.scale(dpr, dpr);

      // 背景クリア（通常: #0A0E1A / クロマキー: #00FF00）
      ctx.fillStyle = isChromaKeyEnabled ? '#00FF00' : '#0A0E1A';
      ctx.fillRect(0, 0, width, height);

      if (!song || lanes.length === 0) {
        ctx.restore();
        animId = requestAnimationFrame(render);
        return;
      }

      const engine = PlaybackEngine.getInstance();
      const currentMs = engine.getCurrentPlaybackMs();
      const { isPrerolling, targetMs } = engine.getPrerollInfo();
      const judgeLineY = height * 0.8;
      const speed = scrollSpeedPxPerMs;
      const laneWidth = width / lanes.length;

      // 1. 小節/拍グリッド線
      if (showGridLines && song.beatEvents.length > 0) {
        const topMs = currentMs - (height - judgeLineY) / speed;
        const bottomMs = currentMs + judgeLineY / speed;

        for (const beat of song.beatEvents) {
          if (beat.timeMs < topMs) continue;
          if (beat.timeMs > bottomMs) break;

          const diffMs = beat.timeMs - currentMs;
          const y = Math.round(judgeLineY - diffMs * speed);

          ctx.lineWidth = beat.isAccent ? 2 : 1;
          ctx.strokeStyle = beat.isAccent
            ? (isChromaKeyEnabled ? 'rgba(0, 0, 0, 0.6)' : 'rgba(255, 255, 255, 0.4)')
            : (isChromaKeyEnabled ? 'rgba(0, 0, 0, 0.25)' : 'rgba(255, 255, 255, 0.15)');

          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(width, y);
          ctx.stroke();
        }
      }

      // 2. レーン境界線
      ctx.strokeStyle = isChromaKeyEnabled ? 'rgba(0, 0, 0, 0.3)' : 'rgba(36, 59, 84, 0.7)';
      ctx.lineWidth = 1.5;
      for (let i = 1; i < lanes.length; i++) {
        const x = i * laneWidth;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }

      // 4. 判定ライン  ← ★ このブロックを丸ごと切り取り（削除）
      if (!isChromaKeyEnabled) {
        ctx.fillStyle = 'rgba(126, 202, 220, 0.35)';
        ctx.fillRect(0, judgeLineY - 2, width, 6);
      }
      ctx.fillStyle = isChromaKeyEnabled ? '#101F33' : 'rgba(255, 255, 255, 0.85)';
      ctx.fillRect(0, judgeLineY, width, 3.0);

      // 3. ノーツ描画 (音ゲー風ネオン発光 ＋ インパクト演出)
      const topMs = currentMs - (height - judgeLineY) / speed - 50;
      const bottomMs = currentMs + judgeLineY / speed + 50;

      for (let i = 0; i < lanes.length; i++) {
        const lane = lanes[i];
        if (lane.totalNoteCount === 0) continue;

        // この親レーンに属する全チャンネルの音域（minPitch, maxPitch）を統合算出
        let minP = 127;
        let maxP = 0;
        let hasNotes = false;

        for (const st of lane.subTracks) {
          const cache = song.channelCaches[st.channel];
          if (cache && cache.noteCount > 0) {
            minP = Math.min(minP, cache.minPitch);
            maxP = Math.max(maxP, cache.maxPitch);
            hasNotes = true;
          }
        }

        if (!hasNotes) continue;

        const pitchRange = Math.max(1, maxP - minP);
        const laneX = i * laneWidth;
        const stepX = (laneWidth - 16) / pitchRange;
        const baseNoteWidth = Math.max(6, Math.min(stepX - 1.5, 28));

        // 親チャンネル ＋ サブチャンネルのノーツを同一レーン内に重ねて描画
        for (const st of lane.subTracks) {
          const offsetMs = st.latencyOffsetMs;
          const effectiveTopMs = topMs - offsetMs;
          const effectiveBottomMs = bottomMs - offsetMs;

          // ★ 修正: trackIndex を優先し、該当トラックのノーツ「のみ」を厳密に取得
          let allNotes: MidiNote[] = [];
          if (typeof st.trackIndex === 'number' && song.tracks) {
            const targetTrack = song.tracks.find(t => t.trackIndex === st.trackIndex);
            if (targetTrack) {
              allNotes = targetTrack.notes;
            }
          }

          // トラックが見つからない旧フォーマット（Format 0）の場合のみチャンネルキャッシュを参照
          if (allNotes.length === 0 && (!song.tracks || song.tracks.length <= 1)) {
            const cache = song.channelCaches[st.channel];
            if (cache) allNotes = cache.notes;
          }

          if (allNotes.length === 0) continue;

          // 表示範囲内のノーツをフィルタリング
          const visibleNotes = allNotes.filter(
            n => n.endTimeMs >= effectiveTopMs && n.startTimeMs <= effectiveBottomMs
          );
          const hitLuminescentColor = getHitLuminescentColor(st.color);

          for (const note of visibleNotes) {
            const noteStartWithOffset = note.startTimeMs + offsetMs;
            const noteEndWithOffset = note.endTimeMs + offsetMs;

            const yBottom = judgeLineY - (noteStartWithOffset - currentMs) * speed;
            const yTop = judgeLineY - (noteEndWithOffset - currentMs) * speed;
            const noteHeight = Math.max(4, yBottom - yTop);

            const p = Math.min(Math.max(note.pitch, minP), maxP);
            const innerX = 8 + (p - minP) * stepX;

            const isHit = currentMs >= noteStartWithOffset && currentMs <= noteEndWithOffset;

            // ヒット時は横幅を広げてインパクトを表現（+2px）
            const currentWidth = isHit ? baseNoteWidth + 2 : baseNoteWidth;
            const x = Math.round(laneX + innerX - currentWidth / 2);

            // 音ゲー風ネオングロー
            if (isHit && !isChromaKeyEnabled) {
              ctx.shadowColor = st.color;
              ctx.shadowBlur = 15;
            } else {
              ctx.shadowBlur = 0;
            }

            // ★ プリロール中のノーツは薄くするが、ヒット中（!isHit）のノーツは 100% の輝度で発光させる
          // ★ 再生開始時点（targetMs）で判定ラインに触れている／跨いでいるノーツかどうか
            const isTouchingAtStart = noteStartWithOffset <= targetMs && noteEndWithOffset >= targetMs;

            // プリロール中のノーツは薄暗くするが、「再生開始時に判定ラインに触れているノーツ」は通常通りの色（透過度1.0）で降らせる
            const isPrerollNote = isPrerolling && (noteStartWithOffset < targetMs) && !isTouchingAtStart;
            ctx.globalAlpha = isPrerollNote ? 0.30 : 1.0;

          // ① ノーツ本体の塗り
          ctx.fillStyle = isHit ? hitLuminescentColor : st.color;
          ctx.beginPath();
          ctx.roundRect(x, yTop, currentWidth, noteHeight, 2.5);
          ctx.fill();

            // ② 境界線・輪郭
            ctx.strokeStyle = isChromaKeyEnabled
              ? (isHit ? '#FFFFFF' : 'rgba(0, 0, 0, 0.5)')
              : (isHit ? '#FFFFFF' : 'rgba(10, 14, 26, 0.75)');
            ctx.lineWidth = isHit ? 1.5 : 1.2;
            ctx.stroke();

            ctx.globalAlpha = 1.0; // リセット

            ctx.shadowBlur = 0;
          }
        }
      }

      // ★ プリロール中のみ、本編が始まる位置にマーカー線を描画
      if (isPrerolling && targetMs > currentMs) {
        const targetY = Math.round(judgeLineY - (targetMs - currentMs) * speed);
        if (targetY >= 0 && targetY <= height) {
          ctx.save();
          ctx.strokeStyle = '#A4D3FF';
          ctx.lineWidth = 2;
          ctx.setLineDash([6, 4]); // 破線
          ctx.beginPath();
          ctx.moveTo(0, targetY);
          ctx.lineTo(width, targetY);
          ctx.stroke();

          // 右端に「START」と小さくラベル表示
          ctx.fillStyle = '#A4D3FF';
          ctx.font = 'bold 10px monospace';
          //ctx.fillText('PLAYBACK START', width - 110, targetY - 5);
          ctx.restore();
        }
      }

      
      ctx.restore();
      animId = requestAnimationFrame(render);
    };

    animId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animId);
  }, [song, lanes, scrollSpeedPxPerMs, isChromaKeyEnabled, showGridLines]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', overflow: 'hidden' }}>
      {/* 1. 各親レーンの上部ヘッダーバー */}
      {lanes.length > 0 && (
        <div
          style={{
            display: 'flex',
            width: '100%',
            height: 30,
            flexShrink: 0,
            borderBottom: '1px solid #36485E',
            background: isChromaKeyEnabled ? '#CBD7E6' : '#36485E'
          }}
        >
          {lanes.map((lane, index) => (
            <div
              key={`${lane.id}_${index}`}
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderLeft: index > 0 ? (isChromaKeyEnabled ? '1px solid rgba(0,0,0,0.2)' : '1px solid #243B54') : 'none',
                position: 'relative',
                overflow: 'hidden',
                padding: '0 6px'
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 'bold',
                  color: isChromaKeyEnabled
                    ? '#101F33'
                    : lane.isAssigned ? '#E2EFFF' : '#8FA4C4',
                  whiteSpace: 'nowrap',
                  textOverflow: 'ellipsis',
                  overflow: 'hidden',
                  maxWidth: '100%',
                  textAlign: 'center'
                }}
              >
                {lane.title}
              </div>

              {/* レーン下部のカスタムカラーライン */}
              <div
                style={{
                  position: 'absolute',
                  bottom: 0,
                  left: 0,
                  right: 0,
                  height: 3,
                  background: lane.color
                }}
              />
            </div>
          ))}
        </div>
      )}

      {/* 2. Canvas 描画エリア */}
      <div style={{ flex: 1, position: 'relative', minHeight: 0, overflow: 'hidden' }}>
        <canvas
          ref={canvasRef}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            display: 'block'
          }}
        />

        {showDebugHUD && (
          <div
            ref={hudRef} // ★ ref をバインド
            style={{
              position: 'absolute',
              bottom: 12,
              right: 12,
              background: 'rgba(0, 0, 0, 0.85)',
              color: '#E2EFFF',
              padding: '6px 10px',
              borderRadius: 6,
              fontFamily: 'monospace',
              fontSize: 11,
              pointerEvents: 'none',
              zIndex: 10
            }}
          >
            FPS: -- | Delta: --
          </div>
        )}
      </div>
    </div>
  );
};