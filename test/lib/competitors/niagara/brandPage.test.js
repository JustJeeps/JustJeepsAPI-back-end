const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { parseBrandPage } = require('../../../../lib/competitors/niagara/brandPage');

const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'shop-by-brand.html'), 'utf8');

test('parseBrandPage reads only the brand grid anchors, with label and collection handle', () => {
	const brands = parseBrandPage(html);
	assert.deepStrictEqual(brands.map((b) => b.handle), ['afe-power', 'air-delete-magdelete', 'b-m', 'rough-country', 'rugged-ridge']);
	assert.deepStrictEqual(brands[0], { label: 'AFE POWER', handle: 'afe-power', labels: ['AFE POWER'] });
});

test('entities in the label are decoded', () => {
	assert.strictEqual(parseBrandPage(html).find((b) => b.handle === 'b-m').label, 'B&M');
});

test('two labels on one collection become one brand that keeps both labels', () => {
	const shared = parseBrandPage(html).find((b) => b.handle === 'air-delete-magdelete');
	assert.deepStrictEqual(shared.labels, ['AIR DELETE', 'MAGDELETE']);
});

test('an empty or foreign page gives an empty list', () => {
	assert.deepStrictEqual(parseBrandPage(''), []);
	assert.deepStrictEqual(parseBrandPage('<a href="/collections/x">x</a>'), []);
});
