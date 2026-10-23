import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export function quote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

export function unquote(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"');
  }
  return trimmed;
}

export function toCviPath(inputPath: string): string {
  const normalized = inputPath.replace(/\\/g, '/');
  const driveMatch = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (driveMatch) {
    return `/${driveMatch[1].toLowerCase()}/${driveMatch[2]}`;
  }
  return normalized;
}

export function fromCviPath(inputPath: string): string {
  const value = unquote(inputPath) ?? '';
  const driveMatch = value.match(/^\/([A-Za-z])\/(.*)$/);
  if (driveMatch) {
    return `${driveMatch[1].toUpperCase()}:\\${driveMatch[2].replace(/\//g, '\\')}`;
  }
  return value.replace(/\//g, path.sep);
}

export function splitCviLongValue(value: string, maxLength = 96): string[] {
  if (value.length <= maxLength) {
    return [value];
  }

  const parts: string[] = [];
  let offset = 0;
  while (offset < value.length) {
    parts.push(value.slice(offset, offset + maxLength));
    offset += maxLength;
  }
  return parts;
}

export function normalizeRelativePath(fromDirectory: string, targetPath: string): string {
  const relative = path.relative(fromDirectory, targetPath).replace(/\\/g, '/');
  return relative === '' ? path.basename(targetPath) : relative;
}

export function fileNameWithoutExtension(filePath: string): string {
  return path.basename(filePath, path.extname(filePath));
}

export function toCviRuntimeStoragePath(inputPath: string): string {
  const trimmed = inputPath.trim();
  if (!trimmed) {
    return '';
  }
  const cygdrive = trimmed.match(/^\/cygdrive\/([A-Za-z])\/(.*)$/);
  if (cygdrive) {
    return `/${cygdrive[1].toLowerCase()}/${cygdrive[2].replace(/\\/g, '/')}`;
  }
  const cviDrive = trimmed.match(/^\/([A-Za-z])\/(.*)$/);
  if (cviDrive) {
    return `/${cviDrive[1].toLowerCase()}/${cviDrive[2].replace(/\\/g, '/')}`;
  }
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) {
    return toCviPath(trimmed);
  }
  return trimmed;
}

export function normalizeRuntimePath(inputPath: string): string {
  const trimmed = inputPath.trim();
  if (!trimmed) {
    return '';
  }
  const expanded = trimmed.replace(/%([^%]+)%/g, (_match, name: string) => process.env[name] ?? `%${name}%`);
  const cygdrive = expanded.match(/^\/cygdrive\/([A-Za-z])\/(.*)$/);
  if (cygdrive) {
    return path.win32.normalize(`${cygdrive[1].toUpperCase()}:\\${cygdrive[2].replace(/\//g, '\\')}`);
  }
  const cviDrive = expanded.match(/^\/([A-Za-z])\/(.*)$/);
  if (cviDrive) {
    return path.win32.normalize(`${cviDrive[1].toUpperCase()}:\\${cviDrive[2].replace(/\//g, '\\')}`);
  }
  if (/^[A-Za-z]:[\\/]/.test(expanded)) {
    return path.win32.normalize(expanded.replace(/\//g, '\\'));
  }
  return path.normalize(expanded);
}

const CP1252_EXTRA_DECODE: Record<number, number> = {
  0x80: 0x20AC, 0x82: 0x201A, 0x83: 0x0192, 0x84: 0x201E, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021,
  0x88: 0x02C6, 0x89: 0x2030, 0x8A: 0x0160, 0x8B: 0x2039, 0x8C: 0x0152, 0x8E: 0x017D, 0x91: 0x2018,
  0x92: 0x2019, 0x93: 0x201C, 0x94: 0x201D, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02DC,
  0x99: 0x2122, 0x9A: 0x0161, 0x9B: 0x203A, 0x9C: 0x0153, 0x9E: 0x017E, 0x9F: 0x0178
};

const CP1252_EXTRA_ENCODE: Record<number, number> = Object.fromEntries(
  Object.entries(CP1252_EXTRA_DECODE).map(([byte, code]) => [code, Number(byte)])
);

export function getConfiguredCviEncoding(): 'windows1252' | 'utf8' {
  const value = vscode.workspace.getConfiguration('labwindowsCvi').get<string>('fileEncoding', 'windows1252');
  return value === 'utf8' ? 'utf8' : 'windows1252';
}

export function decodeWindows1252(buffer: Buffer): string {
  const chars = new Array<string>(buffer.length);
  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i];
    const code = (byte >= 0x80 && byte <= 0x9F) ? (CP1252_EXTRA_DECODE[byte] ?? byte) : byte;
    chars[i] = String.fromCharCode(code);
  }
  return chars.join('');
}

export function encodeWindows1252(text: string): Buffer {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0x7F || (code >= 0xA0 && code <= 0xFF)) {
      bytes.push(code);
    } else if (CP1252_EXTRA_ENCODE[code] !== undefined) {
      bytes.push(CP1252_EXTRA_ENCODE[code]);
    } else {
      bytes.push(0x3F); // '?' fallback for unrepresentable Unicode characters
    }
  }
  return Buffer.from(bytes);
}

export function readCviTextFile(filePath: string): string {
  const buffer = fs.readFileSync(filePath);
  if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
    return buffer.subarray(3).toString('utf8');
  }
  if (getConfiguredCviEncoding() === 'utf8') {
    return buffer.toString('utf8');
  }
  const utf8Text = buffer.toString('utf8');
  if (!utf8Text.includes('\uFFFD')) {
    return utf8Text;
  }
  return decodeWindows1252(buffer);
}

export function writeCviTextFile(filePath: string, content: string): void {
  if (getConfiguredCviEncoding() === 'utf8') {
    fs.writeFileSync(filePath, content, 'utf8');
    return;
  }
  fs.writeFileSync(filePath, encodeWindows1252(content));
}
export function isWindows1252CodePoint(code: number): boolean {
  return code <= 0x7F || (code >= 0xA0 && code <= 0xFF) || CP1252_EXTRA_ENCODE[code] !== undefined;
}
