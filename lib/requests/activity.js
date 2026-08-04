// Monta entradas de RequestActivity comparando o estado atual do request com
// o patch aplicado. Modulo puro (sem banco/express) para ser testavel.

const MAX_VALUE_LENGTH = 300;

const asValue = (value) => {
	if (value === null || value === undefined) return null;
	const text = typeof value === 'string' ? value : JSON.stringify(value);
	return text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH - 1)}…` : text;
};

// applied: campos efetivamente aplicados no update (undefined = nao mexeu).
// labels.oldAssignee/newAssignee: usernames legiveis para assignee_change.
function diffToActivities({ requestId, actorId, current, applied, labels = {} }) {
	const entries = [];
	const add = (action, field, oldValue, newValue) => entries.push({
		request_id: requestId,
		actor_id: actorId,
		action,
		field,
		oldValue: asValue(oldValue),
		newValue: asValue(newValue),
	});

	if (applied.status !== undefined && applied.status !== current.status) {
		const action = current.status === 'Closed' ? 'reopened' : 'status_change';
		add(action, 'status', current.status, applied.status);
	}

	if (applied.assignee_id !== undefined && applied.assignee_id !== current.assignee_id) {
		add('assignee_change', 'assignee', labels.oldAssignee || null, labels.newAssignee || null);
	}

	if (applied.priority !== undefined && applied.priority !== current.priority) {
		add('priority_change', 'priority', current.priority, applied.priority);
	}

	for (const field of ['title', 'description', 'project', 'type']) {
		if (applied[field] !== undefined && applied[field] !== current[field]) {
			add('field_update', field, current[field], applied[field]);
		}
	}

	if (
		applied.links !== undefined &&
		JSON.stringify(applied.links ?? []) !== JSON.stringify(current.links ?? [])
	) {
		add('field_update', 'links', current.links ?? [], applied.links ?? []);
	}

	return entries;
}

module.exports = { diffToActivities };
