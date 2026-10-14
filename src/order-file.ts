import { crc32, inflateRawSync } from 'node:zlib';
import { AccountError } from './account.ts';
import { formatDecimal } from '../public/draft.js';
import type { RawRecord } from './review-ledger.ts';

const fail = (): never => { throw new AccountError('invalid_order_file', '订单文件格式、账户、时间或数值无法确认，未写入本地账本。'); };
const maxBytes = 64_000_000;

export function orderCsvFiles(data: Buffer): string[] {
  if (data.length < 22 || data.length > maxBytes) return fail();
  let end = data.length - 22;
  while (end >= Math.max(0, data.length - 65_557) && data.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0 || data.readUInt32LE(end) !== 0x06054b50 || end + 22 + data.readUInt16LE(end + 20) !== data.length || data.readUInt16LE(end + 4) !== 0 || data.readUInt16LE(end + 6) !== 0) return fail();
  const count = data.readUInt16LE(end + 10), directorySize = data.readUInt32LE(end + 12);
  const directory = data.readUInt32LE(end + 16);
  if (!count || count > 1000 || data.readUInt16LE(end + 8) !== count || directory + directorySize !== end) return fail();
  const files: string[] = [];
  let at = directory, total = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    for (let index = 0; index < count; index++) {
      if (at + 46 > end || data.readUInt32LE(at) !== 0x02014b50) return fail();
      const flags = data.readUInt16LE(at + 8), method = data.readUInt16LE(at + 10);
      const crc = data.readUInt32LE(at + 16), compressed = data.readUInt32LE(at + 20), size = data.readUInt32LE(at + 24);
      const nameLength = data.readUInt16LE(at + 28), extraLength = data.readUInt16LE(at + 30), commentLength = data.readUInt16LE(at + 32);
      const local = data.readUInt32LE(at + 42), next = at + 46 + nameLength + extraLength + commentLength;
      if (next > end || flags & 1 || ![0, 8].includes(method) || data.readUInt16LE(at + 34) !== 0 || size > maxBytes || (total += size) > maxBytes || local + 30 > directory) return fail();
      const name = decoder.decode(data.subarray(at + 46, at + 46 + nameLength));
      if (!name.toLowerCase().endsWith('.csv') || name.includes('\0') || data.readUInt32LE(local) !== 0x04034b50 || data.readUInt16LE(local + 6) & 1 || data.readUInt16LE(local + 8) !== method) return fail();
      const localNameLength = data.readUInt16LE(local + 26);
      const start = local + 30 + localNameLength + data.readUInt16LE(local + 28);
      if (start > directory || start + compressed > directory || decoder.decode(data.subarray(local + 30, local + 30 + localNameLength)) !== name) return fail();
      const packed = data.subarray(start, start + compressed);
      const content = method === 0 ? packed : inflateRawSync(packed, { maxOutputLength: maxBytes - (total - size) });
      if (content.length !== size || crc32(content) !== crc) return fail();
      files.push(decoder.decode(content));
      at = next;
    }
    if (at !== end) return fail();
  } catch { return fail(); }
  return files;
}

function csv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false, closed = false;
  for (let at = text.charCodeAt(0) === 0xfeff ? 1 : 0; at < text.length; at++) {
    const ch = text[at]!;
    if (quoted) {
      if (ch === '"') { if (text[at + 1] === '"') { field += '"'; at++; } else { quoted = false; closed = true; } }
      else field += ch;
    } else if (ch === '"') { if (field || closed) return fail(); quoted = true; }
    else if (ch === ',') { row.push(field); field = ''; closed = false; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[at + 1] === '\n') at++;
      row.push(field); rows.push(row); row = []; field = ''; closed = false;
    } else { if (closed) return fail(); field += ch; }
  }
  if (quoted) return fail();
  if (field || row.length || closed) { row.push(field); rows.push(row); }
  return rows;
}

function decimal(value: string, nullable = false): string | null {
  if (nullable && value === '') return null;
  const match = /^(\d{1,24})(?:\.(\d{1,30}))?(?:[eE]([+-]?\d{1,3}))?$/.exec(value);
  if (!match) return fail();
  const fraction = match[2] ?? '', exponent = Number(match[3] ?? 0) + 8 - fraction.length;
  if (Math.abs(exponent) > 60) return fail();
  let units = BigInt(match[1]! + fraction);
  if (exponent >= 0) units *= 10n ** BigInt(exponent);
  else { const divisor = 10n ** BigInt(-exponent); if (units % divisor) return fail(); units /= divisor; }
  const formatted = formatDecimal(units);
  if (formatted.split('.')[0]!.length > 24) return fail();
  return formatted;
}
function utc(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return fail();
  const text = value.replace(' ', 'T') + '.000Z', time = Date.parse(text);
  if (!Number.isSafeInteger(time) || time <= 0 || new Date(time).toISOString() !== text) return fail();
  return time;
}

const columns = ['Uid', 'Time(UTC)', 'Order No', 'Symbol', 'Type', 'Side', 'Position Side', 'Price', 'Average Price', 'Amount', 'Executed Amount', 'Executed Quote Amount', 'Stop Price', 'Status', 'Client Order Id', 'Time In Force', 'Activate Price', 'Price Rate', 'Working Type', 'Price Protect', 'Update Time'];
export function parseOrderCsv(text: string, accountId: string, startTime: number, endTime: number): RawRecord[] {
  const rows = csv(text), header = rows.shift();
  if (!header || header.length !== columns.length || new Set(header).size !== header.length || columns.some((name) => !header.includes(name))) return fail();
  return rows.flatMap((cells): RawRecord[] => {
    if (cells.length !== header.length) return fail();
    const row = Object.fromEntries(header.map((name, index) => [name, cells[index]!])) as Record<string, string>;
    if (row.Uid !== accountId) return fail();
    if (!/^[\p{L}\p{N}_]{1,30}USDT$/u.test(row.Symbol!)) return [];
    const id = row['Order No']!, symbol = row.Symbol!, time = utc(row['Time(UTC)']!), updateTime = utc(row['Update Time']!);
    // The file truncates milliseconds, so compare the requested boundaries at its own precision.
    if (!/^\d{1,30}$/.test(id) || time < Math.floor(startTime / 1000) * 1000 || time > endTime || updateTime < time || !['BUY', 'SELL'].includes(row.Side!) || !['BOTH', 'LONG', 'SHORT'].includes(row['Position Side']!)) return fail();
    if (!['NEW', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'EXPIRED', 'EXPIRED_IN_MATCH', 'REJECTED'].includes(row.Status!) || !/^[A-Z_]{1,40}$/.test(row.Type!)) return fail();
    return [{ kind: 'history', id, time, payload: {
      symbol, orderId: id, time, updateTime, type: row.Type!, side: row.Side!, positionSide: row['Position Side']!,
      price: decimal(row.Price!), avgPrice: decimal(row['Average Price']!, true), origQty: decimal(row.Amount!), executedQty: decimal(row['Executed Amount']!),
      cumQuote: decimal(row['Executed Quote Amount']!), stopPrice: decimal(row['Stop Price']!), status: row.Status!,
      clientOrderId: row['Client Order Id']!, timeInForce: row['Time In Force']!, activatePrice: decimal(row['Activate Price']!), priceRate: decimal(row['Price Rate']!),
      workingType: row['Working Type']!, priceProtect: row['Price Protect']!, orderDownload: true,
    } }];
  });
}
