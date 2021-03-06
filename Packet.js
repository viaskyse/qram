/*!
 * Copyright (c) 2019 Digital Bazaar, Inc. All rights reserved.
 */
'use strict';

import {MH_SHA_256, sha256} from './hash.js';

const VERSION = 0x01;
const MIN_PACKET_SIZE = 82; // (1 + 2 + 4 + 2 + 34 + 34 + 4 + 1)
const SHA_256_LENGTH = 32;

export class Packet {
  constructor({header, payload, data} = {}) {
    this.header = header;
    this.payload = payload;
    this.data = data;
  }

  subtractBlock({index, block, data}) {
    const {header, payload} = this;
    const idx = header.indexes.indexOf(index);
    if(idx === -1) {
      throw new Error(`Block "${index}" is not in this packet.`);
    }
    if(block.length !== header.blockSize) {
      throw new Error(
        `Block length (${block.length}) must match the length of the ` +
        `block size specified in the packet header (${header.blockSize}).`);
    }

    // subtract block...
    header.indexes.splice(idx, 1);

    // if only one block will remain after subtraction, write it directly
    // into the decoded data and return a view for it
    if(header.indexes.length === 1) {
      // write xor'd payload into `data` as a block to return
      const {blockSize} = header;
      const [decodedIndex] = header.indexes;
      const offset = decodedIndex * blockSize;
      const decoded = new Uint8Array(
        data.buffer, data.byteOffset + offset, blockSize);
      for(let i = 0; i < payload.length; ++i) {
        decoded[i] = payload[i] ^ block[i];
      }
      return {index: header.indexes[0], block: decoded};
    }

    // more than one block will remain in the packet, do subtraction and
    // overwrite payload...
    for(let i = 0; i < payload.length; ++i) {
      payload[i] ^= block[i];
    }
  }

  subtractPacket({packet, targetIndex, data}) {
    const {header, payload} = this;
    const idx = header.indexes.indexOf(targetIndex);
    if(idx === -1) {
      throw new Error(`Block "${targetIndex}" is not in this packet.`);
    }

    // subtract packet payload to produce block, writing directly into the
    // decoded data and returning the block view
    const {payload: otherPayload} = packet;
    const {blockSize} = header;
    const offset = targetIndex * blockSize;
    const block = new Uint8Array(
      data.buffer, data.byteOffset + offset, blockSize);
    for(let i = 0; i < payload.length; ++i) {
      block[i] = payload[i] ^ otherPayload[i];
    }

    return {index: targetIndex, block};
  }

  static async create({
    totalSize, blocks, indexes, blockSize, digest,
    digestAlgorithm = {name: 'SHA-256'}
  }) {
    if(typeof totalSize !== 'number') {
      throw new TypeError('"totalSize" must be a number.');
    }
    if(!Array.isArray(blocks)) {
      throw new TypeError('"blocks" must be an array.');
    }
    if(!Array.isArray(indexes)) {
      throw new TypeError('"indexes" must be an array.');
    }
    if(typeof blockSize !== 'number') {
      throw new TypeError('"blockSize" must be a number.');
    }
    if(!(digest instanceof Uint8Array)) {
      throw new TypeError('"digest" must be a Uint8Array.');
    }
    if(digestAlgorithm.name !== 'SHA-256') {
      throw Error(`Unsupported digest algorithm "${digestAlgorithm.name}".`);
    }

    // determine total packet size
    const headerSize = this.getHeaderSize({indexCount: indexes.length});
    const packetSize = headerSize + blockSize;

    const data = new Uint8Array(packetSize);

    // create packet payload
    const payload = new Uint8Array(
      data.buffer, data.byteOffset + headerSize, blockSize);

    // xor blocks together to form packet payload
    for(let i = 0; i < blocks.length; ++i) {
      const block = blocks[i];
      for(let j = 0; j < blockSize; ++j) {
        payload[j] ^= block[j];
      }
    }

    // create packet header
    const header = {
      version: VERSION,
      size: headerSize,
      totalSize,
      blockCount: blocks.length,
      indexes,
      packetDigest: await sha256(payload),
      digest,
      blockSize
    };
    this._writeHeader({header, data});

    return new Packet({header, payload, data});
  }

