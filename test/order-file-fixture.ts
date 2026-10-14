import { crc32, deflateRawSync } from 'node:zlib';

export function orderCsv(overrides: Record<string, string> = {}) {
  const row: Record<string, string> = {
    Uid: '12345', 'Time(UTC)': '2026-10-13 16:00:00', 'Order No': '9007199254740993123', Symbol: 'BTCUSDT', Type: 'LIMIT', Side: 'SELL', 'Position Side': 'BOTH',
    Price: '1.23E2', 'Average Price': '123', Amount: '2', 'Executed Amount': '0.5', 'Executed Quote Amount': '61.5', 'Stop Price': '0E-8', Status: 'CANCELED',
    'Client Order Id': 'controlled-client-id', 'Time In Force': 'GTC', 'Activate Price': '0E-8', 'Price Rate': '0E-8', 'Working Type': 'CONTRACT_PRICE', 'Price Protect': 'false', 'Update Time': '2026-10-13 16:01:00', ...overrides,
  };
  const cell = (value: string) => '"' + value.replaceAll('"', '""') + '"';
  return '\uFEFF' + Object.keys(row).map(cell).join(',') + '\n' + Object.values(row).map(cell).join(',') + '\n';
}

export function zipOrderCsv(text = orderCsv()) {
  const content = Buffer.from(text), name = Buffer.from('orders.csv'), packed = deflateRawSync(content);
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc32(content), 14);
  local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(name.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10); central.writeUInt32LE(crc32(content), 16);
  central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(content.length, 24); central.writeUInt16LE(name.length, 28);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + packed.length, 16);
  return Buffer.concat([local, name, packed, central, name, end]);
}
