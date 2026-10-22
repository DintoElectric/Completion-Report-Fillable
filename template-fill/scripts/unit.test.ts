import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptList, fileTypeOf, magicMatches } from '../shared/limits.ts';
import { parse } from '../src/app/router.ts';

test('file types come from the name; renamed files are caught by their first bytes', () => {
  assert.equal(fileTypeOf('Bid Form.XLSX'), 'xlsx');
  assert.equal(fileTypeOf('site photo.jpeg'), 'jpg');
  assert.equal(fileTypeOf('notes'), null);
  assert.equal(fileTypeOf('drawing.dwg'), null);
  const bytes = (s: number[]) => new Uint8Array(s);
  assert.ok(magicMatches('pdf', bytes([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])));        // %PDF-1
  assert.ok(!magicMatches('pdf', bytes([0x50, 0x4b, 0x03, 0x04, 0, 0])));              // a zip named .pdf
  assert.ok(magicMatches('xlsx', bytes([0x50, 0x4b, 0x03, 0x04])));
  assert.ok(magicMatches('csv', bytes([0x61, 0x2c, 0x62])));                          // text has no signature
});

test('templates accept Word, Excel and PDF; documents accept more', () => {
  assert.equal(acceptList('template'), '.pdf,.docx,.xlsx');
  assert.ok(acceptList('source').includes('.csv') && acceptList('source').includes('.jpg,.jpeg'));
});

test('routes', () => {
  assert.deepEqual(parse('/'), { name: 'jobs' });
  assert.deepEqual(parse('/j/abc'), { name: 'job', id: 'abc' });
  assert.deepEqual(parse('/j/abc/fill'), { name: 'fill', id: 'abc' });
  assert.deepEqual(parse('/templates/'), { name: 'templates' });
  assert.deepEqual(parse('/nowhere'), { name: 'jobs' });
});
