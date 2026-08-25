const test = require('node:test');
const assert = require('node:assert');

const { partitionObjects, planRetention } = require('../../../lib/feeds/retention');

// Modulo puro: dado o listing do bucket + as linhas do catalogo, decide o que
// pode ser apagado mantendo keepVersions chaves DISTINTAS por (feed, fileName).
// Regras criticas: objectKey e REUTILIZADO entre linhas (carry-forward/dedupe),
// entao a protecao vem do catalogo, nunca da idade do objeto no bucket.

const NOW = new Date('2026-08-24T12:00:00Z');
const GRACE_MS = 24 * 60 * 60 * 1000;
const FEEDS = ['keystone-ftp', 'ctp', 'omix', 'quadratec'];

const obj = (key, at, size = 10) => ({ key, size, lastModified: new Date(at) });

const row = (over = {}) => ({
	feed: 'ctp',
	fileName: 'a.csv',
	objectKey: 'feeds/ctp/2026/08/k1-a.csv',
	status: 'superseded',
	uploadedAt: new Date('2026-08-01'),
	...over,
});

const plan = (over = {}) => planRetention({
	objects: [],
	artifacts: [],
	feedNames: FEEDS,
	keepVersions: 2,
	graceMs: GRACE_MS,
	now: NOW,
	...over,
});

test('partitionObjects separa feeds conhecidos, _archive e prefixos desconhecidos', () => {
	const objects = [
		obj('feeds/ctp/2026/08/x-a.csv', '2026-08-01'),
		obj('feeds/_archive/2026/08/x-old.csv', '2026-08-01'),
		obj('feeds/quadratec-pricing/2026/08/x-p.xlsx', '2026-08-01'),
	];
	const { byFeed, archive, unknown } = partitionObjects({ objects, feedNames: FEEDS, keyPrefix: 'feeds' });
	assert.deepStrictEqual([...byFeed.keys()], ['ctp']);
	assert.strictEqual(archive.length, 1);
	assert.deepStrictEqual([...unknown.keys()], ['quadratec-pricing']);
});

test('catalogo vazio aborta: banco errado/vazio transformaria tudo em orfao', () => {
	assert.throws(
		() => plan({ objects: [obj('feeds/ctp/2026/08/k1-a.csv', '2026-08-01')] }),
		/catalog is empty/
	);
});

test('3 versoes do mesmo arquivo: apaga so a mais antiga', () => {
	const k1 = 'feeds/ctp/2026/07/k1-a.csv';
	const k2 = 'feeds/ctp/2026/08/k2-a.csv';
	const k3 = 'feeds/ctp/2026/08/k3-a.csv';
	const result = plan({
		objects: [obj(k1, '2026-07-01'), obj(k2, '2026-08-01'), obj(k3, '2026-08-10')],
		artifacts: [
			row({ objectKey: k1, uploadedAt: new Date('2026-07-01') }),
			row({ objectKey: k2, uploadedAt: new Date('2026-08-01') }),
			row({ objectKey: k3, status: 'available', uploadedAt: new Date('2026-08-10') }),
		],
	});
	assert.deepStrictEqual(result.toDelete.map((entry) => entry.key), [k1]);
});

test('carry-forward: linha available aponta para objeto ANTIGO — protegido', () => {
	const kOld = 'feeds/quadratec/2026/05/k1-prices.xlsx';
	const kNew = 'feeds/quadratec/2026/08/k2-inv.csv';
	const result = plan({
		objects: [obj(kOld, '2026-05-01'), obj(kNew, '2026-08-20')],
		artifacts: [
			row({ feed: 'quadratec', fileName: 'prices.xlsx', objectKey: kOld, status: 'available', uploadedAt: new Date('2026-08-20') }),
			row({ feed: 'quadratec', fileName: 'inv.csv', objectKey: kNew, status: 'available', uploadedAt: new Date('2026-08-20') }),
		],
	});
	assert.deepStrictEqual(result.toDelete, []);
});

test('dedupe A-B-A: linha nova reusa chave antiga — as duas chaves ficam', () => {
	const kA = 'feeds/ctp/2026/07/kA-a.csv';
	const kB = 'feeds/ctp/2026/08/kB-a.csv';
	const result = plan({
		objects: [obj(kA, '2026-07-01'), obj(kB, '2026-08-05')],
		artifacts: [
			row({ objectKey: kA, uploadedAt: new Date('2026-07-01') }),
			row({ objectKey: kB, uploadedAt: new Date('2026-08-05') }),
			row({ objectKey: kA, status: 'available', uploadedAt: new Date('2026-08-10') }),
		],
	});
	assert.deepStrictEqual(result.toDelete, []);
});

