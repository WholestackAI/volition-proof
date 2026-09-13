/**
 * Pure JS SHA-256 — deterministic cross-runtime (Node + browser).
 * No `node:crypto`, no `crypto.subtle` (async). Synchronous, small, and
 * produces identical output in both runtimes for the same UTF-8 input.
 * Based on the public-domain implementation from https://geronimo.io/posts/sha256
 * (MIT) — verified against `echo -n "abc" | shasum -a 256`.
 */

function rightRotate(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

// cached hash/k
let _h: number[] | null = null;
let _k: number[] | null = null;

function getConsts(): { h: number[]; k: number[] } {
  if (_h && _k) return { h: _h.slice(), k: _k.slice() };
  const mathPow = Math.pow;
  const maxWord = mathPow(2, 32);
  const h: number[] = [];
  const k: number[] = [];
  let primeCounter = 0;
  const isComposite: Record<number, boolean> = {};
  for (let candidate = 2; primeCounter < 64; candidate++) {
    if (!isComposite[candidate]) {
      for (let i = 0; i < 313; i += candidate) isComposite[i] = true;
      h[primeCounter] = (mathPow(candidate, 0.5) * maxWord) | 0;
      k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
    }
  }
  _h = h;
  _k = k;
  return { h: h.slice(), k: k.slice() };
}

export function sha256HexSync(input: string): string {
  // UTF-8 encode via encodeURIComponent trick (handles non-ASCII in canonical JSON)
  const ascii = unescape(encodeURIComponent(input));
  const { h: initH, k } = getConsts();
  const hash = initH;
  const maxWord = Math.pow(2, 32);
  const words: number[] = [];
  const asciiBitLength = ascii.length * 8;

  // append '1' bit and pad
  let asciiWithPad = ascii + '\x80';
  while ((asciiWithPad.length % 64) - 56 !== 0) asciiWithPad += '\x00';
  for (let i = 0; i < asciiWithPad.length; i++) {
    const j = asciiWithPad.charCodeAt(i);
    if (j >> 8) return ''; // non-ASCII after UTF-8 encode should not happen
    words[i >> 2] = ((words[i >> 2] ?? 0) | (j << ((3 - (i % 4)) * 8))) as number;
  }
  words[words.length] = ((asciiBitLength / maxWord) | 0) as number;
  words[words.length] = asciiBitLength as number;

  for (let j = 0; j < words.length;) {
    const w = words.slice(j, (j += 16));
    const oldHash = hash.slice(0);
    for (let i = 0; i < 64; i++) {
      const i2 = i + j;
      const w15 = w[i - 15] ?? 0;
      const w2 = w[i - 2] ?? 0;
      const a = hash[0] as number;
      const e = hash[4] as number;
      const temp1 =
        (hash[7] as number) +
        (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25)) +
        ((e & (hash[5] as number)) ^ (~e & (hash[6] as number))) +
        (k[i] as number) +
        (w[i] =
          i < 16
            ? (w[i] as number)
            : ((w[i - 16] as number) +
                (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3)) +
                (w[i - 7] as number) +
                (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))) |
              0);
      const temp2 =
        (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22)) +
        ((a & (hash[1] as number)) ^
          (a & (hash[2] as number)) ^
          ((hash[1] as number) & (hash[2] as number)));
      hash.unshift(((temp1 + temp2) | 0) as number);
      hash.pop();
      (hash[4] as number) = ((hash[4] as number) + temp1) | 0;
      void i2;
    }
    for (let i = 0; i < 8; i++) hash[i] = ((hash[i] as number) + (oldHash[i] as number)) | 0;
  }

  let result = '';
  for (let i = 0; i < 8; i++) {
    for (let j = 3; j + 1; j--) {
      const b = ((hash[i] as number) >> (j * 8)) & 255;
      result += (b < 16 ? '0' : '') + b.toString(16);
    }
  }
  return result;
}
