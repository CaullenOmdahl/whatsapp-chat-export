import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { suite, check, checkAsync, eq, ok, summary, loadLibsInNode } from './harness.mjs';

loadLibsInNode(['src/lib/namespace.js', 'src/lib/zip.js']);
const zip = globalThis.WAEx.zip;

suite('zip: crc32');

check('known CRC-32 vector', () => {
  const bytes = new TextEncoder().encode('123456789');
  eq(zip.crc32(bytes), 0xcbf43926);
});

check('empty input', () => {
  eq(zip.crc32(new Uint8Array(0)), 0);
});

suite('zip: archive structure');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wax-zip-'));

function pyInspect(file, script) {
  return execFileSync(
    'python3',
    ['-c', `import zipfile,json,sys\nz=zipfile.ZipFile(${JSON.stringify(file)})\n${script}`],
    { encoding: 'utf8' }
  ).trim();
}

await checkAsync('writes a readable archive with correct contents', async () => {
  const archive = zip.create();
  await archive.add('report.html', '<html><body>hello</body></html>', { compress: true });
  await archive.add('media/0001-photo.jpg', new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]));
  await archive.add('media/0002-note.txt', 'plain text payload '.repeat(50), { compress: true });

  eq(archive.count, 3);
  eq(archive.names.length, 3);

  const blob = archive.generate();
  ok(blob.size > 100, 'archive should not be empty');

  const file = path.join(tempDir, 'basic.zip');
  fs.writeFileSync(file, new Uint8Array(await blob.arrayBuffer()));

  const result = pyInspect(
    file,
    'print(json.dumps({"names": z.namelist(), "bad": z.testzip(), "report": z.read("report.html").decode()}))'
  );
  const parsed = JSON.parse(result);
  eq(parsed.names, ['report.html', 'media/0001-photo.jpg', 'media/0002-note.txt']);
  eq(parsed.bad, null, 'all CRCs must validate');
  eq(parsed.report, '<html><body>hello</body></html>');
});

await checkAsync('deflate is applied when it saves space', async () => {
  const archive = zip.create();
  await archive.add('big.txt', 'compress me '.repeat(2000), { compress: true });
  await archive.add('flat.txt', 'compress me '.repeat(2000), { compress: false });
  const blob = archive.generate();
  const file = path.join(tempDir, 'deflate.zip');
  fs.writeFileSync(file, new Uint8Array(await blob.arrayBuffer()));

  const result = pyInspect(
    file,
    'print(json.dumps({i.filename: [i.compress_type, i.file_size, i.compress_size] for i in z.infolist()}))'
  );
  const parsed = JSON.parse(result);
  eq(parsed['big.txt'][0], 8, 'deflate method');
  ok(parsed['big.txt'][2] < parsed['big.txt'][1], 'deflated size must be smaller');
  eq(parsed['flat.txt'][0], 0, 'stored method');
  eq(parsed['flat.txt'][2], parsed['flat.txt'][1]);
});

await checkAsync('unicode and duplicate names are handled', async () => {
  const archive = zip.create();
  await archive.add('média/фото 📷.jpg', new Uint8Array([1, 2, 3]));
  await archive.add('same.txt', 'one');
  await archive.add('same.txt', 'two');
  const blob = archive.generate();
  const file = path.join(tempDir, 'unicode.zip');
  fs.writeFileSync(file, new Uint8Array(await blob.arrayBuffer()));

  const result = pyInspect(file, 'print(json.dumps(z.namelist()))');
  const names = JSON.parse(result);
  eq(names.length, 3);
  eq(names[0], 'média/фото 📷.jpg');
  eq(names[1], 'same.txt');
  eq(names[2], 'same (2).txt');
});

await checkAsync('path traversal and leading slashes are neutralised', async () => {
  const archive = zip.create();
  await archive.add('../../etc/passwd', 'nope');
  await archive.add('/root/.ssh/id_rsa', 'nope');
  const blob = archive.generate();
  const file = path.join(tempDir, 'traversal.zip');
  fs.writeFileSync(file, new Uint8Array(await blob.arrayBuffer()));

  const result = pyInspect(file, 'print(json.dumps(z.namelist()))');
  const names = JSON.parse(result);
  eq(names, ['etc/passwd', 'root/.ssh/id_rsa']);
});

await checkAsync('archive is deterministic for identical input', async () => {
  const fixed = new Date(2023, 10, 14, 10, 30, 0);
  const build = async () => {
    const archive = zip.create();
    await archive.add('a.txt', 'hello', { compress: false, date: fixed });
    return new Uint8Array(await archive.generate().arrayBuffer());
  };
  const first = await build();
  const second = await build();
  eq(Buffer.from(first).toString('hex'), Buffer.from(second).toString('hex'));
});

await checkAsync('closed archive refuses further writes', async () => {
  const archive = zip.create();
  archive.generate();
  let threw = false;
  try {
    await archive.add('late.txt', 'x');
  } catch (err) {
    threw = true;
  }
  ok(threw, 'expected an error after generate()');
});

process.exit(summary() ? 0 : 1);
