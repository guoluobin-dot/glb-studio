import { ASRHelper } from './src/analyzer/asr-helper.js';
import { readFileSync } from 'node:fs';
const cfg = JSON.parse(readFileSync('./config/default.json','utf-8'));
const h = new ASRHelper(cfg);
console.log('cloudAsrStatus (未启用) =', JSON.stringify(h.cloudAsrStatus()));
