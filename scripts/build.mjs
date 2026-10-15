import { build, context } from 'esbuild';
import { mkdir, copyFile, cp, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = new URL('../', import.meta.url), output = new URL('dist/', root);
export async function buildExtension({ watch = false } = {}) {
  await mkdir(output, { recursive: true });
  const options = {
    absWorkingDir: fileURLToPath(root),
    entryPoints: ['src/content.js', 'src/background.js'], outdir: 'dist',
    bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', minify: true,
    legalComments: 'none', charset: 'utf8',
    loader: { '.css': 'text' },
  };
  let watcher;
  if (watch) { watcher = await context(options);await watcher.rebuild();await watcher.watch(); }
  else await build(options);
  for (const file of ['manifest.json', 'LICENSE', 'THIRD_PARTY_NOTICES.txt']) await copyFile(new URL(file, root), new URL(file, output));
  await cp(new URL('_locales/', root), new URL('_locales/', output), { recursive: true });
  await mkdir(new URL('icons/', output), { recursive: true });
  for (const size of [16, 32, 48, 128]) await copyFile(new URL(`icons/icon${size}.png`, root), new URL(`icons/icon${size}.png`, output));
  const notices = await readFile(new URL('THIRD_PARTY_NOTICES.txt', root), 'utf8');
  await writeFile(new URL('NOTICE.txt', output), 'Nurupuru Anywhere — Unlicense. Physics based on Nurupuru 1.0.1.\nhttps://github.com/akeit0/nurupuru\n\n' + notices);
  console.log('Built dist/ — load this directory as an unpacked extension.');
  return watcher;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildExtension();
