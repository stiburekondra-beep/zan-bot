'use strict';

function stripEmoji(text) {
  return String(text)
    .replace(/[\uFE0E\uFE0F]/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '');
}

function splitSentences(text) {
  const sentences = [];
  const re = /[^.!?…]+[.!?…]+(?:["')\]]+)?|[^.!?…]+$/gu;
  let match;
  while ((match = re.exec(text)) !== null) {
    const sentence = match[0].trim();
    if (sentence) sentences.push(sentence);
  }
  return sentences;
}

function sanitizeVoiceResponse(text, opts = {}) {
  const maxSentences = Number.isFinite(opts.maxSentences) ? opts.maxSentences : 2;
  const maxChars = Number.isFinite(opts.maxChars) ? opts.maxChars : 260;
  let out = String(text || '').replace(/\r\n?/g, '\n');

  out = out
    .replace(/```[\s\S]*?```/g, block => block.replace(/```[a-zA-Z0-9_-]*\n?/g, '').replace(/```/g, ''))
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/_/g, ' ')
    .replace(/[*~]+/g, '');

  out = stripEmoji(out)
    .replace(/[ \t]*\n+[ \t]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const sentences = splitSentences(out);
  if (sentences.length > maxSentences) {
    out = sentences.slice(0, maxSentences).join(' ');
  }

  if (out.length > maxChars) {
    const slice = out.slice(0, maxChars + 1);
    const lastSpace = slice.lastIndexOf(' ');
    out = (lastSpace > 80 ? slice.slice(0, lastSpace) : slice.slice(0, maxChars)).trim();
    out = out.replace(/[,:;–-]\s*$/u, '').trim();
    if (!/[.!?…]$/u.test(out)) out += '.';
  }

  return out || 'Hotovo.';
}

module.exports = { sanitizeVoiceResponse, stripEmoji, splitSentences };
