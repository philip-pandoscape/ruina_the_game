// The wire's small numbers, as crates/wire/src/bytes.rs writes them: little-endian fixed widths, and
// varints (LEB128: seven bits a byte, the high bit set while more follow), signed ones zigzagged first
// so a small negative is small too. Numbers here are JavaScript's: exact to 2^53, which every id and
// mask the wire carries stays under.

/** A message that isn't what it was read as. */
export class BadMessage extends Error {}

const TWO_32 = 4294967296;

/** Reads a message front to back. */
export class Reader {
  private at = 0;
  private readonly view: DataView;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get done(): boolean {
    return this.at >= this.bytes.length;
  }

  u8(): number {
    if (this.at >= this.bytes.length) throw new BadMessage('it ends too soon');
    return this.bytes[this.at++];
  }

  u16(): number {
    if (this.at + 2 > this.bytes.length) throw new BadMessage('it ends too soon');
    const v = this.view.getUint16(this.at, true);
    this.at += 2;
    return v;
  }

  u32(): number {
    if (this.at + 4 > this.bytes.length) throw new BadMessage('it ends too soon');
    const v = this.view.getUint32(this.at, true);
    this.at += 4;
    return v;
  }

  /** An unsigned varint, as a number (exact to 2^53). */
  varint(): number {
    let v = 0;
    let scale = 1;
    for (let k = 0; k < 10; k++) {
      const b = this.u8();
      v += (b & 0x7f) * scale;
      if (b < 0x80) return v;
      scale *= 128;
    }
    throw new BadMessage('a varint that never ends');
  }

  /** A varint that must fit in 32 bits (a field's difference). */
  varint32(): number {
    const v = this.varint();
    if (v >= TWO_32) throw new BadMessage('a varint past 32 bits');
    return v;
  }

  /** A zigzagged signed number (an id). */
  zigzag(): number {
    const u = this.varint();
    return u % 2 === 0 ? u / 2 : -(u + 1) / 2;
  }

  bytesOf(n: number): Uint8Array {
    if (this.at + n > this.bytes.length) throw new BadMessage('it ends too soon');
    const b = this.bytes.subarray(this.at, this.at + n);
    this.at += n;
    return b;
  }
}

/** A field's difference, from its zigzag: an i32. */
export function unzigzag32(u: number): number {
  return (u >>> 1) ^ -(u & 1);
}

/** Whether bit `i` (0..52) of a mask is set. */
export function bit(mask: number, i: number): boolean {
  const word = i < 32 ? mask % TWO_32 : Math.floor(mask / TWO_32);
  return ((word >>> (i % 32)) & 1) === 1;
}
