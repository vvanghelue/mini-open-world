#!/usr/bin/env node
// Downloads the conifer textures (Poly Haven "fir_tree_01", CC0) into data-raw/trees/fir/. Existing files are skipped.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const OUT = path.join(ROOT, 'data-raw/trees/fir');
const BASE = 'https://dl.polyhaven.org/file/ph-assets/Models';
const FILES = {
  twig_diff: 'jpg', twig_alpha: 'png', twig_nor_gl: 'jpg', twig_arm: 'jpg', twig_mask: 'png',
  bark_diff: 'jpg', bark_nor_gl: 'jpg', bark_arm: 'jpg', trunk_a_diff: 'jpg', trunk_a_nor_gl: 'jpg',
};
fs.mkdirSync(OUT, { recursive: true });
for (const [name, ext] of Object.entries(FILES)) {
  const file = path.join(OUT, `${name}.${ext}`);
  if (fs.existsSync(file)) continue;
  const url = `${BASE}/${ext}/2k/fir_tree_01/fir_tree_01_${name}_2k.${ext}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  console.log('downloaded', path.relative(ROOT, file));
}
console.log('trees: ok');