test('chave compartilhada por 2 linhas conta como UMA versao no ranking', () => {
	const k1 = 'feeds/ctp/2026/07/k1-a.csv';
	const k2 = 'feeds/ctp/2026/08/k2-a.csv';
	const k3 = 'feeds/ctp/2026/08/k3-a.csv';
	const result = plan({
		objects: [obj(k1, '2026-07-01'), obj(k2, '2026-08-05'), obj(k3, '2026-08-10')],
		artifacts: [
			row({ objectKey: k1, uploadedAt: new Date('2026-07-01') }),
			row({ objectKey: k1, uploadedAt: new Date('2026-07-15') }),
			row({ objectKey: k2, uploadedAt: new Date('2026-08-05') }),
			row({ objectKey: k3, status: 'available', uploadedAt: new Date('2026-08-10') }),
		],
	});
	assert.deepStrictEqual(result.toDelete.map((entry) => entry.key), [k1]);
});

test('orfao (sem linha no catalogo): apaga fora da graca, mantem dentro dela', () => {
	const kCurrent = 'feeds/ctp/2026/08/k1-a.csv';
	const kOrphanOld = 'feeds/ctp/2026/08/orphan-old.csv';
	const kOrphanNew = 'feeds/ctp/2026/08/orphan-new.csv';
	const result = plan({
		objects: [
			obj(kCurrent, '2026-08-10'),
			obj(kOrphanOld, '2026-08-01'),
			obj(kOrphanNew, '2026-08-24T11:30:00Z'),
		],
		artifacts: [row({ objectKey: kCurrent, status: 'available', uploadedAt: new Date('2026-08-10') })],
	});
	assert.deepStrictEqual(result.toDelete.map((entry) => entry.key), [kOrphanOld]);
	assert.deepStrictEqual(result.orphans.map((entry) => entry.key).sort(), [kOrphanNew, kOrphanOld].sort());
});

test('quarantined e protegido mesmo velho e fora do ranking', () => {
	const kQ = 'feeds/ctp/2026/06/kq-a.csv';
	const k2 = 'feeds/ctp/2026/08/k2-a.csv';
	const k3 = 'feeds/ctp/2026/08/k3-a.csv';
	const result = plan({
		objects: [obj(kQ, '2026-06-01'), obj(k2, '2026-08-05'), obj(k3, '2026-08-10')],
		artifacts: [
			row({ objectKey: kQ, status: 'quarantined', uploadedAt: new Date('2026-06-01') }),
			row({ objectKey: k2, uploadedAt: new Date('2026-08-05') }),
			row({ objectKey: k3, status: 'available', uploadedAt: new Date('2026-08-10') }),
		],
	});
	assert.deepStrictEqual(result.toDelete, []);
});

test('purged fica fora do ranking e o objeto so-purged pode ser apagado (self-heal)', () => {
	const k1 = 'feeds/ctp/2026/07/k1-a.csv';
	const k2 = 'feeds/ctp/2026/08/k2-a.csv';
	const k3 = 'feeds/ctp/2026/08/k3-a.csv';
	const result = plan({
		objects: [obj(k1, '2026-07-01'), obj(k2, '2026-08-05'), obj(k3, '2026-08-10')],
		artifacts: [
			row({ objectKey: k1, status: 'purged', uploadedAt: new Date('2026-07-01') }),
			row({ objectKey: k2, uploadedAt: new Date('2026-08-05') }),
			row({ objectKey: k3, status: 'available', uploadedAt: new Date('2026-08-10') }),
		],
	});
	assert.deepStrictEqual(result.toDelete.map((entry) => entry.key), [k1]);
});

test('feed com uma versao so: nada a apagar (keepVersions e teto, nao meta)', () => {
	const k1 = 'feeds/omix/2026/08/k1-omix.xlsx';
	const result = plan({
		objects: [obj(k1, '2026-08-07')],
		artifacts: [row({ feed: 'omix', fileName: 'omix.xlsx', objectKey: k1, status: 'available', uploadedAt: new Date('2026-08-07') })],
	});
	assert.deepStrictEqual(result.toDelete, []);
});

test('multi-arquivo: ranking independente por fileName', () => {
	const a1 = 'feeds/keystone-ftp/2026/07/a1-Inventory.csv';
	const a2 = 'feeds/keystone-ftp/2026/08/a2-Inventory.csv';
	const a3 = 'feeds/keystone-ftp/2026/08/a3-Inventory.csv';
	const b1 = 'feeds/keystone-ftp/2026/07/b1-SpecialOrder.csv';
	const result = plan({
		objects: [obj(a1, '2026-07-01'), obj(a2, '2026-08-05'), obj(a3, '2026-08-10'), obj(b1, '2026-07-01')],
		artifacts: [
			row({ feed: 'keystone-ftp', fileName: 'Inventory.csv', objectKey: a1, uploadedAt: new Date('2026-07-01') }),
			row({ feed: 'keystone-ftp', fileName: 'Inventory.csv', objectKey: a2, uploadedAt: new Date('2026-08-05') }),
			row({ feed: 'keystone-ftp', fileName: 'Inventory.csv', objectKey: a3, status: 'available', uploadedAt: new Date('2026-08-10') }),
			row({ feed: 'keystone-ftp', fileName: 'SpecialOrder.csv', objectKey: b1, status: 'available', uploadedAt: new Date('2026-07-01') }),
		],
	});
	assert.deepStrictEqual(result.toDelete.map((entry) => entry.key), [a1]);
});

