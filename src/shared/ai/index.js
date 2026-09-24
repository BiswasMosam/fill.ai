// Fill.ai can think with three AIs. Everything outside this folder calls
// `askJson` and never needs to know which one is answering.
//
//   ollama  a model on this computer. Free, private, the default.
//   gemini  Google's free API tier. For laptops without a graphics card.
//   claude  Claude Opus 5 with a paid Anthropic key.
//
// Each provider takes the same content blocks (text, image, and PDF
// `document` blocks for those that read PDFs) and returns
// { data, cost, via }: the parsed JSON, the price in dollars or null when
// free, and a few words on who answered.

import * as ollama from './ollama.js';
import * as gemini from './gemini.js';
import * as claude from './claude.js';

export { FillError } from './errors.js';
export const PROVIDERS = { ollama, gemini, claude };

export function providerOf(settings) {
  return PROVIDERS[settings.provider] || ollama;
}

export function isConnected(settings) {
  return providerOf(settings).isConnected(settings);
}

export function askJson(opts) {
  return providerOf(opts.settings).askJson(opts);
}

export function testConnection(settings) {
  return providerOf(settings).test(settings);
}
