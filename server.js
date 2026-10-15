// Kokoro-82M v1.1-zh 本地离线中文 TTS 服务
// 链路：zh-g2p.js（汉字→注音+声调，对照 misaki/zh_frontend）→ v1.1-zh tokenizer → ONNX 推理（CPU）
// 模型首次运行从 HuggingFace 下载并缓存到 ./models，之后完全离线
const express = require('express');
const cors = require('cors');
const path = require('path');
const { env } = require('@huggingface/transformers');

env.cacheDir = path.join(__dirname, 'models'); // 模型缓存固定在项目内

const { KokoroTTS } = require('kokoro-js');
const { zhToPhonemes } = require('./zh-g2p');

const PORT = 3000;
const SAMPLE_RATE = 24000;
const INTER_SENTENCE_SILENCE = 5000; // 句间静音样本数（约 0.2s，对齐官方 make_zh.py）
const MAX_TOKENS_PER_SEG = 480;     // 模型上下文 512，留 pad 余量

// v1.1-zh 全部 100 个中文音色：zf_001-085 等 54 女声 / zm_009-100 等 46 男声
// （完整列表见 node_modules/kokoro-js/voices/，node download-voices.js 可重下）
const VOICES = [
  'zf_001', 'zf_002', 'zf_003', 'zf_004', 'zf_005', 'zf_006', 'zf_007', 'zf_008',
  'zf_017', 'zf_018', 'zf_019', 'zf_021', 'zf_022', 'zf_023', 'zf_024', 'zf_026',
  'zf_027', 'zf_028', 'zf_032', 'zf_036', 'zf_038', 'zf_039', 'zf_040', 'zf_042',
  'zf_043', 'zf_044', 'zf_046', 'zf_047', 'zf_048', 'zf_049', 'zf_051', 'zf_059',
  'zf_060', 'zf_067', 'zf_070', 'zf_071', 'zf_072', 'zf_073', 'zf_074', 'zf_075',
  'zf_076', 'zf_077', 'zf_078', 'zf_079', 'zf_083', 'zf_084', 'zf_085', 'zf_086',
  'zf_087', 'zf_088', 'zf_090', 'zf_092', 'zf_093', 'zf_094', 'zf_099',
  'zm_009', 'zm_010', 'zm_011', 'zm_012', 'zm_013', 'zm_014', 'zm_015', 'zm_016',
  'zm_020', 'zm_025', 'zm_029', 'zm_030', 'zm_031', 'zm_033', 'zm_034', 'zm_035',
  'zm_037', 'zm_041', 'zm_045', 'zm_050', 'zm_052', 'zm_053', 'zm_054', 'zm_055',
  'zm_056', 'zm_057', 'zm_058', 'zm_061', 'zm_062', 'zm_063', 'zm_064', 'zm_065',
  'zm_066', 'zm_068', 'zm_069', 'zm_080', 'zm_081', 'zm_082', 'zm_089', 'zm_091',
  'zm_095', 'zm_096', 'zm_097', 'zm_098', 'zm_100',
  'af_sol', 'af_maple', // 英语音色（读英文段）
];

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let tts = null;
let loading = null;

async function getTTS() {
  if (tts) return tts;
  if (!loading) {
    console.log('[init] 正在加载 Kokoro-82M v1.1-zh（首次会下载模型 ~170MB）...');
    const start = Date.now();
    loading = KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.1-zh-ONNX', {
      dtype: 'fp32', // 实测本机 CPU：fp32 比 q8 快 ~2.5 倍（int8 反量化开销超过收益）
      device: 'cpu',
    })
      .then((t) => {
        tts = t;
        console.log(`[init] 模型就绪，耗时 ${((Date.now() - start) / 1000).toFixed(1)}s`);
        return t;
      })
      .catch((e) => {
        loading = null;
        throw e;
      });
  }
  return loading;
}