  static async parse({data}) {
    if(!(data instanceof Uint8Array || data instanceof Uint8ClampedArray)) {
      throw new TypeError('"data" must be a Uint8Array or Uint8ClampedArray.');
    }
    if(data.length < MIN_PACKET_SIZE) {
      throw new Error(
        `Invalid packet size (${data.length}); packet must be at least ` +
        `${MIN_PACKET_SIZE} bytes.`);
    }

    // parse header
    const header = this._parseHeader({data});

    // parse payload
    const payload = new Uint8Array(
      data.buffer, data.byteOffset + header.size, header.blockSize);
    const packetSize = header.size + payload.length;
    if(data.length !== packetSize) {
      throw new Error(`Invalid packet size; expected ${packetSize}.`);
    }

    // verify payload digest
    const digest = await sha256(payload);
    // Note: constant time comparison not considered a requirement
    for(let i = 0; i < digest.length; ++i) {
      if(digest[i] !== header.packetDigest[i]) {
        throw new Error('Packet checksum does not match.');
      }
    }

    return new Packet({header, payload, data});
  }

  static getHeaderSize({digestSize = SHA_256_LENGTH, indexCount}) {
    // TODO: change to CBOR serialization
    const headerSize =
      1 + // 1 byte version 0x01
      2 + // uint16 header size
      4 + // uint32 total size of the data
      2 + // uint16 # of blocks in the packet
      indexCount * 2 + // uint16 for each block index, in order
      (2 + digestSize) + // multihash-encoded *packet* digest
      (2 + digestSize) + // multihash-encoded *full data* digest
      4; // uint32 of blockSize
    return headerSize;
  }

  static _writeHeader({header, data}) {
    // TODO: change to CBOR serialization
    const hData = new Uint8Array(data.buffer, data.byteOffset, header.size);
    const dv = new DataView(hData.buffer, hData.byteOffset, hData.length);
    let offset = 0;
    hData[offset] = header.version;
    dv.setUint16(offset += 1, header.size);
    dv.setUint32(offset += 2, header.totalSize);
    dv.setUint16(offset += 4, header.blockCount);
    header.indexes.forEach(i => dv.setUint16(offset += 2, i));
    hData.set(header.packetDigest, offset += 2);
    hData.set(header.digest, offset += header.packetDigest.length);
    dv.setUint32(offset += header.digest.length, header.blockSize);
  }

  static _parseHeader({data}) {
    // TODO: change to CBOR serialization

    // parse header
    let offset = 0;
    if(data[offset] !== VERSION) {
      // invalid version
      throw new Error('Invalid version.');
    }

    const header = {version: VERSION};
    const dv = new DataView(data.buffer, data.byteOffet, data.length);
    header.size = dv.getUint16(offset += 1);
    header.totalSize = dv.getUint32(offset += 2);
    header.blockCount = dv.getUint16(offset += 4);
    header.indexes = new Array(header.blockCount);
    for(let i = 0; i < header.blockCount; ++i) {
      header.indexes[i] = dv.getUint16(offset += 2);
    }
    let mh1 = dv.getUint8(offset += 2);
    let mh2 = dv.getUint8(offset += 1);
    if(!(mh1 === MH_SHA_256 && mh2 === SHA_256_LENGTH)) {
      throw Error(`Unsupported multihash codec "${mh1}".`);
    }
    header.packetDigest = new Uint8Array(
      data.buffer, data.byteOffset + offset - 1, 2 + SHA_256_LENGTH);
    mh1 = dv.getUint8(offset += (1 + SHA_256_LENGTH));
    mh2 = dv.getUint8(offset += 1);
    if(!(mh1 === MH_SHA_256 && mh2 === SHA_256_LENGTH)) {
      throw Error(`Unsupported multihash codec "${mh1}".`);
    }
    header.digest = new Uint8Array(
      data.buffer, data.byteOffset + offset - 1, 2 + SHA_256_LENGTH);
    header.blockSize = dv.getUint32(offset += (1 + SHA_256_LENGTH));
    offset += 4;

    // verify payload size
    if(header.blockSize !== (data.length - offset)) {
      throw new Error(
        `Block size (${header.blockSize}) does not match packet payload ` +
        `size (${data.length - offset}).`);
    }

    return header;
  }
}
