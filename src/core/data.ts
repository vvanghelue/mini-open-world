// Data file access. Dev server: raw files from public/data. Static build (GitHub Pages demo): the large binaries are
// packed by tools/data/pack-web.mjs (a byte predictor + gzip, listed in data/web.json) and decoded here.

/** Site base path ('/' in dev, '/mini-open-world/' on GitHub Pages). */
export const BASE_URL = import.meta.env.BASE_URL;
export const dataUrl = (path: string) => `${BASE_URL}data/${path}`;

/**
 * Packed file: codec 'gz' = gzip only; 'h16' = u16 heights, gradient predictor (left + up - upleft), zigzag residuals,
 * low then high byte planes; 'p4d' = 4-channel bytes split into planes, horizontal delta per row. w = row width.
 */
export interface PackedFile {
  codec: 'gz' | 'h16' | 'p4d';
  w: number;
  /** Packed (download) size in bytes. */
  packed: number;
}

let manifest: Promise<Record<string, PackedFile>> | null = null;
function getManifest(): Promise<Record<string, PackedFile>> {
  if (!import.meta.env.PROD) return Promise.resolve({});
  return (manifest ??= fetch(dataUrl('web.json'))
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({})));
}

/** Bytes that fetchData() downloads for this file (packed size in the static build), for progress bars. */
export async function downloadSize(path: string, rawSize: number): Promise<number> {
  return (await getManifest())[path]?.packed ?? rawSize;
}

export async function fetchJson(path: string) {
  const url = dataUrl(path);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status} (run "npm run data")`);
  return res.json();
}

/** Downloads a binary data file (decoding it when packed). onProgress receives the downloaded byte count. */
export async function fetchData(path: string, onProgress?: (loaded: number) => void): Promise<ArrayBuffer> {
  const packed = (await getManifest())[path];
  const url = dataUrl(packed ? path + '.gz' : path);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status} (run "npm run data")`);
  let stream: ReadableStream<Uint8Array> = res.body;
  if (onProgress) {
    let loaded = 0;
    stream = stream.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, ctl) {
          loaded += chunk.length;
          onProgress(loaded);
          ctl.enqueue(chunk);
        },
      }),
    );
  }
  let buf = await new Response(stream).arrayBuffer();
  if (!packed) return buf;
  const head = new Uint8Array(buf, 0, 2);
  // gzip magic; absent if a server already undid the compression (Content-Encoding)
  if (head[0] === 0x1f && head[1] === 0x8b) {
    const gunzip = new DecompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>;
    buf = await new Response(new Blob([buf]).stream().pipeThrough(gunzip)).arrayBuffer();
  }
  return decode(packed, new Uint8Array(buf));
}

function decode(p: PackedFile, src: Uint8Array): ArrayBuffer {
  if (p.codec === 'gz') return src.buffer as ArrayBuffer;
  const w = p.w;
  if (p.codec === 'h16') {
    const n = src.length / 2;
    const q = new Uint16Array(n);
    for (let i = 0; i < n; i++) {
      const z = src[i] | (src[n + i] << 8);
      const d = (z >>> 1) ^ -(z & 1);
      const x = i % w;
      const up = i >= w ? q[i - w] : 0;
      const pred = x === 0 ? up : i >= w ? q[i - 1] + up - q[i - w - 1] : q[i - 1];
      q[i] = (pred + d) & 0xffff;
    }
    return q.buffer;
  }
  // p4d
  const n = src.length / 4;
  const out = new Uint8Array(src.length);
  for (let k = 0; k < 4; k++) {
    const plane = k * n;
    for (let i = 0; i < n; i++) out[i * 4 + k] = (src[plane + i] + (i % w ? out[(i - 1) * 4 + k] : 0)) & 255;
  }
  return out.buffer;
}