// Float32 单声道 → 16bit PCM WAV Buffer
function float32ToWav(f32, sampleRate = SAMPLE_RATE) {
  const n = f32.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);       // PCM
  buf.writeUInt16LE(1, 22);       // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return buf;
}

// Float32 → 16bit PCM Buffer（流式用，不带 WAV 头）
function float32ToPcm16(f32) {
  const buf = Buffer.alloc(f32.length * 2);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    buf.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  return buf;
}

// 流式 WAV 头：总长未知，用 0xFFFFFFFF 流式约定（VLC/ffplay 可直接播）
function wavStreamingHeader(sampleRate = SAMPLE_RATE) {
  const buf = Buffer.alloc(44);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(0xffffffff, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(0xffffffff, 40);
  return buf;
}

// 流式分段：按句切（第一句尽快出声），超长句再硬切（保守 token 上限）
function splitSegmentsForStream(phonemes) {
  const MAX_PHONEME_CHARS = 240; // 每注音字符≈1 token，上下文 512
  const sentences = phonemes.split(/(?<=[.!?;:])/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const s of sentences) {
    if (s.length <= MAX_PHONEME_CHARS) { out.push(s); continue; }
    for (let i = 0; i < s.length; i += MAX_PHONEME_CHARS) out.push(s.slice(i, i + MAX_PHONEME_CHARS));
  }
  return out;
}

// 长文本 → 注音串 → 按句切分成 ≤MAX_TOKENS_PER_SEG 的段
function splitSegments(phonemes) {
  const sentences = phonemes.split(/(?<=[.!?;:])/).map((s) => s.trim()).filter(Boolean);
  const segs = [];
  let cur = '';
  for (const s of sentences) {
    if (cur && (cur + ' ' + s).length > MAX_TOKENS_PER_SEG / 2) { // 注音字符≈0.5 token/字，保守估计
      segs.push(cur);
      cur = s;
    } else {
      cur = cur ? cur + ' ' + s : s;
    }
  }
  if (cur) segs.push(cur);
  return segs;
}

app.get('/api/status', (req, res) => {
  res.json({ ready: !!tts, loading: !!loading && !tts, voices: VOICES });
});

// 流式合成：HTTP chunked 传输 PCM WAV
// 逐句推理，每句完成立即下发；客户端边收边播，首包只等第一句
app.post('/api/tts/stream', async (req, res) => {
  const { text, voice = 'zf_001', speed = 1 } = req.body || {};
  if (!text || !String(text).trim()) {
    return res.status(400).json({ error: 'text 不能为空' });
  }
  if (!VOICES.includes(voice)) {
    return res.status(400).json({ error: `voice 必须是 ${VOICES.join(' / ')} 之一` });
  }
  let closed = false;
  // 客户端断开检测：Node 18+ 里 req 的 'close' 在请求体读完就触发，
  // 必须监听 res 并排除正常结束（writableEnded），否则会误判断开
  res.on('close', () => { if (!res.writableEnded) closed = true; });
  req.on('aborted', () => { closed = true; });

  try {
    const t = await getTTS();
    const phonemes = await zhToPhonemes(String(text)); // async：英文段走 espeak 音素化
    const segments = splitSegmentsForStream(phonemes);
    if (!segments.length) {
      return res.status(400).json({ error: '没有可合成的内容' });
    }
    // 流式 WAV：chunked，总长写 0xFFFFFFFF 约定（客户端读 PCM 播放）
    res.status(200);
    res.set({
      'Content-Type': 'audio/wav',
      'Cache-Control': 'no-cache',
      'X-TTS-First-Segment-At': String(Date.now()),
      'Transfer-Encoding': 'chunked',
    });
    res.write(wavStreamingHeader());
    const t0 = Date.now();
    let firstByteMs = null;
    let totalSamples = 0;
    for (let i = 0; i < segments.length && !closed; i++) {
      const { input_ids } = t.tokenizer(segments[i].toLowerCase(), { truncation: true });
      if (input_ids.dims.at(-1) <= 2) continue;
      const audio = await t.generate_from_ids(input_ids, { voice, speed: Number(speed) || 1 });
      totalSamples += audio.audio.length;
      res.write(float32ToPcm16(audio.audio));
      if (firstByteMs === null) firstByteMs = Date.now() - t0;
      if (i < segments.length - 1) {
        const silence = new Float32Array(INTER_SENTENCE_SILENCE);
        totalSamples += silence.length;
        res.write(float32ToPcm16(silence));
      }
      // write 会挂到事件循环；给客户端一点接收时间
      await new Promise((r) => setImmediate(r));
    }
    if (!closed) {
      const totalMs = Date.now() - t0;
      res.end();
      console.log(
        `[stream] voice=${voice} segs=${segments.length} 首包=${firstByteMs}ms 总耗时=${totalMs}ms 音频=${(totalSamples / SAMPLE_RATE).toFixed(1)}s`
      );
    }
  } catch (e) {
    console.error('[stream] error:', e);
    if (!res.headersSent) res.status(500).json({ error: String(e && e.message ? e.message : e) });
    else res.end();
  }
});

app.post('/api/tts', async (req, res) => {
  const { text, voice = 'zf_001', speed = 1 } = req.body || {};
  if (!text || !String(text).trim()) {
    return res.status(400).json({ error: 'text 不能为空' });
  }
  if (!VOICES.includes(voice)) {
    return res.status(400).json({ error: `voice 必须是 ${VOICES.join(' / ')} 之一` });
  }
  const t0 = Date.now();
  try {
    const t = await getTTS();
    // 1) 中文 G2P：汉字→注音+声调（数字自动转汉字，标点转半角）
    const phonemes = await zhToPhonemes(String(text)); // async：英文段走 espeak 音素化
    console.log(`[tts] phonemes: ${phonemes}`);
    // 2) 分段（模型上下文 512）
    const segments = splitSegments(phonemes);
    // 3) 逐段：tokenizer → generate_from_ids（不经过英文音素器/音色校验）
    const chunks = [];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const lower = seg.toLowerCase(); // tokenizer 词表仅小写字母+注音+助记汉字
      const { input_ids } = t.tokenizer(lower, { truncation: true });
      if (input_ids.dims.at(-1) <= 2) continue; // 只剩 pad，跳过
      const audio = await t.generate_from_ids(input_ids, { voice, speed: Number(speed) || 1 });
      chunks.push(audio.audio);
      if (i < segments.length - 1) {
        chunks.push(new Float32Array(INTER_SENTENCE_SILENCE)); // 句间静音
      }
    }
    if (!chunks.length) {
      return res.status(400).json({ error: '没有可合成的内容（文本可能只含不支持的外文字符）' });
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const merged = new Float32Array(total);
    let off = 0;
    for (const c of chunks) { merged.set(c, off); off += c.length; }
    const wav = float32ToWav(merged);
    const latencyMs = Date.now() - t0;
    const durationSec = total / SAMPLE_RATE;
    console.log(
      `[tts] voice=${voice} chars=${text.length} segs=${segments.length} 耗时=${latencyMs}ms 音频=${durationSec.toFixed(1)}s RTF=${(latencyMs / 1000 / durationSec).toFixed(2)}`
    );
    res.set('Content-Type', 'audio/wav');
    res.set('X-TTS-Latency-ms', String(latencyMs));
    res.set('X-TTS-Duration-s', durationSec.toFixed(2));
    res.send(wav);
  } catch (e) {
    console.error('[tts] error:', e);
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});

(async () => {
  await getTTS();
  app.listen(PORT, () => {
    console.log(`✅ Kokoro 中文 TTS 服务已启动: http://localhost:${PORT}  （Ctrl+C 停止）`);
  });
})().catch((e) => {
  console.error('[fatal] 模型加载失败:', e);
  process.exit(1);
});
