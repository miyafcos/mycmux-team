import { test } from "vitest";
import assert from "node:assert/strict";
import * as api from "../../src/components/layout/jevGroupingDecisions";
function scan() {
  return { workspaceIds: ['w'], tabs: [0, 1].map(i => ({
    id: `tab-${i}`, label: i ? 'Beta review' : 'Alpha implementation',
    cwd: 'C:/Users/example', tail: ['Current task is in progress.'],
    agentKind: 'codex', workspaceId: 'w', origin: { kind: 'human' },
  })) };
}
function choice(value, options, confidence = 1, selected = 1) {
  return { type: 'choice', choice: value, confidence, probabilities: Object.fromEntries(
    options.map(k => [k, k === value ? selected : (1 - selected) / (options.length - 1)])) };
}
const ROLES = ['mother', 'worker', 'review', 'unspecified'];
const HEALTH = ['normal', 'waiting', 'error', 'unknown'];
const RELATION = ['same', 'related', 'different', 'unknown'];
function answers() {
  return { role_0: choice('worker', ROLES), role_1: choice('review', ROLES),
    health_0: choice('normal', HEALTH), health_1: choice('normal', HEALTH),
    pair_0_1: { type: 'noul', noul: 0.05 }, compat_0_1: { type: 'noul', noul: 0.05 } };
}
test('weak role and health remain unresolved', () => {
  const a = answers(); a.role_0 = choice('worker', ROLES, .1, .8);
  a.health_0 = choice('normal', HEALTH, .1, .8);
  const result = api.readJevJudgements(scan(), a);
  assert.equal(result.roles[0], 'unspecified'); assert.equal(result.health[0], 'unknown');
});
test('known parent lineage still establishes coordinator role', () => {
  const s = scan(); s.tabs[1].origin.parentTabId = s.tabs[0].id;
  const a = answers(); a.role_0 = choice('worker', ROLES, .1, .8);
  assert.equal(api.readJevJudgements(s, a).roles[0], 'mother');
});
test('uncertain focused relation cannot merge through positive numeric scores', () => {
  const a = answers(); a.pair_0_1 = choice('related', RELATION, .2, .8);
  const pair = api.readJevJudgements(scan(), a).relations.pair_0_1;
  assert.equal(pair.kind, 'unknown'); assert.equal(pair.same, 0); assert.equal(pair.related, 0);
});
test('lack of task evidence does not become a known unrelated project', () => {
  const s = scan(); s.tabs[0].label = ''; s.tabs[0].tail = [];
  const a = answers(); a.health_0 = choice('unknown', HEALTH);
  assert.equal(api.readJevJudgements(s, a).relations.pair_0_1.kind, 'unknown');
});
test('unknown operating evidence holds a binary relationship until focused review', () => {
  const a = answers(); a.health_0 = choice('unknown', HEALTH);
  assert.equal(api.readJevJudgements(scan(), a).relations.pair_0_1.kind, 'unknown');
});
test('ambiguous compatibility receives a focused question', () => {
  const a = answers(); a.compat_0_1.noul = .6;
  assert.equal(api.buildJevFocusedRequests(scan(), a).length, 1);
});
test('conflicting same-project and compatibility answers receive focused review', () => {
  const a = answers(); a.pair_0_1.noul = .95;
  assert.equal(api.buildJevFocusedRequests(scan(), a).length, 1);
});
test('decisive independent projects do not need another request', () => {
  assert.equal(api.buildJevFocusedRequests(scan(), answers()).length, 0);
  assert.equal(api.readJevJudgements(scan(), answers()).relations.pair_0_1.kind, 'different');
});
test('strong focused decisions retain the original grouping interface', () => {
  const a = answers(); a.pair_0_1 = choice('same', RELATION, .9, .95);
  const result = api.readJevJudgements(scan(), a);
  assert.deepEqual(result.roles, ['worker', 'review']);
  assert.deepEqual(result.health, ['normal', 'normal']);
  assert.equal(result.relations.pair_0_1.kind, 'same');
  assert.equal(result.relations.pair_0_1.same, .95);
});
test('projectDirectory cannot reintroduce a credential scrubbed from cwd', () => {
  const s = scan(); const fake = 'sk-or-v1-' + 'x'.repeat(32);
  s.tabs[0].cwd = `C:/project/${fake}`;
  const body = JSON.stringify(api.buildJevRequests(s));
  assert.ok(!body.includes(fake)); assert.ok(body.includes('[credential omitted]'));
});
test('generic home paths are not project identifiers', () => {
  for (const cwd of ['~', '/root', '/home', '/Users', 'C:/Users', 'C:/Users/example', '/home/example', 'C:/']) {
    assert.equal(api.jevProjectDirectory({ cwd }), null, cwd);
  }
  assert.equal(api.jevProjectDirectory({ cwd: 'C:\\work\\alpha' }), 'C:/work/alpha');
});
test('invalid JSON raises a stable error without response fragments', () => {
  assert.throws(() => api.validateJevResponse('private-provider-diagnostics', []), /^Error: invalid_response$/);
});
test('missing expected answers and wrong probabilities are rejected', () => {
  const requests = api.buildJevRequests(scan());
  assert.throws(() => api.validateJevResponse('{"answers":{}}', requests));
  const a = answers(); a.pair_0_1.noul = 2;
  assert.throws(() => api.validateJevResponse(JSON.stringify({ answers: a }), requests));
});
test('complete rounded probabilities are accepted unchanged', () => {
  const requests = api.buildJevRequests(scan()); const a = answers();
  a.role_0 = { type: 'choice', choice: 'worker', confidence: .7,
    probabilities: { mother: 0, worker: .9, review: .08, unspecified: .01 } };
  assert.equal(api.validateJevResponse(JSON.stringify({ answers: a }), requests).role_0.probabilities.worker, .9);
});
test('transport requests omit stable user session identifiers and stay bounded', () => {
  const s = scan(); s.tabs[0].sessionId = 'private-session-id';
  const requests = api.buildJevRequests(s);
  assert.ok(requests.every(r => Object.keys(r.questions).length <= 48));
  assert.ok(!JSON.stringify(requests).includes('private-session-id'));
});

