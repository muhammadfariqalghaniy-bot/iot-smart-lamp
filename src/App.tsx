import { useEffect, useState, useRef, useCallback } from 'react';
import mqtt, { MqttClient } from 'mqtt';
import {
  Thermometer, Droplets, Power, Play, Square, Loader2,
  AlertTriangle, Cpu, Mic, MicOff, Volume2, VolumeX,
  Zap, ZapOff, Sun, Moon, RefreshCw, Wifi, WifiOff,
  Activity, Clock, Lightbulb
} from 'lucide-react';

const TOPICS = {
  STATUS_RELAY: 'iot/rumah2/relay/status',
  CMD_RELAY: 'iot/rumah2/relay/command',
  DATA_SENSOR: 'iot/rumah2/sensor/data',
  STATUS_VAR: 'iot/rumah2/variasi/status',
  CMD_VAR: 'iot/rumah2/variasi/command',
  CMD_ALL: 'iot/rumah2/relay/allcommand'
};

const LAMP_NAMES = ['Ruang Tamu', 'Kamar Tidur', 'Dapur', 'Teras'];

type VoiceLog = { text: string; type: 'command' | 'response' | 'error'; time: string };

// ---------- voice helpers ----------
function speak(text: string) {
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'id-ID';
    u.rate = 0.95;
    window.speechSynthesis.speak(u);
  }
}

