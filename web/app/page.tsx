'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://127.0.0.1:8787/ws/voice';
const RECORD_SECONDS = 3;

type LogLine = { time: string; text: string; kind?: 'err' | 'ok' };

type Telemetry = { stt?: number; llm?: number; tts?: number; total?: number };

// ---------- 录音编码工具：PCM → 16kHz 单声道 WAV ----------
// 直接用 Web Audio API 采集原始 PCM 样本并封装 WAV，绕开 MediaRecorder/webm 的浏览器格式兼容性问题，
// 确保百炼 Qwen-ASR 一定能拿到有效音频。
function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return buf;
}

// 线性插值重采样到 16kHz（百炼 ASR 对 16k 单声道 WAV 支持最稳定）
function resampleTo16k(samples: Float32Array, fromRate: number): Float32Array {
  if (fromRate === 16000) return samples;
  const ratio = 16000 / fromRate;
  const outLen = Math.floor(samples.length * ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i / ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const frac = pos - i0;
    out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
  }
  return out;
}

export default function Home() {
  const [activeTab, setActiveTab] = useState<'voice' | 'echo'>('voice');
  const [wsState, setWsState] = useState<'connecting' | 'open' | 'closed'>('closed');

  // 任务 A：Echo
  const [echoInput, setEchoInput] = useState('Fastify WebSocket Echo 连通性测试验证');
  const [echoResult, setEchoResult] = useState('');

  // 任务 B/C：语音
  const [recording, setRecording] = useState(false);
  const [countdown, setCountdown] = useState(RECORD_SECONDS);
  const [busy, setBusy] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [reply, setReply] = useState('');
  const [audioUrl, setAudioUrl] = useState('');
  const [stage, setStage] = useState<'idle' | 'recording' | 'stt' | 'llm' | 'tts'>('idle');
  const [logs, setLogs] = useState<LogLine[]>([]);
  // 麦克风设备选择：浏览器默认设备可能与系统默认不一致，允许手动选择
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedMic, setSelectedMic] = useState('');
  // 运行日志折叠状态
  const [logsCollapsed, setLogsCollapsed] = useState(false);

  // Telemetry 性能耗时指标
  const [telemetry, setTelemetry] = useState<Telemetry>({});
  const timerRef = useRef<{ start?: number; stt?: number; llm?: number; tts?: number }>({});

  const wsRef = useRef<WebSocket | null>(null);
  const audioChunksRef = useRef<BlobPart[]>([]);
  const audioFormatRef = useRef('mp3');
  const echoExpectRef = useRef('');
  const reconnectRef = useRef(0);
  const closedByUserRef = useRef(false);

  const log = useCallback((text: string, kind?: 'err' | 'ok') => {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    setLogs((prev) => [{ time, text, kind }, ...prev].slice(0, 100));
  }, []);

  // ---------- 枚举麦克风设备 ----------
  useEffect(() => {
    const loadDevices = async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const mics = devices.filter((d) => d.kind === 'audioinput');
        setMicDevices(mics);
        // 默认选中系统默认设备（label 为空的那个）
        const def = mics.find((m) => m.deviceId === 'default') ?? mics[0];
        if (def) setSelectedMic(def.deviceId);
      } catch {
        // 未授权前枚举可能失败，录音时再提示授权
      }
    };
    void loadDevices();
    // 授权后设备列表会刷新
    const onChange = () => void loadDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', onChange);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', onChange);
  }, []);

  // ---------- WebSocket 连接（带自动重连） ----------
  useEffect(() => {
    let ws: WebSocket;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    const connect = () => {
      ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectRef.current = 0;
        setWsState('open');
        log(`WebSocket 通道已建立 [${WS_URL}]`, 'ok');
      };
      ws.onclose = () => {
        setWsState('closed');
        // 断线时重置忙状态，避免界面卡死
        setBusy(false);
        setStage('idle');
        setRecording(false);
        log('WebSocket 连接已关闭，尝试重连…', 'err');
        // 指数退避重连：1s / 2s / 4s / 8s… 上限 10s
        if (!disposed && !closedByUserRef.current) {
          const delay = Math.min(1000 * 2 ** reconnectRef.current, 10000);
          reconnectRef.current += 1;
          reconnectTimer = setTimeout(connect, delay);
        }
      };
      ws.onerror = () => {
        if (ws.readyState !== WebSocket.CLOSED) log('WebSocket 通信异常，正在重试…', 'err');
      };

      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          let msg: any;
          let isEcho = false;
          try {
            msg = JSON.parse(ev.data);
            // 控制协议消息都有 type；若解析成功但无已知 type，视为 Echo 原样回包
            if (!msg || typeof msg !== 'object' || !msg.type) isEcho = true;
          } catch {
            // 非 JSON 文本 = 任务 A 的 echo 原样回包
            isEcho = true;
          }
          if (isEcho) {
            if (ev.data === echoExpectRef.current) {
              setEchoResult(ev.data);
              log(`[Echo] 服务端原样返回：${ev.data}`, 'ok');
            } else {
              log(`[Echo] 收到未知文本消息：${ev.data}`);
            }
            return;
          }
          const now = Date.now();
          switch (msg.type) {
            case 'stage':
              if (msg.stage === 'stt') {
                setStage('stt');
                timerRef.current.start = now;
                log('[流程] 开始语音转写…');
              } else if (msg.stage === 'llm') {
                setStage('llm');
                const cost = now - (timerRef.current.start || now);
                timerRef.current.stt = cost;
                setTelemetry((t) => ({ ...t, stt: cost }));
                log(`[流程] 转写完成（${cost}ms），生成回复…`);
              } else if (msg.stage === 'tts') {
                setStage('tts');
                const cost = now - (timerRef.current.start || now) - (timerRef.current.stt || 0);
                timerRef.current.llm = cost;
                setTelemetry((t) => ({ ...t, llm: cost }));
                log(`[流程] 回复完成（${cost}ms），合成语音…`);
              }
              break;
            case 'transcript':
              setTranscript(msg.text);
              log(`[转写] ${msg.text}`, 'ok');
              break;
            case 'reply':
              setReply(msg.text);
              log(`[回复] ${msg.text}`, 'ok');
              break;
            case 'audio_start':
              audioFormatRef.current = msg.format ?? 'mp3';
              audioChunksRef.current = [];
              log(`[合成] 开始接收音频（${msg.format}）`);
              break;
            case 'audio_end': {
              const ttsCost =
                now - (timerRef.current.start || now) - (timerRef.current.stt || 0) - (timerRef.current.llm || 0);
              const totalCost = now - (timerRef.current.start || now);
              timerRef.current.tts = ttsCost;
              setTelemetry((t) => ({ ...t, tts: ttsCost, total: totalCost }));
              finishAudio();
              log(`[合成] 音频接收完成，端到端耗时 ${totalCost}ms`, 'ok');
              break;
            }
            case 'audio_skipped':
              log(`[合成] 已跳过：${msg.reason}`);
              break;
            case 'done':
              setBusy(false);
              setStage('idle');
              log('[流程] 处理完成', 'ok');
              break;
            case 'error':
              log(`[错误] ${msg.message}`, 'err');
              setBusy(false);
              setStage('idle');
              break;
            default:
              // 防御：未知 JSON 控制消息也按 Echo 展示
              setEchoResult(ev.data);
              log(`[Echo] 服务端原样返回：${ev.data}`, 'ok');
          }
        } else {
          // 二进制帧 = TTS 音频块
          audioChunksRef.current.push(ev.data);
        }
      };
    };

    connect();

    return () => {
      disposed = true;
      closedByUserRef.current = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [log]);

  const finishAudio = () => {
    const mime = audioFormatRef.current === 'wav' ? 'audio/wav' : 'audio/mpeg';
    const blob = new Blob(audioChunksRef.current, { type: mime });
    setAudioUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return URL.createObjectURL(blob);
    });
  };

  // ---------- 任务 A：Echo ----------
  const sendEcho = () => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    echoExpectRef.current = echoInput;
    ws.send(echoInput);
    setEchoResult('');
    log(`[Echo] 已发送：${echoInput}`);
  };

  // ---------- 任务 B：录音 3 秒 → STT → LLM（→ TTS） ----------
  const startVoice = async () => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || busy) return;

    setBusy(true);
    setTranscript('');
    setReply('');
    setAudioUrl('');
    setStage('recording');
    setCountdown(RECORD_SECONDS);
    setTelemetry({});
    timerRef.current = {};

    try {
      // 用 Web Audio API 直接采集 PCM，绕开 MediaRecorder/webm 的浏览器格式兼容问题。
      // 显式指定麦克风设备，避免浏览器默认设备与系统默认不一致导致录不到音。
      const constraints: MediaStreamConstraints = {
        audio: selectedMic
          ? { deviceId: { exact: selectedMic }, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
          : { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      const audioCtx = new AudioContext();
      // 关键：Chrome 自动播放策略下 AudioContext 默认 suspended，
      // 不 resume 则 onaudioprocess 不会触发，录到的样本为空。
      if (audioCtx.state === 'suspended') await audioCtx.resume();
      const source = audioCtx.createMediaStreamSource(stream);
      // ScriptProcessor 采集原始样本（16 位 PCM 由 WAV 封装保证兼容性）
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      // 静音增益节点：采集不向扬声器外放，避免回声/啸叫
      const silentGain = audioCtx.createGain();
      silentGain.gain.value = 0;
      const samples: Float32Array[] = [];
      let peakLevel = 0;

      processor.onaudioprocess = (e) => {
        const data = e.inputBuffer.getChannelData(0);
        samples.push(new Float32Array(data));
        for (let i = 0; i < data.length; i++) {
          const abs = Math.abs(data[i]);
          if (abs > peakLevel) peakLevel = abs;
        }
      };
      source.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(audioCtx.destination);
      // 使用独立引用，便于停止时释放
      const cleanup = () => {
        try {
          source.disconnect();
          processor.disconnect();
          silentGain.disconnect();
          stream.getTracks().forEach((t) => t.stop());
          void audioCtx.close();
        } catch { /* 忽略清理异常 */ }
      };

      setRecording(true);
      log(`开始录音（${RECORD_SECONDS} 秒）…`);

      let remain = RECORD_SECONDS;
      const timer = setInterval(() => {
        remain -= 1;
        if (remain >= 0) setCountdown(remain);
        if (remain <= 0) clearInterval(timer);
      }, 1000);

      setTimeout(() => {
        cleanup();
        setRecording(false);

        // 拼接 PCM 样本 → 重采样 16kHz → WAV
        const totalLen = samples.reduce((s, c) => s + c.length, 0);
        const merged = new Float32Array(totalLen);
        let offset = 0;
        for (const c of samples) {
          merged.set(c, offset);
          offset += c.length;
        }
        // 计算有效音量：几乎全静音说明麦克风没拾到音
        let rms = 0;
        for (let i = 0; i < merged.length; i++) rms += merged[i] * merged[i];
        rms = Math.sqrt(rms / Math.max(1, merged.length));
        log(
          `录音完成（${(merged.length / 16000).toFixed(1)} 秒 / ${(totalLen * 2 / 1024).toFixed(1)}KB，峰值 ${(peakLevel * 100).toFixed(0)}%）` +
          (rms < 0.005 ? '，⚠️ 几乎无声，请检查麦克风是否被占用' : '')
        );

        const wav16k = resampleTo16k(merged, audioCtx.sampleRate);
        const wavBytes = encodeWav(wav16k, 16000);
        // 发送前确认连接仍在，避免对已断开的 socket 抛异常
        const sock = wsRef.current;
        if (!sock || sock.readyState !== WebSocket.OPEN) {
          log('连接已断开，音频未发送（将自动重连）', 'err');
          setBusy(false);
          setStage('idle');
          return;
        }
        try {
          sock.send(JSON.stringify({ type: 'audio', mime: 'audio/wav' }));
          sock.send(wavBytes);
          log('音频已发送，等待处理结果…');
        } catch (e) {
          log(`发送失败：${e instanceof Error ? e.message : String(e)}`, 'err');
          setBusy(false);
          setStage('idle');
        }
      }, RECORD_SECONDS * 1000);
    } catch (err) {
      log(`录音失败：${err instanceof Error ? err.message : String(err)}（请检查麦克风权限）`, 'err');
      setBusy(false);
      setStage('idle');
    }
  };

  return (
    <div className="app-shell">
      {/* 顶部 Header */}
      <header className="app-header">
        <div className="brand-wrapper">
          <div className="brand-badge-icon" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="22" />
            </svg>
          </div>
          <div>
            <span className="brand-text">语音 AI 链路 PoC</span>
            <span className="brand-sub">竞标试做</span>
          </div>
        </div>
        <div className="conn-pill" role="status" aria-live="polite">
          <span className={`conn-dot ${wsState === 'open' ? 'active' : ''}`} />
          <span>
            {wsState === 'open' ? 'WebSocket 已连接' : wsState === 'connecting' ? '连接中' : '未连接'}
          </span>
        </div>
      </header>

      {/* 模式切换 Tabs */}
      <nav className="nav-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={activeTab === 'voice'}
          className={`nav-tab ${activeTab === 'voice' ? 'selected' : ''}`}
          onClick={() => setActiveTab('voice')}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          </svg>
          <span>语音对话（任务 B / C）</span>
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'echo'}
          className={`nav-tab ${activeTab === 'echo' ? 'selected' : ''}`}
          onClick={() => setActiveTab('echo')}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
          </svg>
          <span>WebSocket Echo（任务 A）</span>
        </button>
      </nav>

      {/* 任务 B/C 主面板 */}
      {activeTab === 'voice' && (
        <section className="studio-card" aria-label="语音对话">
          <div className="acoustic-stage">
            {/* 麦克风设备选择（多个设备时显示） */}
            {micDevices.length > 1 && (
              <div style={{ marginBottom: '14px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <label htmlFor="mic-select" style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                  麦克风
                </label>
                <select
                  id="mic-select"
                  value={selectedMic}
                  onChange={(e) => setSelectedMic(e.target.value)}
                  style={{
                    background: 'var(--surface-sunken)',
                    color: 'var(--text-main)',
                    border: '1px solid var(--border)',
                    borderRadius: '8px',
                    padding: '6px 10px',
                    fontSize: '12px',
                    maxWidth: '320px',
                  }}
                >
                  {micDevices.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `麦克风 ${d.deviceId.slice(0, 4)}…`}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="orb-container">
              {recording && <div className="sonic-ripple" />}
              <button
                className={`orb-btn ${recording ? 'recording' : busy ? 'processing' : ''}`}
                onClick={startVoice}
                disabled={wsState !== 'open' || busy}
                aria-label={recording ? '录音中' : '开始录音'}
                title="点击开始录音 3 秒"
              >
                {recording ? (
                  <span style={{ fontSize: '18px', fontWeight: 'bold', fontFamily: 'var(--font-mono)' }}>
                    {countdown}s
                  </span>
                ) : busy ? (
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: 'spin 2s linear infinite' }}>
                    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                  </svg>
                ) : (
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                    <line x1="12" y1="19" x2="12" y2="22" />
                  </svg>
                )}
              </button>
            </div>
            <div className="pipeline-status" aria-live="polite">
              <div className="pipeline-status-title">
                {stage === 'recording' && '正在录音，请说话'}
                {stage === 'stt' && '正在语音转写…'}
                {stage === 'llm' && '正在生成回复…'}
                {stage === 'tts' && '正在合成语音…'}
                {stage === 'idle' && (transcript ? '对话完成，可继续录音' : '点击按钮开始录音（3 秒）')}
              </div>
              <div className="pipeline-status-desc">录音 · 转写 · 回复 · 合成，全程经 WebSocket 传输</div>
            </div>
          </div>

          {/* 对话历史流 */}
          {(transcript || reply) && (
            <div className="conversation-ledger">
              {transcript && (
                <article className="message-card user">
                  <div className="avatar-badge user-badge">用户</div>
                  <div className="message-body">
                    <div className="message-meta">
                      <span className="message-sender">语音转写</span>
                      <span className="message-tag">STT</span>
                    </div>
                    <p className="message-text">{transcript}</p>
                  </div>
                </article>
              )}
              {reply && (
                <article className="message-card assistant">
                  <div className="avatar-badge ai-badge">助手</div>
                  <div className="message-body">
                    <div className="message-meta">
                      <span className="message-sender">AI 回复</span>
                      <span className="message-tag">LLM / TTS</span>
                    </div>
                    <p className="message-text">{reply}</p>
                    {audioUrl && (
                      <div style={{ marginTop: '12px' }}>
                        <audio controls autoPlay src={audioUrl} style={{ width: '100%', height: '34px' }} />
                      </div>
                    )}
                  </div>
                </article>
              )}
            </div>
          )}

          {/* 延迟指标（常驻看板） */}
          <div className="telemetry-strip" aria-label="各阶段耗时">
            <div className="telemetry-col">
              <span className="telemetry-label">转写耗时</span>
              <span className="telemetry-value">{telemetry.stt ?? '--'} ms</span>
            </div>
            <div className="telemetry-col">
              <span className="telemetry-label">回复耗时</span>
              <span className="telemetry-value">{telemetry.llm ?? '--'} ms</span>
            </div>
            <div className="telemetry-col">
              <span className="telemetry-label">合成耗时</span>
              <span className="telemetry-value">{telemetry.tts ?? '--'} ms</span>
            </div>
            <div className="telemetry-col">
              <span className="telemetry-label">端到端延迟</span>
              <span className={`telemetry-value ${telemetry.total !== undefined ? 'done' : ''}`}>
                {telemetry.total ?? '--'} ms
              </span>
            </div>
          </div>
        </section>
      )}

      {/* 任务 A Echo 面板 */}
      {activeTab === 'echo' && (
        <section className="studio-card" aria-label="WebSocket Echo 测试">
          <h2 style={{ fontSize: '15px', fontWeight: 600, marginBottom: '6px' }}>WebSocket Echo 测试</h2>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            向服务端发送文本，验证原样返回。
          </p>
          <div className="echo-pane">
            <input
              type="text"
              className="text-field"
              value={echoInput}
              onChange={(e) => setEchoInput(e.target.value)}
              placeholder="输入测试文本"
            />
            <button className="action-btn" onClick={sendEcho} disabled={wsState !== 'open'}>
              发送
            </button>
          </div>
          {echoResult && (
            <div className="message-card" style={{ marginTop: '16px' }}>
              <div className="message-body">
                <div className="message-meta">
                  <span className="message-sender">服务端返回</span>
                  <span className="message-tag" style={{ color: 'var(--success)' }}>一致</span>
                </div>
                <div className="message-text" style={{ fontFamily: 'var(--font-mono)' }}>{echoResult}</div>
              </div>
            </div>
          )}
        </section>
      )}

      {/* 运行日志（可折叠） */}
      <footer className="terminal-block">
        <div
          className="terminal-header"
          onClick={() => setLogsCollapsed((c) => !c)}
          role="button"
          aria-expanded={!logsCollapsed}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setLogsCollapsed((c) => !c);
            }
          }}
        >
          <span className="terminal-title">运行日志</span>
          <span className="terminal-toggle">
            {logsCollapsed ? '展开 ▸' : '收起 ▾'} · {logs.length} 条
          </span>
        </div>
        <div className={`terminal-feed ${logsCollapsed ? 'collapsed' : ''}`}>
          {logs.length === 0 ? (
            <div style={{ color: '#475569' }}>暂无日志</div>
          ) : (
            logs.map((l, i) => (
              <div key={i} className="feed-row">
                <span className="feed-time">[{l.time}]</span>
                <span className={`feed-content ${l.kind || ''}`}>{l.text}</span>
              </div>
            ))
          )}
        </div>
      </footer>
    </div>
  );
}
