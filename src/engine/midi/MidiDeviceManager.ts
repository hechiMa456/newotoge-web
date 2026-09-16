import { UnifiedMidiEndpoint } from './types';
import { loadRegisteredPresets, registerMcuPreset, InstrumentPreset, NONE_PRESET } from '../../models/InstrumentPreset';
import { SerialDeviceProber } from '../serial/SerialDeviceProber';

// M5Stack AtomS3 (ESP32-S3) の USB Vendor ID
const ESP32_S3_VENDOR_ID = 0x303A;

export class MidiDeviceManager {
  private static instance: MidiDeviceManager;
  private endpoints: UnifiedMidiEndpoint[] = [];
  private listeners: Set<(endpoints: UnifiedMidiEndpoint[]) => void> = new Set();

  private midiAccess: any = null;
  private manualAssignments: Record<string, number> = {};
  private isProbingSerial = false;

  private constructor() {
    this.loadManualAssignments();
    this.setupSerialHotplugListener();
  }

  public static getInstance(): MidiDeviceManager {
    if (!MidiDeviceManager.instance) {
      MidiDeviceManager.instance = new MidiDeviceManager();
    }
    return MidiDeviceManager.instance;
  }

  private loadManualAssignments(): void {
    try {
      const data = localStorage.getItem('otoge_manual_midi_assignments');
      if (data) this.manualAssignments = JSON.parse(data);
    } catch {
      this.manualAssignments = {};
    }
  }

  private saveManualAssignments(): void {
    try {
      localStorage.setItem('otoge_manual_midi_assignments', JSON.stringify(this.manualAssignments));
    } catch {
      /* no-op */
    }
  }

  /**
   * USBケーブル挿入時の自動問い合わせリスナー
   */
  private setupSerialHotplugListener(): void {
    const nav = navigator as any;
    if (nav.serial && nav.serial.addEventListener) {
      nav.serial.addEventListener('connect', () => {
        setTimeout(() => {
          this.autoProbeAllGrantedPorts();
        }, 500);
      });
    }
  }

  public async initWebMidi(): Promise<void> {
    const nav = navigator as any;
    if (!nav.requestMIDIAccess) return;

    try {
      this.midiAccess = await nav.requestMIDIAccess({ sysex: true });
      this.refreshEndpoints();

      this.midiAccess.onstatechange = () => {
        this.refreshEndpoints();
        this.autoProbeAllGrantedPorts();
      };
    } catch {
      try {
        this.midiAccess = await nav.requestMIDIAccess({ sysex: false });
        this.refreshEndpoints();
      } catch {
        /* no-op */
      }
    }

    this.autoProbeAllGrantedPorts();
  }

  public refreshEndpoints(): void {
    const nextEndpoints: UnifiedMidiEndpoint[] = [];
    const presets = loadRegisteredPresets();

    if (this.midiAccess) {
      const outputs: any[] = Array.from(this.midiAccess.outputs.values());

      for (const out of outputs) {
        let identified: InstrumentPreset | undefined;
        if (this.manualAssignments[out.id]) {
          identified = presets.find(p => p.id === this.manualAssignments[out.id]);
        }
        if (!identified) {
          identified = presets.find(p =>
            p.id !== 0 && (out.name || '').toLowerCase().includes(p.mcuName.toLowerCase())
          );
        }

        const endpoint: UnifiedMidiEndpoint = {
          id: out.id,
          name: out.name || 'USB MIDI Device',
          transport: 'web-midi',
          rawOutputPort: out,
          identifiedPreset: identified
        };

        nextEndpoints.push(endpoint);
      }
    }

    for (const ep of this.endpoints) {
      if (ep.transport === 'ble-gatt') {
        nextEndpoints.push(ep);
      }
    }

    this.endpoints = nextEndpoints;
    this.notify();
  }

  /**
   * 「+ USB照合」ボタン:
   * M5Stack AtomS3 を優先フィルタリングしてポート選択ダイアログを表示し、
   * 検出された MCU_NAME を動的登録してバインドする
   */
  public async probeSerialDeviceManually(): Promise<void> {
    const nav = navigator as any;
    if (!nav.serial) {
      alert('お使いのブラウザは Web Serial に対応していません。Google Chrome をご利用ください。');
      return;
    }

    try {
      let port: any;
      try {
        port = await nav.serial.requestPort({
          filters: [{ usbVendorId: ESP32_S3_VENDOR_ID }]
        });
      } catch {
        port = await nav.serial.requestPort();
      }

      if (port) {
        const info = await SerialDeviceProber.probePort(port);
        if (info) {
          this.bindSerialMcuToEndpoint(info.instId, info.mcuName);
        } else {
          alert('マイコンからのハンドシェイク応答がありませんでした。');
        }
      }

      await this.autoProbeAllGrantedPorts();
    } catch {
      /* キャンセル時はスキップ */
    }
  }

