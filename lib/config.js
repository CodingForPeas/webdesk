// lib/config.js
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.join(__dirname, '..');
export const IS_PROD = process.env.NODE_ENV === 'production';

export const REQUIRE_LINK_HOSTS = IS_PROD;

export const THESVG_URL = (process.env.THESVG_URL || '').replace(/\/+$/, '');
export const THESVG_REGISTRY = process.env.THESVG_REGISTRY || (THESVG_URL ? `${THESVG_URL}/api/registry.json` : '');

export const ICONS_DIR = process.env.ICONS_DIR || path.join(ROOT_DIR, 'public', 'icons');

export const LINK_ALLOWED_HOSTS = new Set(
  (process.env.LINK_ALLOWED_HOSTS || '')
    .split(',')
    .map(h => h.trim().toLowerCase())
    .filter(Boolean)
);

export const ALLOWED_EXTENSIONS = new Set([
  'txt','md','csv','json','xml','html','css','js','ts','py','sh',
  'pdf','doc','docx','xls','xlsx','png','jpg','jpeg','gif','svg',
  'ico','zip','tar','gz','log','yml','yaml','toml','ini','cfg',
]);

export const TEXT_BASED_EXTS = new Set([
  'txt','md','csv','json','xml','html','css','js','ts','py','sh',
  'log','yml','yaml','toml','ini','cfg',
]);

export const EXTENSION_MIME_MAP = {
  txt:  ['text/plain'],
  md:   ['text/markdown', 'text/plain'],
  csv:  ['text/csv', 'text/plain'],
  json: ['application/json'],
  xml:  ['text/xml', 'application/xml'],
  html: ['text/html'],
  css:  ['text/css'],
  js:   ['text/javascript', 'application/javascript'],
  ts:   ['text/typescript', 'application/typescript'],
  py:   ['text/x-python', 'text/plain'],
  sh:   ['text/x-shellscript', 'text/plain'],
  pdf:  ['application/pdf'],
  doc:  ['application/msword'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  xls:  ['application/vnd.ms-excel'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  png:  ['image/png'],
  jpg:  ['image/jpeg'],
  jpeg: ['image/jpeg'],
  gif:  ['image/gif'],
  svg:  ['image/svg+xml'],
  ico:  ['image/vnd.microsoft.icon', 'image/x-icon'],
  zip:  ['application/zip'],
  tar:  ['application/x-tar'],
  gz:   ['application/gzip'],
  log:  ['text/plain'],
  yml:  ['text/yaml', 'text/plain'],
  yaml: ['text/yaml', 'text/plain'],
  toml: ['text/plain'],
  ini:  ['text/plain'],
  cfg:  ['text/plain'],
};

export const DISK_QUOTA = 200n * 1024n * 1024n * 1024n;
export const FILES_DIR = process.env.FILES_DIR || '/app/files';
export const WALL_DIR  = process.env.WALL_DIR  || '/app/wallpapers';

export const DEFAULT_LINKS = [
  { title: 'Dawarich',  url: 'https://map.mortis.org.uk/', icon: '/icons/dawarich.svg',  category: 'Search', mode: 'tab' },
  { title: 'Wikipedia', url: 'https://wikipedia.org',      icon: '/icons/wikipedia.svg', category: 'Read', mode: 'tab' },
  { title: 'GitHub',    url: 'https://github.com',         icon: '/icons/github.svg',    category: 'Dev', mode: 'tab' },
];