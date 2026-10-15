// 中文 G2P：汉字 + 中英混读 → Kokoro v1.1-zh tokenizer 的注音格式
// 链路对照官方 misaki v1.1 (zh.py + zh_frontend.py, Apache-2.0, 改编自 PaddlePaddle)：
//   中文：jieba 分词 → pinyin-pro 拼音（多音字消歧 + 变调）→ 注音符号 → 词间插 '/'
//   英文：espeak-ng (phonemizer WASM) → IPA（v1.1-zh 词表原生支持 IPA 音标）
//   符号：@ . : 等 URL/邮箱符号 → 中文读法（艾特/点/冒号）
// 纯 JS 离线实现，无需 Python
const { pinyin } = require('pinyin-pro');
const { Jieba } = require('@node-rs/jieba');
const { dict } = require('@node-rs/jieba/dict');
const { phonemize } = require('phonemizer');

const jieba = Jieba.withDict(dict);

// 声母/韵母 → 注音符号 + 助记汉字（与 misaki ZH_MAP 一致）
const ZH_MAP = {
  b: 'ㄅ', p: 'ㄆ', m: 'ㄇ', f: 'ㄈ', d: 'ㄉ', t: 'ㄊ', n: 'ㄋ', l: 'ㄌ',
  g: 'ㄍ', k: 'ㄎ', h: 'ㄏ', j: 'ㄐ', q: 'ㄑ', x: 'ㄒ',
  zh: 'ㄓ', ch: 'ㄔ', sh: 'ㄕ', r: 'ㄖ', z: 'ㄗ', c: 'ㄘ', s: 'ㄙ',
  a: 'ㄚ', o: 'ㄛ', e: 'ㄜ', ie: 'ㄝ', ai: 'ㄞ', ei: 'ㄟ', ao: 'ㄠ', ou: 'ㄡ',
  an: 'ㄢ', en: 'ㄣ', ang: 'ㄤ', eng: 'ㄥ', er: 'ㄦ',
  i: 'ㄧ', u: 'ㄨ', v: 'ㄩ',
  ii: 'ㄭ', iii: '十',
  ve: '月', ia: '压', ian: '言', iang: '阳', iao: '要', in: '阴', ing: '应',
  iong: '用', iou: '又', ong: '中', ua: '穵', uai: '外', uan: '万',
  uang: '王', uei: '为', uen: '文', ueng: '瓮', uo: '我', van: '元', vn: '云',
};
const INITIALS = ['zh', 'ch', 'sh', 'b', 'p', 'm', 'f', 'd', 't', 'n', 'l', 'g',
  'k', 'h', 'j', 'q', 'x', 'r', 'z', 'c', 's', 'y', 'w'];

