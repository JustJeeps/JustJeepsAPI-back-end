// Pure timezone aware date helpers, used by the report builders and by several
// endpoints and crons. Extracted VERBATIM from server.js in Phase 4a-0 (with no
// logic change at all) so the worker process can import them too.

function getDateStringInTimezone(value = new Date(), timeZone = 'America/Toronto') {
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return '';
	return new Intl.DateTimeFormat('en-CA', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).format(date);
}

function getTrailingDateStringsInTimezone(value = new Date(), days = 7, timeZone = 'America/Toronto') {
	const date = value instanceof Date ? value : new Date(value);
	const dateStrings = [];
	for (let index = days - 1; index >= 0; index -= 1) {
		dateStrings.push(getDateStringInTimezone(new Date(date.getTime() - (index * 24 * 60 * 60 * 1000)), timeZone));
	}
	return dateStrings;
}

module.exports = { getDateStringInTimezone, getTrailingDateStringsInTimezone };
