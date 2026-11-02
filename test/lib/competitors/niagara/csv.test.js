const test = require('node:test');
const assert = require('node:assert');

const { toCsv } = require('../../../../lib/competitors/niagara/csv');

test('toCsv writes a header and quotes cells with commas, quotes or newlines', () => {
	const csv = toCsv(['a', 'b'], [{ a: 'x,y', b: 'say "hi"' }, { a: 'line\nbreak', b: 3 }]);
	assert.strictEqual(csv, 'a,b\n"x,y","say ""hi"""\n"line\nbreak",3\n');
});

test('toCsv neutralises cells a spreadsheet would run as a formula', () => {
	assert.strictEqual(toCsv(['a'], [{ a: '=SUM(1)' }, { a: '-5' }, { a: '@x' }]), "a\n'=SUM(1)\n'-5\n'@x\n");
});

test('missing and null cells are empty', () => {
	assert.strictEqual(toCsv(['a', 'b'], [{ a: null }]), 'a,b\n,\n');
});