test('prefixo desconhecido: intocavel e reportado, mesmo referenciado por linha vigente de outro feed', () => {
	const kLegacy = 'feeds/quadratec-pricing/2026/05/k1-prices.xlsx';
	const kCurrent = 'feeds/ctp/2026/08/k1-a.csv';
	const result = plan({
		objects: [obj(kLegacy, '2026-05-01', 100), obj(kCurrent, '2026-08-10')],
		artifacts: [
			row({ feed: 'quadratec', fileName: 'prices.xlsx', objectKey: kLegacy, status: 'available', uploadedAt: new Date('2026-08-20') }),
			row({ objectKey: kCurrent, status: 'available', uploadedAt: new Date('2026-08-10') }),
		],
	});
	assert.deepStrictEqual(result.toDelete, []);
	assert.deepStrictEqual(result.report.unknownPrefixes, { 'quadratec-pricing': { count: 1, bytes: 100 } });
});

test('_archive: intocavel e reportado', () => {
	const kArchive = 'feeds/_archive/2026/08/k1-orphan.xlsx';
	const kCurrent = 'feeds/ctp/2026/08/k1-a.csv';
	const result = plan({
		objects: [obj(kArchive, '2026-08-05', 50), obj(kCurrent, '2026-08-10')],
		artifacts: [
			row({ feed: '_archive', fileName: 'orphan.xlsx', objectKey: kArchive, status: 'available', uploadedAt: new Date('2026-08-05') }),
			row({ objectKey: kCurrent, status: 'available', uploadedAt: new Date('2026-08-10') }),
		],
	});
	assert.deepStrictEqual(result.toDelete, []);
	assert.deepStrictEqual(result.report.archive, { count: 1, bytes: 50 });
});

test('feed com objetos e ZERO linhas: report-only (protecao contra banco divergente)', () => {
	const kMystery = 'feeds/omix/2026/08/k1-omix.xlsx';
	const kCurrent = 'feeds/ctp/2026/08/k1-a.csv';
	const result = plan({
		objects: [obj(kMystery, '2026-06-01'), obj(kCurrent, '2026-08-10')],
		artifacts: [row({ objectKey: kCurrent, status: 'available', uploadedAt: new Date('2026-08-10') })],
	});
	assert.deepStrictEqual(result.toDelete, []);
	assert.strictEqual(result.report.feeds.omix.eligible, false);
});

test('feed sem linha available (so superseded): nada e apagado nele', () => {
	const k1 = 'feeds/ctp/2026/07/k1-a.csv';
	const k2 = 'feeds/ctp/2026/08/k2-a.csv';
	const k3 = 'feeds/ctp/2026/08/k3-a.csv';
	const kOther = 'feeds/omix/2026/08/k1-omix.xlsx';
	const result = plan({
		objects: [obj(k1, '2026-07-01'), obj(k2, '2026-08-01'), obj(k3, '2026-08-10'), obj(kOther, '2026-08-07')],
		artifacts: [
			row({ objectKey: k1, uploadedAt: new Date('2026-07-01') }),
			row({ objectKey: k2, uploadedAt: new Date('2026-08-01') }),
			row({ objectKey: k3, uploadedAt: new Date('2026-08-10') }),
			row({ feed: 'omix', fileName: 'omix.xlsx', objectKey: kOther, status: 'available', uploadedAt: new Date('2026-08-07') }),
		],
	});
	assert.deepStrictEqual(result.toDelete, []);
	assert.strictEqual(result.report.feeds.ctp.eligible, false);
});

test('missingFromBucket: linha viva apontando para chave ausente do listing e reportada', () => {
	const kCurrent = 'feeds/ctp/2026/08/k1-a.csv';
	const kGone = 'feeds/ctp/2026/07/gone-a.csv';
	const result = plan({
		objects: [obj(kCurrent, '2026-08-10')],
		artifacts: [
			row({ objectKey: kCurrent, status: 'available', uploadedAt: new Date('2026-08-10') }),
			row({ objectKey: kGone, uploadedAt: new Date('2026-07-01') }),
		],
	});
	assert.deepStrictEqual(result.missingFromBucket, [kGone]);
	assert.deepStrictEqual(result.toDelete, []);
});