  /**
   * 許可済みの全シリアルポート候補に対して、順に自動問い合わせ（Auto Probe）を実行
   */
  public async autoProbeAllGrantedPorts(): Promise<void> {
    const nav = navigator as any;
    if (!nav.serial || !nav.serial.getPorts || this.isProbingSerial) return;

    this.isProbingSerial = true;

    try {
      const ports: any[] = await nav.serial.getPorts();
      for (const port of ports) {
        const info = await SerialDeviceProber.probePort(port);
        if (info) {
          this.bindSerialMcuToEndpoint(info.instId, info.mcuName);
        }
      }
    } catch {
      /* no-op */
    } finally {
      this.isProbingSerial = false;
    }
  }

  /**
   * 検出された MCU 情報を動的プリセットへ登録し、未バインドの MIDI ポートに紐付け
   */
  private bindSerialMcuToEndpoint(instId: number, mcuName: string): void {
    const preset = registerMcuPreset(mcuName, instId);

    const target = this.endpoints.find(
      ep =>
        ep.transport === 'web-midi' &&
        (!ep.identifiedPreset ||
          ep.identifiedPreset.id === 0 ||
          ep.name.toLowerCase().includes('m5') ||
          ep.name.toLowerCase().includes('atom'))
    );

    if (target) {
      target.identifiedPreset = preset;
      this.manualAssignments[target.id] = preset.id;
      this.saveManualAssignments();
    }

    this.refreshEndpoints();
  }

  public setEndpointPreset(endpointId: string, presetId: number): void {
    const target = this.endpoints.find(e => e.id === endpointId);
    if (!target) return;

    const presets = loadRegisteredPresets();
    if (presetId === 0) {
      delete target.identifiedPreset;
      delete this.manualAssignments[endpointId];
    } else {
      const preset = presets.find(p => p.id === presetId);
      target.identifiedPreset = preset;
      this.manualAssignments[endpointId] = presetId;
    }

    this.saveManualAssignments();
    this.notify();
  }

  /**
   * 登録済みMCU一覧をベースに、接続中デバイス情報（オンライン状態 / #1, #2 枝番）を合成して選択肢を動的生成
   */
  /**
   * 登録済みMCU一覧をベースに選択肢を動的生成
   * ★ 同一MCUで USB と BLE の両方が接続されている場合のみ [USB] / [BLE] を付与
   */
  public getAvailableMcuTargets(): InstrumentPreset[] {
    const targets: InstrumentPreset[] = [NONE_PRESET];
    const registered = loadRegisteredPresets().filter(p => p.id !== 0 && p.mcuName !== 'None');

    // 接続中のエンドポイントを mcuName ごとにグループ化
    const connectedGroups: Record<string, UnifiedMidiEndpoint[]> = {};
    for (const ep of this.endpoints) {
      if (ep.identifiedPreset && ep.identifiedPreset.id !== 0 && ep.identifiedPreset.mcuName !== 'None') {
        const key = ep.identifiedPreset.mcuName.toLowerCase();
        if (!connectedGroups[key]) connectedGroups[key] = [];
        connectedGroups[key].push(ep);
      }
    }

    // 表示名フォーマットヘルパー
    const formatTargetName = (baseName: string, ep: UnifiedMidiEndpoint, group: UnifiedMidiEndpoint[]): string => {
      const hasUsb = group.some(e => e.transport === 'web-midi');
      const hasBle = group.some(e => e.transport === 'ble-gatt');
      const hasMixedTransports = hasUsb && hasBle;

      // 同一トランスポート内で2台以上ある場合のみ枝番 (#1, #2) を付与
      const sameTransportEps = group.filter(e => e.transport === ep.transport);
      const indexStr = sameTransportEps.length > 1 ? ` (#${sameTransportEps.indexOf(ep) + 1})` : '';

      // USBとBLEの両方が混在接続されている場合のみ [USB] / [BLE] を付与
      const transStr = hasMixedTransports ? (ep.transport === 'ble-gatt' ? ' [BLE]' : ' [USB]') : '';

      return `${baseName}${indexStr}${transStr}`;
    };

    // 1. 登録済みプリセットを走査
    for (const preset of registered) {
      const key = preset.mcuName.toLowerCase();
      const connected = connectedGroups[key];

      if (connected && connected.length > 0) {
        // 接続中 (オンライン)
        connected.forEach((ep, idx) => {
          targets.push({
            ...preset,
            name: formatTargetName(preset.name, ep, connected),
            instanceIndex: idx + 1,
            endpointId: ep.id,
            isOnline: true
          });
        });
        delete connectedGroups[key]; // 処理済み
      } else {
        // 未接続 (オフライン事前設定用)
        targets.push({
          ...preset,
          name: preset.name,
          isOnline: false
        });
      }
    }

    // 2. 登録リスト外だが接続されているデバイスがあれば追加
    for (const [, group] of Object.entries(connectedGroups)) {
      group.forEach((ep, idx) => {
        const basePreset = ep.identifiedPreset!;
        targets.push({
          ...basePreset,
          name: formatTargetName(basePreset.name, ep, group),
          instanceIndex: idx + 1,
          endpointId: ep.id,
          isOnline: true
        });
      });
    }

    return targets;
  }