function now() {
  return new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export default function App() {
  const [client, setClient] = useState<MqttClient | null>(null);
  const [connected, setConnected] = useState(false);
  const [relays, setRelays] = useState<Record<number, boolean>>({ 1: false, 2: false, 3: false, 4: false });
  const [sensor, setSensor] = useState({ suhu: '--', kelembaban: '--', lastUpdate: '--:--:--' });
  const [variasi, setVariasi] = useState(0);
  const [loadingRelays, setLoadingRelays] = useState<Record<number, boolean>>({});

  // voice
  const [voiceActive, setVoiceActive] = useState(false);
  const [voiceLogs, setVoiceLogs] = useState<VoiceLog[]>([]);
  const [transcript, setTranscript] = useState('');
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const clientRef = useRef<MqttClient | null>(null);
  const relaysRef = useRef(relays);
  const connectedRef = useRef(connected);
  const variasiRef = useRef(variasi);
  const sensorRef = useRef(sensor);

  // dark/light theme
  const [darkMode, setDarkMode] = useState(true);

  // keep refs in sync
  useEffect(() => { clientRef.current = client; }, [client]);
  useEffect(() => { relaysRef.current = relays; }, [relays]);
  useEffect(() => { connectedRef.current = connected; }, [connected]);
  useEffect(() => { variasiRef.current = variasi; }, [variasi]);
  useEffect(() => { sensorRef.current = sensor; }, [sensor]);

  const addLog = useCallback((text: string, type: VoiceLog['type']) => {
    setVoiceLogs(prev => [{ text, type, time: now() }, ...prev].slice(0, 30));
  }, []);

  const respond = useCallback((msg: string) => {
    addLog(msg, 'response');
    if (ttsEnabled) speak(msg);
  }, [addLog, ttsEnabled]);

  // ---- MQTT ----
  useEffect(() => {
    const clientId = `web_${Math.random().toString(16).slice(2, 10)}`;
    const mqttClient = mqtt.connect('wss://broker.hivemq.com:8884/mqtt', {
      clientId, keepalive: 60, protocolVersion: 4, clean: true,
      reconnectPeriod: 2000, connectTimeout: 30000,
    });
    setClient(mqttClient);
    mqttClient.on('connect', () => {
      setConnected(true);
      mqttClient.subscribe([TOPICS.STATUS_RELAY, TOPICS.DATA_SENSOR, TOPICS.STATUS_VAR]);
      setLoadingRelays({});
    });
    mqttClient.on('reconnect', () => setConnected(false));
    mqttClient.on('offline', () => setConnected(false));
    mqttClient.on('error', (e) => console.error('MQTT:', e));
    mqttClient.on('message', (topic, message) => {
      try {
        const payload = JSON.parse(message.toString());
        if (topic === TOPICS.STATUS_RELAY) {
          setRelays({ 1: !!payload.relay1, 2: !!payload.relay2, 3: !!payload.relay3, 4: !!payload.relay4 });
          setLoadingRelays({});
        } else if (topic === TOPICS.DATA_SENSOR) {
          setSensor({ suhu: payload.suhu ?? '--', kelembaban: payload.kelembaban ?? '--', lastUpdate: now() });
        } else if (topic === TOPICS.STATUS_VAR) {
          setVariasi(payload.variasi || 0);
        }
      } catch (e) { console.error('JSON parse error', e); }
    });
    return () => { mqttClient.end(); };
  }, []);

  // ---- relay helpers ----
  const toggleRelay = useCallback((id: number) => {
    const c = clientRef.current;
    if (!c || !connectedRef.current || variasiRef.current > 0) return;
    setLoadingRelays(prev => ({ ...prev, [id]: true }));
    c.publish(TOPICS.CMD_RELAY, JSON.stringify({ relay: id, state: !relaysRef.current[id] }));
    setTimeout(() => setLoadingRelays(prev => { const n = { ...prev }; delete n[id]; return n; }), 4000);
  }, []);

  const setAllRelays = useCallback((state: boolean) => {
    const c = clientRef.current;
    if (!c || !connectedRef.current || variasiRef.current > 0) return;
    c.publish(TOPICS.CMD_ALL, JSON.stringify({ state }));
  }, []);

  const setVariation = useCallback((id: number) => {
    const c = clientRef.current;
    if (!c || !connectedRef.current) return;
    c.publish(TOPICS.CMD_VAR, JSON.stringify({ variasi: id }));
  }, []);

  // ---- Voice command parser ----
  const parseCommand = useCallback((text: string) => {
    const t = text.toLowerCase().trim();
    addLog(t, 'command');

    // --- ALL ON ---
    if (/nyala(kan)? semua|semua (lampu )?nyala|hidupkan semua/.test(t)) {
      if (!connectedRef.current) return respond('Tidak terhubung ke broker.');
      if (variasiRef.current > 0) return respond('Variasi sedang aktif. Hentikan variasi terlebih dahulu.');
      setAllRelays(true); return respond('Semua lampu dinyalakan.');
    }
    // --- ALL OFF ---
    if (/matikan semua|semua (lampu )?mati|padamkan semua/.test(t)) {
      if (!connectedRef.current) return respond('Tidak terhubung ke broker.');
      if (variasiRef.current > 0) return respond('Variasi sedang aktif. Hentikan variasi terlebih dahulu.');
      setAllRelays(false); return respond('Semua lampu dimatikan.');
    }
    // --- VARIASI 1 ---
    if (/nyala(kan)? variasi (satu|1)|variasi (satu|1) aktif/.test(t)) {
      if (!connectedRef.current) return respond('Tidak terhubung ke broker.');
      setVariation(1); return respond('Variasi satu diaktifkan.');
    }
    // --- VARIASI 2 ---
    if (/nyala(kan)? variasi (dua|2)|variasi (dua|2) aktif/.test(t)) {
      if (!connectedRef.current) return respond('Tidak terhubung ke broker.');
      setVariation(2); return respond('Variasi dua diaktifkan.');
    }
    // --- STOP VARIASI ---
    if (/stop variasi|hentikan variasi|matikan variasi|variasi (off|mati)/.test(t)) {
      if (!connectedRef.current) return respond('Tidak terhubung ke broker.');
      setVariation(0); return respond('Variasi dihentikan.');
    }
    // --- CEK SUHU ---
    if (/cek suhu|berapa suhu|suhu (sekarang|saat ini)|temperature/.test(t)) {
      const s = sensorRef.current;
      if (s.suhu === '--') return respond('Data suhu belum tersedia.');
      const tinggi = parseFloat(s.suhu) >= 35;
      return respond(`Suhu saat ini ${s.suhu} derajat Celsius.${tinggi ? ' Peringatan: suhu cukup tinggi!' : ''}`);
    }
    // --- CEK KELEMBABAN ---
    if (/cek kelembab(an)?|berapa kelembab(an)?|humidity/.test(t)) {
      const s = sensorRef.current;
      if (s.kelembaban === '--') return respond('Data kelembaban belum tersedia.');
      return respond(`Kelembaban saat ini ${s.kelembaban} persen.`);
    }
    // --- STATUS LAMPU ---
    if (/status (semua )?lampu|lampu (mana|apa) (yang )?(menyala|nyala|hidup)/.test(t)) {
      const on = Object.entries(relaysRef.current).filter(([, v]) => v).map(([k]) => `Lampu ${k}`);
      if (on.length === 0) return respond('Semua lampu dalam keadaan mati.');
      return respond(`Yang menyala: ${on.join(', ')}.`);
    }
    // --- NYALAKAN LAMPU N ---
    for (let i = 1; i <= 4; i++) {
      const names = ['satu', 'dua', 'tiga', 'empat'];
      const r = new RegExp(`nyala(kan)? lampu (${i}|${names[i - 1]})`);
      if (r.test(t)) {
        if (!connectedRef.current) return respond('Tidak terhubung ke broker.');
        if (variasiRef.current > 0) return respond('Variasi sedang aktif.');
        if (relaysRef.current[i]) return respond(`Lampu ${i} sudah menyala.`);
        toggleRelay(i); return respond(`Lampu ${i} dinyalakan.`);
      }
    }
    // --- MATIKAN LAMPU N ---
    for (let i = 1; i <= 4; i++) {
      const names = ['satu', 'dua', 'tiga', 'empat'];
      const r = new RegExp(`matikan lampu (${i}|${names[i - 1]})`);
      if (r.test(t)) {
        if (!connectedRef.current) return respond('Tidak terhubung ke broker.');
        if (variasiRef.current > 0) return respond('Variasi sedang aktif.');
        if (!relaysRef.current[i]) return respond(`Lampu ${i} sudah mati.`);
        toggleRelay(i); return respond(`Lampu ${i} dimatikan.`);
      }
    }
    // --- STATUS KONEKSI ---
    if (/status (koneksi|jaringan|mqtt)|terhubung/.test(t)) {
      return respond(connectedRef.current ? 'Sistem terhubung ke broker MQTT.' : 'Sistem tidak terhubung.');
    }
    // --- BANTUAN ---
    if (/bantuan|help|apa yang bisa/.test(t)) {
      return respond('Perintah tersedia: nyalakan atau matikan lampu satu sampai empat, nyalakan variasi satu atau dua, stop variasi, cek suhu, cek kelembaban, status lampu, dan status koneksi.');
    }

    respond('Perintah tidak dikenali. Ucapkan "bantuan" untuk daftar perintah.');
  }, [addLog, respond, setAllRelays, setVariation, toggleRelay]);

  // ---- Speech Recognition ----
  const startListening = useCallback(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { respond('Browser tidak mendukung pengenalan suara.'); return; }
    const rec = new SR();
    rec.lang = 'id-ID';
    rec.interimResults = true;
    rec.continuous = false;
    rec.onstart = () => setListening(true);
    rec.onresult = (e: SpeechRecognitionEvent) => {
      const t = Array.from(e.results).map(r => r[0].transcript).join('');
      setTranscript(t);
      if (e.results[e.results.length - 1].isFinal) parseCommand(t);
    };
    rec.onerror = (e: SpeechRecognitionErrorEvent) => {
      setListening(false);
      if (e.error !== 'no-speech') addLog(`Error: ${e.error}`, 'error');
    };
    rec.onend = () => { setListening(false); setTranscript(''); };
    recognitionRef.current = rec;
    rec.start();
  }, [parseCommand, respond, addLog]);

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
    setListening(false);
  }, []);

  const isHighTemp = parseFloat(sensor.suhu) >= 35.0;
  const isVariationActive = variasi > 0;
  const lampCount = Object.values(relays).filter(Boolean).length;

  // ---- Theme ----
  const th = darkMode ? {
    bg: '#080C10',
    surface: '#0F1923',
    surfaceHover: '#162130',
    border: '#1E3048',
    borderAccent: '#0A84FF',
    text: '#E8F0FE',
    textMuted: '#5A7A9A',
    textDim: '#2A4060',
    accent: '#0A84FF',
    accentGlow: 'rgba(10,132,255,0.15)',
    green: '#30D158',
    greenGlow: 'rgba(48,209,88,0.15)',
    red: '#FF453A',
    redGlow: 'rgba(255,69,58,0.15)',
    amber: '#FFD60A',
    amberGlow: 'rgba(255,214,10,0.1)',
    orange: '#FF9F0A',
    orangeGlow: 'rgba(255,159,10,0.15)',
    gridLine: 'rgba(30,48,72,0.5)',
  } : {
    bg: '#F0F4F8',
    surface: '#FFFFFF',
    surfaceHover: '#F7FAFC',
    border: '#CBD5E0',
    borderAccent: '#2B6CB0',
    text: '#1A202C',
    textMuted: '#718096',
    textDim: '#A0AEC0',
    accent: '#2B6CB0',
    accentGlow: 'rgba(43,108,176,0.1)',
    green: '#38A169',
    greenGlow: 'rgba(56,161,105,0.1)',
    red: '#E53E3E',
    redGlow: 'rgba(229,62,62,0.1)',
    amber: '#D69E2E',
    amberGlow: 'rgba(214,158,46,0.1)',
    orange: '#DD6B20',
    orangeGlow: 'rgba(221,107,32,0.1)',
    gridLine: 'rgba(203,213,224,0.5)',
  };

  const cardStyle: React.CSSProperties = {
    background: th.surface,
    border: `1px solid ${th.border}`,
    borderRadius: 16,
    padding: '1.25rem 1.5rem',
    position: 'relative',
    overflow: 'hidden',
  };

  return (
    <div style={{ minHeight: '100vh', background: th.bg, color: th.text, fontFamily: "'JetBrains Mono', 'Fira Code', 'Consolas', monospace", padding: '1.5rem', transition: 'all 0.3s' }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: ${th.border}; border-radius: 2px; }
        @keyframes pulse-ring { 0%,100%{transform:scale(1);opacity:1} 50%{transform:scale(1.4);opacity:0.4} }
        @keyframes scanline { 0%{transform:translateY(-100%)} 100%{transform:translateY(100vh)} }
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.3} }
        @keyframes float { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-4px)} }
        .relay-card { transition: all 0.25s cubic-bezier(0.4,0,0.2,1); }
        .relay-card:hover { transform: translateY(-2px); border-color: ${th.accent} !important; }
        .btn-toggle { transition: all 0.2s; cursor: pointer; border: none; }
        .btn-toggle:active { transform: scale(0.95); }
        .btn-toggle:disabled { opacity: 0.35; cursor: not-allowed; transform: none; }
        .mic-btn { transition: all 0.2s; }
        .mic-btn:hover { transform: scale(1.05); }
        .mic-btn:active { transform: scale(0.95); }
        .scanline { position:fixed; top:0; left:0; right:0; height:2px; background:linear-gradient(90deg,transparent,${th.accent}40,transparent); animation:scanline 6s linear infinite; pointer-events:none; z-index:0; }
        .log-item { animation: fadeSlide 0.3s ease; }
        @keyframes fadeSlide { from{opacity:0;transform:translateY(-8px)} to{opacity:1;transform:translateY(0)} }
      `}</style>

      <div className="scanline" />

      <div style={{ maxWidth: 760, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '1rem' }}>

        {/* ── HEADER ── */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: '1rem', borderBottom: `1px solid ${th.border}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 40, height: 40, borderRadius: 10, background: `${th.accentGlow}`, border: `1px solid ${th.borderAccent}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Cpu size={20} color={th.accent} />
            </div>
            <div>
              <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.5px', color: th.text }}>SMART HOME</div>
              <div style={{ fontSize: 11, color: th.textMuted, letterSpacing: 2 }}>NODE CONTROLLER v2.0</div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {/* Theme Toggle */}
            <button onClick={() => setDarkMode(!darkMode)} style={{ background: th.surface, border: `1px solid ${th.border}`, borderRadius: 8, padding: '6px 10px', cursor: 'pointer', color: th.textMuted, display: 'flex', alignItems: 'center', gap: 4 }}>
              {darkMode ? <Sun size={14} /> : <Moon size={14} />}
            </button>
            {/* TTS Toggle */}
            <button onClick={() => setTtsEnabled(!ttsEnabled)} style={{ background: th.surface, border: `1px solid ${th.border}`, borderRadius: 8, padding: '6px 10px', cursor: 'pointer', color: ttsEnabled ? th.accent : th.textMuted, display: 'flex', alignItems: 'center', gap: 4 }}>
              {ttsEnabled ? <Volume2 size={14} /> : <VolumeX size={14} />}
            </button>
            {/* Connection Badge */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 20, background: connected ? th.greenGlow : th.redGlow, border: `1px solid ${connected ? th.green + '40' : th.red + '40'}`, fontSize: 11, fontWeight: 600, letterSpacing: 1.5, color: connected ? th.green : th.red }}>
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: connected ? th.green : th.red, boxShadow: connected ? `0 0 8px ${th.green}` : 'none', animation: connected ? 'pulse-ring 2s infinite' : 'none' }} />
              {connected ? 'ONLINE' : 'OFFLINE'}
            </div>
          </div>
        </div>

        {/* ── STATS ROW ── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '0.75rem' }}>
          {[
            { label: 'LAMPU AKTIF', value: lampCount, unit: `/ 4`, icon: <Lightbulb size={16} />, color: th.amber, glow: th.amberGlow },
            { label: 'SUHU RUANG', value: sensor.suhu === '--' ? '--' : sensor.suhu, unit: '°C', icon: <Thermometer size={16} />, color: isHighTemp ? th.red : th.orange, glow: isHighTemp ? th.redGlow : th.orangeGlow },
            { label: 'KELEMBABAN', value: sensor.kelembaban === '--' ? '--' : sensor.kelembaban, unit: '%', icon: <Droplets size={16} />, color: th.accent, glow: th.accentGlow },
          ].map(s => (
            <div key={s.label} style={{ ...cardStyle, background: s.glow, border: `1px solid ${s.color}25`, textAlign: 'center' }}>
              <div style={{ fontSize: 10, color: s.color, letterSpacing: 2, marginBottom: 6 }}>{s.label}</div>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'center', gap: 4 }}>
                <span style={{ fontSize: 28, fontWeight: 700, color: s.color }}>{s.value}</span>
                <span style={{ fontSize: 13, color: s.color + 'AA' }}>{s.unit}</span>
              </div>
            </div>
          ))}
        </div>

        {/* ── SENSOR CARD ── */}
        <div style={{ ...cardStyle }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Activity size={16} color={th.accent} />
              <span style={{ fontSize: 12, letterSpacing: 2, color: th.accent, fontWeight: 600 }}>MONITOR LINGKUNGAN</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: th.textMuted }}>
              <Clock size={11} />
              <span>Diperbarui {sensor.lastUpdate}</span>
              {isHighTemp && <AlertTriangle size={14} color={th.red} style={{ animation: 'blink 1s infinite' }} />}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            {[
              { icon: <Thermometer size={22} />, label: 'SUHU', val: sensor.suhu, unit: '°C', alert: isHighTemp, color: isHighTemp ? th.red : th.orange, desc: isHighTemp ? 'Suhu Tinggi!' : 'Normal' },
              { icon: <Droplets size={22} />, label: 'KELEMBABAN', val: sensor.kelembaban, unit: '%', alert: false, color: th.accent, desc: 'Relatif' },
            ].map(s => (
              <div key={s.label} style={{ background: th.bg, borderRadius: 12, padding: '1rem', border: `1px solid ${s.alert ? s.color + '50' : th.border}`, display: 'flex', alignItems: 'center', gap: 14 }}>
                <div style={{ width: 48, height: 48, borderRadius: 12, background: s.color + '18', border: `1px solid ${s.color + '30'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: s.color, flexShrink: 0 }}>
                  {s.icon}
                </div>
                <div>
                  <div style={{ fontSize: 10, letterSpacing: 2, color: th.textMuted, marginBottom: 2 }}>{s.label}</div>
                  <div style={{ fontSize: 26, fontWeight: 700, color: s.color, lineHeight: 1 }}>{s.val}<span style={{ fontSize: 13, fontWeight: 400, color: s.color + 'AA', marginLeft: 2 }}>{s.unit}</span></div>
                  <div style={{ fontSize: 10, color: s.alert ? th.red : th.textMuted, marginTop: 2 }}>{s.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── ALL RELAY CONTROLS ── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
          <button onClick={() => setAllRelays(true)} disabled={!connected || isVariationActive} className="btn-toggle" style={{ padding: '14px', borderRadius: 12, background: th.greenGlow, border: `1px solid ${th.green}40`, color: th.green, fontSize: 13, fontWeight: 600, letterSpacing: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <Zap size={16} /> SEMUA ON
          </button>
          <button onClick={() => setAllRelays(false)} disabled={!connected || isVariationActive} className="btn-toggle" style={{ padding: '14px', borderRadius: 12, background: th.redGlow, border: `1px solid ${th.red}40`, color: th.red, fontSize: 13, fontWeight: 600, letterSpacing: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <ZapOff size={16} /> SEMUA OFF
          </button>
        </div>

        {/* ── RELAY GRID ── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
          {[1, 2, 3, 4].map(id => {
            const isON = relays[id];
            const isLoading = loadingRelays[id];
            return (
              <div key={id} className="relay-card" style={{ ...cardStyle, border: `1px solid ${isON ? th.amber + '50' : th.border}`, background: isON ? th.amberGlow : th.surface }}>
                {isON && <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: `linear-gradient(90deg,transparent,${th.amber},transparent)` }} />}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                  <div>
                    <div style={{ fontSize: 10, color: th.textMuted, letterSpacing: 2, marginBottom: 2 }}>LAMPU {id}</div>
                    <div style={{ fontSize: 13, color: th.text, fontWeight: 500 }}>{LAMP_NAMES[id - 1]}</div>
                  </div>
                  <div style={{ position: 'relative' }}>
                    <div style={{ width: 12, height: 12, borderRadius: '50%', background: isON ? th.amber : th.textDim, boxShadow: isON ? `0 0 12px ${th.amber}, 0 0 24px ${th.amber}60` : 'none', transition: 'all 0.4s' }} />
                    {isON && <div style={{ position: 'absolute', inset: -4, borderRadius: '50%', border: `1px solid ${th.amber}40`, animation: 'pulse-ring 2s infinite' }} />}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 2, color: isON ? th.amber : th.textMuted }}>
                    {isON ? '● MENYALA' : '○ MATI'}
                  </div>
                  <button onClick={() => toggleRelay(id)} disabled={!connected || isVariationActive || isLoading} className="btn-toggle"
                    style={{ padding: '8px 16px', borderRadius: 8, fontSize: 12, fontWeight: 600, letterSpacing: 0.5, display: 'flex', alignItems: 'center', gap: 6, background: isON ? th.bg : th.amber, color: isON ? th.amber : '#000', border: `1px solid ${isON ? th.amber + '50' : 'transparent'}` }}>
                    {isLoading ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Power size={13} />}
                    {isON ? 'MATIKAN' : 'NYALAKAN'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {/* ── VARIASI ── */}
        <div style={{ ...cardStyle }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: '0.75rem' }}>
            <RefreshCw size={15} color={th.accent} />
            <span style={{ fontSize: 12, letterSpacing: 2, color: th.accent, fontWeight: 600 }}>MODE VARIASI OTOMATIS</span>
            {isVariationActive && <span style={{ marginLeft: 'auto', fontSize: 10, padding: '3px 8px', borderRadius: 10, background: th.accent + '20', color: th.accent, border: `1px solid ${th.accent}40`, letterSpacing: 1 }}>AKTIF: VAR {variasi}</span>}
          </div>
          <p style={{ fontSize: 11, color: th.textMuted, marginBottom: '1rem', lineHeight: 1.6 }}>Mode otomatis akan menonaktifkan kontrol manual selama berjalan.</p>
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            {[1, 2].map(v => (
              <button key={v} onClick={() => setVariation(v)} disabled={!connected} className="btn-toggle"
                style={{ flex: 1, minWidth: 110, padding: '12px 16px', borderRadius: 10, fontSize: 12, fontWeight: 600, letterSpacing: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, background: variasi === v ? th.accent : th.bg, color: variasi === v ? '#fff' : th.textMuted, border: `1px solid ${variasi === v ? th.accent : th.border}`, boxShadow: variasi === v ? `0 0 20px ${th.accent}30` : 'none' }}>
                <Play size={13} style={{ fill: variasi === v ? '#fff' : 'none' }} />
                VARIASI {v}
              </button>
            ))}
            <button onClick={() => setVariation(0)} disabled={!connected || variasi === 0} className="btn-toggle"
              style={{ flex: 1, minWidth: 110, padding: '12px 16px', borderRadius: 10, fontSize: 12, fontWeight: 600, letterSpacing: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, background: variasi !== 0 ? th.redGlow : th.bg, color: variasi !== 0 ? th.red : th.textDim, border: `1px solid ${variasi !== 0 ? th.red + '40' : th.border}` }}>
              <Square size={13} style={{ fill: 'currentColor' }} />
              STOP
            </button>
          </div>
        </div>

        {/* ── VOICE COMMAND ── */}
        <div style={{ ...cardStyle, border: `1px solid ${voiceActive ? th.accent + '60' : th.border}` }}>
          {voiceActive && <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: `linear-gradient(90deg,transparent,${th.accent},transparent)` }} />}

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Mic size={15} color={th.accent} />
              <span style={{ fontSize: 12, letterSpacing: 2, color: th.accent, fontWeight: 600 }}>PERINTAH SUARA</span>
            </div>
            <button onClick={() => setVoiceActive(!voiceActive)} style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, background: voiceActive ? th.accent + '20' : th.bg, color: voiceActive ? th.accent : th.textMuted, border: `1px solid ${voiceActive ? th.accent + '40' : th.border}`, cursor: 'pointer', letterSpacing: 1 }}>
              {voiceActive ? 'TUTUP' : 'BUKA'}
            </button>
          </div>

          {voiceActive && (
            <>
              {/* Mic Button */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, marginBottom: '1rem' }}>
                <button onClick={listening ? stopListening : startListening} className="mic-btn"
                  style={{ width: 80, height: 80, borderRadius: '50%', background: listening ? th.red : th.accent, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', boxShadow: listening ? `0 0 30px ${th.red}60` : `0 0 20px ${th.accent}40` }}>
                  {listening
                    ? <MicOff size={28} color="#fff" />
                    : <Mic size={28} color="#fff" />}
                  {listening && (
                    <>
                      <div style={{ position: 'absolute', inset: -8, borderRadius: '50%', border: `2px solid ${th.red}60`, animation: 'pulse-ring 1s infinite' }} />
                      <div style={{ position: 'absolute', inset: -16, borderRadius: '50%', border: `1px solid ${th.red}30`, animation: 'pulse-ring 1s infinite 0.3s' }} />
                    </>
                  )}
                </button>
                <div style={{ fontSize: 12, color: listening ? th.red : th.textMuted, letterSpacing: 1, animation: listening ? 'blink 1.2s infinite' : 'none' }}>
                  {listening ? '● MENDENGARKAN...' : '○ TEKAN UNTUK BICARA'}
                </div>
                {transcript && (
                  <div style={{ fontSize: 13, color: th.text, background: th.bg, padding: '8px 14px', borderRadius: 8, border: `1px solid ${th.border}`, maxWidth: '100%', textAlign: 'center', fontStyle: 'italic' }}>
                    "{transcript}"
                  </div>
                )}
              </div>

              {/* Command Reference */}
              <div style={{ background: th.bg, borderRadius: 10, padding: '0.75rem', marginBottom: '0.75rem', border: `1px solid ${th.border}` }}>
                <div style={{ fontSize: 10, color: th.textMuted, letterSpacing: 2, marginBottom: 8 }}>DAFTAR PERINTAH</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', fontSize: 10, color: th.textMuted, lineHeight: 1.8 }}>
                  {[
                    '"Nyalakan lampu satu"', '"Matikan lampu tiga"',
                    '"Nyalakan semua"', '"Matikan semua"',
                    '"Nyalakan variasi satu"', '"Nyalakan variasi dua"',
                    '"Stop variasi"', '"Cek suhu"',
                    '"Cek kelembaban"', '"Status lampu"',
                    '"Status koneksi"', '"Bantuan"',
                  ].map(cmd => (
                    <div key={cmd} style={{ color: th.accent + 'CC', cursor: 'pointer' }} onClick={() => parseCommand(cmd.replace(/"/g, ''))}>{cmd}</div>
                  ))}
                </div>
              </div>

              {/* Voice Log */}
              {voiceLogs.length > 0 && (
                <div style={{ maxHeight: 180, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {voiceLogs.map((log, i) => (
                    <div key={i} className="log-item" style={{ display: 'flex', gap: 8, fontSize: 11, padding: '6px 10px', borderRadius: 6, background: log.type === 'command' ? th.accentGlow : log.type === 'error' ? th.redGlow : th.bg, border: `1px solid ${log.type === 'command' ? th.accent + '30' : log.type === 'error' ? th.red + '30' : th.border}` }}>
                      <span style={{ color: th.textMuted, flexShrink: 0 }}>{log.time}</span>
                      <span style={{ color: log.type === 'command' ? th.accent : log.type === 'error' ? th.red : th.green, fontWeight: log.type === 'command' ? 600 : 400 }}>
                        {log.type === 'command' ? '▶ ' : log.type === 'error' ? '✕ ' : '◀ '}{log.text}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* ── FOOTER ── */}
        <div style={{ textAlign: 'center', fontSize: 10, color: th.textDim, letterSpacing: 2, paddingTop: '0.5rem', borderTop: `1px solid ${th.border}` }}>
          SMART HOME IOT · MQTT BROKER HIVEMQ · {new Date().getFullYear()}
        </div>

      </div>
    </div>
  );
}
