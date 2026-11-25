// The distributor code in front of a MyTruckPoint part number (DD-022):
// variant SKUs read <4 letters>_<part number> (BBGL_24-329248 is Bilstein,
// DHTP_52200_A is Rough Country), and one brand collection carries one code.
// The code is treated as opaque: it only tells the brand's own listings apart
// from another brand's. Pure.

const CODE_PATTERN = /^([A-Z]{4}_)./;

function codeOf(sku) {
	const match = String(sku ?? '').trim().toUpperCase().match(CODE_PATTERN);
	return match ? match[1] : '';
}

// code: the most common code among coded SKUs; share: its share of them;
// codedShare: the share of all SKUs that carry any code.
function codeShares(skus) {
	const list = skus || [];
	const counts = new Map();
	for (const sku of list) {
		const code = codeOf(sku);
		if (code) counts.set(code, (counts.get(code) || 0) + 1);
	}
	const coded = [...counts.values()].reduce((n, c) => n + c, 0);
	const [code, count] = [...counts].sort((a, b) => b[1] - a[1])[0] || ['', 0];
	return { code, share: coded ? count / coded : 0, codedShare: list.length ? coded / list.length : 0, coded, total: list.length };
}

module.exports = { codeOf, codeShares };