// URL/邮箱符号 → 中文读法（在 G2P 之前做文本替换）
const SYMBOL_READINGS = [
  [/@/g, ' 艾特 '], [/\./g, ' 点 '], [/:/g, ' 冒号 '],
  [/\+/g, ' 加 '], [/#/g, ' 井号 '], [/\$/g, ' 美元 '],
  [/%(?![a-z])/g, ' 百分号 '], [/&(?![a-z])/g, ' 和 '], [/\*/g, ' 星号 '],
  [/\//g, ' 斜杠 '], [/~/g, ' 波浪号 '], [/-/g, ' 杠 '],
];

// 中文标点 → 半角 + 空格（misaki map_punctuation）
function mapPunctuation(text) {
  return text
    .replace(/、/g, ', ').replace(/，/g, ', ')
    .replace(/。/g, '. ').replace(/．/g, '. ')
    .replace(/！/g, '! ').replace(/：/g, ': ')
    .replace(/；/g, '; ').replace(/？/g, '? ')
    .replace(/«/g, ' “').replace(/»/g, '” ')
    .replace(/《/g, ' “').replace(/》/g, '” ')
    .replace(/「/g, ' “').replace(/」/g, '” ')
    .replace(/【/g, ' “').replace(/】/g, '” ')
    .replace(/（/g, ' (').replace(/）/g, ') ')
    .trim();
}

// ---- 阿拉伯数字 → 汉字 ----
const DIGIT_ZH = '零一二三四五六七八九';
function fourDigitsToZh(g) {
  const units = ['', '十', '百', '千'];
  let out = '';
  let lastWasZero = false;
  for (let i = 0; i < g.length; i++) {
    const d = Number(g[i]);
    const unit = units[g.length - 1 - i];
    if (d === 0) { if (out) lastWasZero = true; continue; }
    if (lastWasZero) out += '零';
    lastWasZero = false;
    out += DIGIT_ZH[d] + unit;
  }
  return out;
}
function numToZh(nStr) {
  const s = nStr.replace(/^0+(?=\d)/, '');
  if (s === '0' || s === '') return '零';
  const groups = [];
  for (let i = s.length; i > 0; i -= 4) groups.unshift(s.slice(Math.max(0, i - 4), i));
  const groupUnits = ['', '万', '亿', '万亿'];
  let out = '';
  groups.forEach((g, gi) => {
    const gnum = parseInt(g, 10);
    if (gnum === 0) return;
    const unit = groupUnits[groups.length - 1 - gi];
    if (gnum < 1000 && g.length > 1 && g[0] === '0' && out) out += '零';
    out += fourDigitsToZh(String(gnum)) + unit;
  });
  return out || '零';
}

// 拼音音节 → 注音（轻声 0 → 5）
function syllableToZhuyin(py) {
  const syl = py.replace(/ü/g, 'v');
  const m = syl.match(/^([a-z]+)([0-5])?$/);
  if (!m) return null;
  const body = m[1];
  const tone = m[2] === '0' ? '5' : (m[2] || '5');
  let initial = '';
  for (const c of INITIALS) {
    if (body.startsWith(c)) { initial = c; break; }
  }
  let rest = body.slice(initial.length);
  if (initial === 'y' || initial === 'w') {
    let f;
    if (initial === 'y') {
      if (rest === 'i') f = 'i';
      else if (rest === 'in') f = 'in';
      else if (rest === 'ing') f = 'ing';
      else if (rest.startsWith('u')) f = 'v' + rest.slice(1);
      else f = 'i' + rest;
    } else {
      f = rest === 'u' ? 'u' : 'u' + rest;
    }
    return mapFinal('', f, tone);
  }
  if (['j', 'q', 'x'].includes(initial) && /^u/.test(rest)) {
    rest = 'v' + rest.slice(1);
  }
  if (/^i/.test(rest)) {
    if (['zh', 'ch', 'sh', 'r'].includes(initial)) rest = rest.replace(/^i/, 'iii');
    else if (['z', 'c', 's'].includes(initial)) rest = rest.replace(/^i/, 'ii');
  }
  return mapFinal(ZH_MAP[initial] || '', rest, tone);
}

function mapFinal(prefix, f, tone) {
  if (f === 'iu') f = 'iou';
  if (f === 'ui') f = 'uei';
  if (f === 'un') f = 'uen';
  if (f === 'ü') f = 'v';
  if (ZH_MAP[f]) return prefix + ZH_MAP[f] + tone;
  const m = f.match(/^([iuv])(.+)$/);
  if (m) {
    const medial = m[1] === 'v' ? ZH_MAP.v : ZH_MAP[m[1]];
    const main = ZH_MAP[m[2]];
    if (medial && main) return prefix + medial + main + tone;
  }
  const z = ZH_MAP[f];
  return z ? prefix + z + tone : null;
}

// 中文词 → 注音串
function wordToZhuyin(word) {
  const pys = pinyin(word, { toneType: 'num', type: 'array', toneSandhi: true });
  let out = '';
  for (const py of pys) {
    const z = syllableToZhuyin(py);
    if (z) out += z;
  }
  return out;
}

// 单个英文单词 → IPA（espeak en-us）。返回小写 IPA 串
async function enWordToIPA(word) {
  try {
    const r = await phonemize(word);
    if (r && r[0]) return r[0].toLowerCase().replace(/[ˈˌ]/g, ''); // 去重音符
    return word.toLowerCase();
  } catch {
    return word.toLowerCase();
  }
}

// 字母逐个读（P → pi:）用于短缩写
async function spellLetters(word) {
  let out = '';
  for (const c of word.toLowerCase()) {
    out += await enWordToIPA(c);
    out += ' ';
  }
  return out.trim();
}

// 主入口：中英混读文本 → 注音+IPA 混合串（v1.1-zh tokenizer 格式）
// 策略（对照 misaki zh.py __call__）：
//   - 3+ 字母的英文词 → espeak IPA（按词发音）
//   - 1-2 字母的英文串 → 逐字母拼读（P4 → P 四；acronym）
//   - 数字：中文段内已转汉字；紧跟英文的数字转英文读法暂略（按汉字读）
async function zhToPhonemes(text) {
  let t = String(text);
  // 1) 符号中文化（URL/邮箱里的 @ . : + 等）
  //    只处理「看起来像 URL/邮箱/代码」的上下文？简化：全部替换（中文标点已先处理会冲突，故先符号后标点）
  //    注意：句末的 . 也会变成 点 —— 用启发式：前后都是字母/数字的 . 才是 URL 点？
  //    更稳妥：把「字母数字.字母数字」模式中的 . 转为 点，句末标点保留
  t = t.replace(/(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])/g, ' 点 '); // URL 内部的点（lookbehind 防重叠漏配）
  t = t.replace(/(?<=[A-Za-z0-9])@(?=[A-Za-z0-9一-鿿])/g, ' 艾特 '); // @（邮箱/提及，后随中文也算）
  t = t.replace(/(?<=[A-Za-z0-9一-鿿])@/g, ' 艾特 ');          // @ 前是中文/字母数字（找@张满）
  // 端口冒号：字母或数字后接数字（com:1666）；中文全角冒号由 mapPunctuation 处理
  t = t.replace(/(?<=[A-Za-z0-9]):(?=\d)/g, ' 冒号 ');
  // 百分号：N% → 百分之N（中文标准语序：25% → 百分之二十五，% 挪到数字前）
  t = t.replace(/(\d+)%(?=\d)/g, '百分之$1 '); // %后还有数字（25%178=档位25%身高178）：转完留空隙防粘连
  t = t.replace(/(\d+)%/g, '百分之$1');        // 常规：百分之二十五
  // 2) 中文标点 + 数字转汉字
  t = mapPunctuation(t);
  t = t.replace(/\d[\d,]*/g, (m) => {
    const digits = m.replace(/,/g, '');
    return digits.length <= 12 ? numToZh(digits) : m;
  });
  // 3) 分段：中文段 / 英文段 / 其他
  const segments = t.match(/[一-鿿]+|[A-Za-z]+|[^一-鿿A-Za-z]+/g) || [];
  const out = [];
  for (const seg of segments) {
    if (/^[一-鿿]+$/.test(seg)) {
      // 中文：jieba 分词 + 词边界 /
      const words = jieba.cut(seg, false);
      const parts = [];
      for (const w of words) {
        if (!w.trim()) continue;
        parts.push(wordToZhuyin(w));
      }
      out.push(parts.join('/'));
    } else if (/^[A-Za-z]+$/.test(seg)) {
      if (seg.length >= 3) {
        out.push(await enWordToIPA(seg)); // 整词发音
      } else {
        out.push(await spellLetters(seg)); // 逐字母拼读
      }
    } else {
      out.push(seg.replace(/\s+/g, ' ').trim() === '' ? ' ' : seg);
    }
  }
  return out.join(' ').replace(/\/{2,}/g, '/').replace(/\s+/g, ' ').trim();
}

module.exports = { zhToPhonemes, syllableToZhuyin, numToZh, wordToZhuyin, ZH_MAP };