test('shell-only panes remain unknown without another paid question', () => {
  const s = scan(); s.tabs[0].label = ''; s.tabs[0].tail = ['PS C:/Users/example>'];
  const a = answers(); a.pair_0_1.noul = .5; a.compat_0_1.noul = .5;
  const j = api.readJevJudgements(s, a);
  assert.equal(j.roles[0], 'unspecified');
  assert.equal(j.health[0], 'unknown');
  assert.equal(j.relations.pair_0_1.kind, 'unknown');
  assert.equal(j.relations.pair_0_1.same, 0);
  assert.equal(api.buildJevFocusedRequests(s, a).length, 0);
});
test('a confident same-project answer does not recheck a middling compatibility answer', () => {
  const a = answers(); a.pair_0_1.noul = .95; a.compat_0_1.noul = .5;
  assert.equal(api.buildJevFocusedRequests(scan(), a).length, 0);
  assert.equal(api.readJevJudgements(scan(), a).relations.pair_0_1.kind, 'same');
});
test('focused parent references identify which pane they refer to', () => {
  const s = scan(); s.tabs[1].origin.parentTabId = s.tabs[0].id;
  const a = answers(); a.pair_0_1.noul = .5;
  const request = api.buildJevFocusedRequests(s, a)[0];
  assert.equal(request.state.left_pane.pane, request.state.right_pane.parent);
  assert.deepEqual(request.state.left_pane.children, [request.state.right_pane.pane]);
});

test('private-key blocks stay masked when terminal lines split the block', () => {
  const s = scan();
  const body = 'synthetic-private-material-for-test';
  s.tabs[0].tail = ['-----BEGIN PRIVATE KEY-----', body, '-----END PRIVATE KEY-----', 'Task is in progress.'];
  const wire = JSON.stringify(api.buildJevRequests(s));
  assert.ok(!wire.includes(body));
  assert.ok(wire.includes('[credential omitted]'));
  assert.ok(wire.includes('Task is in progress.'));
});
