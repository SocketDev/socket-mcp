/**
 * @file Minimal ZIP writer and reader for the ChatGPT plugin package.
 *   Entries use the STORE method because this package contains already
 *   compressed PNG data and small text manifests.
 */

export interface ZipArchiveEntry {
  readonly data: Buffer
  readonly name: string
}

interface ZipArchiveRecord extends ZipArchiveEntry {
  readonly crc: number
  readonly nameBytes: Buffer
  readonly offset: number
}

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50
const UTF8_FLAG = 0x0800
const DOS_DATE = 0x0021

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function createLocalFileHeader(entry: ZipArchiveRecord): Buffer {
  const header = Buffer.alloc(30)
  header.writeUInt32LE(LOCAL_FILE_HEADER_SIGNATURE, 0)
  header.writeUInt16LE(20, 4)
  header.writeUInt16LE(UTF8_FLAG, 6)
  header.writeUInt16LE(0, 8)
  header.writeUInt16LE(0, 10)
  header.writeUInt16LE(DOS_DATE, 12)
  header.writeUInt32LE(entry.crc, 14)
  header.writeUInt32LE(entry.data.length, 18)
  header.writeUInt32LE(entry.data.length, 22)
  header.writeUInt16LE(entry.nameBytes.length, 26)
  header.writeUInt16LE(0, 28)
  return header
}

function createCentralDirectoryEntry(entry: ZipArchiveRecord): Buffer {
  const header = Buffer.alloc(46)
  header.writeUInt32LE(CENTRAL_DIRECTORY_SIGNATURE, 0)
  header.writeUInt16LE(0x0314, 4)
  header.writeUInt16LE(20, 6)
  header.writeUInt16LE(UTF8_FLAG, 8)
  header.writeUInt16LE(0, 10)
  header.writeUInt16LE(0, 12)
  header.writeUInt16LE(DOS_DATE, 14)
  header.writeUInt32LE(entry.crc, 16)
  header.writeUInt32LE(entry.data.length, 20)
  header.writeUInt32LE(entry.data.length, 24)
  header.writeUInt16LE(entry.nameBytes.length, 28)
  header.writeUInt16LE(0, 30)
  header.writeUInt16LE(0, 32)
  header.writeUInt16LE(0, 34)
  header.writeUInt16LE(0, 36)
  header.writeUInt32LE((0o100644 << 16) >>> 0, 38)
  header.writeUInt32LE(entry.offset, 42)
  return header
}

/**
 * Build a ZIP archive with valid timestamps and regular-file permissions.
 */
export function createZipArchive(entries: readonly ZipArchiveEntry[]): Buffer {
  const records: ZipArchiveRecord[] = []
  const localParts: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8')
    const record: ZipArchiveRecord = {
      ...entry,
      crc: crc32(entry.data),
      nameBytes,
      offset,
    }
    const header = createLocalFileHeader(record)
    localParts.push(header, nameBytes, entry.data)
    offset += header.length + nameBytes.length + entry.data.length
    records.push(record)
  }

  const centralOffset = offset
  const centralParts: Buffer[] = []
  for (const record of records) {
    const header = createCentralDirectoryEntry(record)
    centralParts.push(header, record.nameBytes)
    offset += header.length + record.nameBytes.length
  }

  const centralSize = offset - centralOffset
  const end = Buffer.alloc(22)
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(records.length, 8)
  end.writeUInt16LE(records.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(centralOffset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...localParts, ...centralParts, end])
}

/**
 * Read STORE entries produced by `createZipArchive`.
 */
export function extractZipArchive(archive: Buffer): ZipArchiveEntry[] {
  const entries: ZipArchiveEntry[] = []
  let offset = 0

  while (
    offset + 4 <= archive.length &&
    archive.readUInt32LE(offset) === LOCAL_FILE_HEADER_SIGNATURE
  ) {
    const flags = archive.readUInt16LE(offset + 6)
    const method = archive.readUInt16LE(offset + 8)
    const size = archive.readUInt32LE(offset + 18)
    const nameLength = archive.readUInt16LE(offset + 26)
    const extraLength = archive.readUInt16LE(offset + 28)
    if ((flags & UTF8_FLAG) === 0 || method !== 0) {
      throw new Error('Unsupported ZIP entry encoding or compression method.')
    }
    const nameStart = offset + 30
    const dataStart = nameStart + nameLength + extraLength
    const dataEnd = dataStart + size
    if (dataEnd > archive.length) {
      throw new Error('ZIP entry extends beyond the archive.')
    }
    entries.push({
      data: archive.subarray(dataStart, dataEnd),
      name: archive.toString('utf8', nameStart, nameStart + nameLength),
    })
    offset = dataEnd
  }

  if (
    offset + 4 > archive.length ||
    archive.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE
  ) {
    throw new Error('ZIP central directory is missing or malformed.')
  }
  return entries
}