  public getEndpoints(): UnifiedMidiEndpoint[] {
    return this.endpoints;
  }

  public subscribe(cb: (endpoints: UnifiedMidiEndpoint[]) => void): () => void {
    this.listeners.add(cb);
    cb(this.endpoints);
    return () => this.listeners.delete(cb);
  }

  private notify(): void {
    this.listeners.forEach(cb => cb([...this.endpoints]));
  }

  // クラスのプロパティに追加
  private bleWriteQueue: Promise<void> = Promise.resolve();

  public sendBytes(endpoint: UnifiedMidiEndpoint, bytes: number[]): void {
    if (endpoint.transport === 'web-midi' && endpoint.rawOutputPort) {
      try {
        endpoint.rawOutputPort.send(bytes);
      } catch {
        /* 送信エラー抑制 */
      }
    } else if (endpoint.transport === 'ble-gatt' && endpoint.bleCharacteristic) {
      const header = 0x80;
      const timestamp = 0x80;
      const packet = new Uint8Array([header, timestamp, ...bytes]);

      // ★ 送信Promiseをキューで数珠つなぎにし、GATT競合を完全に防止
      this.bleWriteQueue = this.bleWriteQueue
        .then(() => endpoint.bleCharacteristic!.writeValueWithoutResponse(packet))
        .catch(() => {});
    }
  }

  public async connectBleDevice(): Promise<void> {
    const nav = navigator as any;
    if (!nav.bluetooth) {
      alert('お使いのブラウザは Web Bluetooth に対応していません。Google Chrome をご利用ください。');
      return;
    }

    // マイコン側のUUID および 標準BLE-MIDI UUID の両方を定義
    const TARGET_SERVICE_UUID = '03b80e5a-ede8-4b33-a028-51ad156441ec';
    const STANDARD_MIDI_SERVICE_UUID = '03b80e5a-ede8-4b33-a751-6ce34ec4c700';
    const MIDI_CHAR_UUID = '7772e5db-3868-4112-a1a9-f2669d106bf3';

    try {
      // ★ 修正: マイコンのService UUID、標準UUID、またはデバイス名から検出できるように設定
      const device = await nav.bluetooth.requestDevice({
        filters: [
          { services: [TARGET_SERVICE_UUID] },
          { services: [STANDARD_MIDI_SERVICE_UUID] },
          { namePrefix: 'PowerChord' }
        ],
        optionalServices: [TARGET_SERVICE_UUID, STANDARD_MIDI_SERVICE_UUID]
      });

      const server = await device.gatt?.connect();
      if (!server) return;

      // マイコン側のUUIDを優先してサービスを取得
      let service: any;
      try {
        service = await server.getPrimaryService(TARGET_SERVICE_UUID);
      } catch {
        service = await server.getPrimaryService(STANDARD_MIDI_SERVICE_UUID);
      }

      const characteristic = await service.getCharacteristic(MIDI_CHAR_UUID);

      const presets = loadRegisteredPresets();
      const matchedPreset = presets.find(
        p => p.id !== 0 && (device.name || '').toLowerCase().includes(p.mcuName.toLowerCase())
      );

      const endpoint: UnifiedMidiEndpoint = {
        id: device.id,
        name: device.name || 'PowerChordGT (BLE)',
        transport: 'ble-gatt',
        bleCharacteristic: characteristic,
        identifiedPreset: matchedPreset
      };

      this.endpoints = [...this.endpoints.filter(e => e.id !== endpoint.id), endpoint];
      this.notify();
    } catch (err) {
      // ユーザーによるキャンセル以外の場合にログを出力
      console.warn('BLE connection aborted or failed:', err);
    }
  }

  public testSingleNote(endpoint: UnifiedMidiEndpoint, channel: number, pitch: number): void {
    const ch = channel & 0x0f;
    this.sendBytes(endpoint, [0x90 | ch, pitch & 0x7f, 100]);
    setTimeout(() => {
      this.sendBytes(endpoint, [0x80 | ch, pitch & 0x7f, 0]);
    }, 200);
  }

  public sendAllNotesOff(endpoint: UnifiedMidiEndpoint, channel: number): void {
    const ch = channel & 0x0f;
    this.sendBytes(endpoint, [0xb0 | ch, 123, 0]);
  }
}