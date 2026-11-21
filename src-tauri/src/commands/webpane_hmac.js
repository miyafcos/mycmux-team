// Only used inside document-start closures. Keep the key and intermediate
// bytes out of methods that the document could replace after initialization.
(key) => {
  const Bytes = Uint8Array;
  const Words = Uint32Array;
  const call = (method) => Function.prototype.call.bind(method);
  const setBytes = call(Bytes.prototype.set);
  const length = call(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Bytes.prototype), "length").get);
  const encode = TextEncoder.prototype.encode.bind(new TextEncoder());
  const floor = Math.floor;
  const digits = "0123456789abcdef";
  const initial = new Words([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const round = new Words([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const rotate = (word, bits) => (word >>> bits) | (word << (32 - bits));

  function sha256(bytes) {
    const size = length(bytes);
    const paddedSize = (size + 9 + 63) & ~63;
    const padded = new Bytes(paddedSize);
    setBytes(padded, bytes);
    padded[size] = 0x80;
    let bitLength = size * 8;
    for (let i = paddedSize - 1; i >= paddedSize - 8; i--) {
      padded[i] = bitLength & 255;
      bitLength = floor(bitLength / 256);
    }
    const state = new Words(8);
    setBytes(state, initial);
    const words = new Words(64);
    for (let offset = 0; offset < paddedSize; offset += 64) {
      for (let i = 0; i < 16; i++) {
        const index = offset + i * 4;
        words[i] = (padded[index] << 24) | (padded[index + 1] << 16)
          | (padded[index + 2] << 8) | padded[index + 3];
      }
      for (let i = 16; i < 64; i++) {
        const left = words[i - 15];
        const right = words[i - 2];
        const sigma0 = rotate(left, 7) ^ rotate(left, 18) ^ (left >>> 3);
        const sigma1 = rotate(right, 17) ^ rotate(right, 19) ^ (right >>> 10);
        words[i] = words[i - 16] + sigma0 + words[i - 7] + sigma1;
      }
      let a = state[0], b = state[1], c = state[2], d = state[3];
      let e = state[4], f = state[5], g = state[6], h = state[7];
      for (let i = 0; i < 64; i++) {
        const sum1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
        const choose = (e & f) ^ (~e & g);
        const t1 = h + sum1 + choose + round[i] + words[i];
        const sum0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
        const majority = (a & b) ^ (a & c) ^ (b & c);
        h = g;
        g = f;
        f = e;
        e = (d + t1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (t1 + sum0 + majority) >>> 0;
      }
      state[0] += a;
      state[1] += b;
      state[2] += c;
      state[3] += d;
      state[4] += e;
      state[5] += f;
      state[6] += g;
      state[7] += h;
    }
    const digest = new Bytes(32);
    for (let i = 0; i < 32; i++) {
      digest[i] = state[i >>> 2] >>> (24 - (i & 3) * 8);
    }
    return digest;
  }

  const keyBytes = encode(key);
  const block = length(keyBytes) > 64 ? sha256(keyBytes) : keyBytes;
  const inner = new Bytes(64);
  const outer = new Bytes(64);
  for (let i = 0; i < 64; i++) {
    inner[i] = 0x36 ^ (block[i] ?? 0);
    outer[i] = 0x5c ^ (block[i] ?? 0);
  }
  return (message) => {
    const bytes = encode(message);
    const input = new Bytes(64 + length(bytes));
    setBytes(input, inner);
    setBytes(input, bytes, 64);
    const digest = new Bytes(96);
    setBytes(digest, outer);
    setBytes(digest, sha256(input), 64);
    const result = sha256(digest);
    let hex = "";
    for (let i = 0; i < 32; i++) {
      hex += digits[result[i] >>> 4] + digits[result[i] & 15];
    }
    return hex;
  };
}
