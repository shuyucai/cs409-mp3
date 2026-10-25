/*
 * End-to-end checks for the API. Run against a running server:
 *   API_URL=http://localhost:3000 node tests/api-test.js
 * It creates its own users/tasks and deletes them at the end.
 */
var API = (process.env.API_URL || 'http://localhost:3000').replace(/\/+$/, '') + '/api';
var RUN = Date.now().toString(36);
var FAKE_ID = '0123456789abcdef01234567';

var passed = 0;
var failed = 0;
var createdUsers = [];
var createdTasks = [];

async function call(method, path, body) {
    var options = { method: method, headers: {} };
    if (body !== undefined) {
        options.headers['Content-Type'] = 'application/json';
        options.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    var res = await fetch(API + path, options);
    var text = await res.text();
    var json = null;
    try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
    return { status: res.status, body: json, text: text };
}

function check(label, condition, detail) {
    if (condition) {
        passed++;
    } else {
        failed++;
        console.log('FAIL  ' + label + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''));
    }
}

function expectStatus(label, res, status) {
    check(label + ' [' + status + ']', res.status === status, { status: res.status, body: res.body });
    check(label + ' {message,data}', res.body && typeof res.body.message === 'string' && 'data' in res.body, res.text);
}

function q(obj) {
    return encodeURIComponent(JSON.stringify(obj));
}

async function newUser(name, extra) {
    var body = Object.assign({ name: name, email: name + '.' + RUN + '@test.com' }, extra || {});
    var res = await call('POST', '/users', body);
    if (res.status === 201) createdUsers.push(res.body.data._id);
    return res;
}

async function newTask(name, extra) {
    var body = Object.assign({ name: name, deadline: '2030-01-01T00:00:00.000Z' }, extra || {});
    var res = await call('POST', '/tasks', body);
    if (res.status === 201) createdTasks.push(res.body.data._id);
    return res;
}

async function getUser(id) { return (await call('GET', '/users/' + id)).body.data; }
async function getTask(id) { return (await call('GET', '/tasks/' + id)).body.data; }

async function main() {
    console.log('Testing ' + API);

    // ---------- Creating & validating ----------
    var r = await newUser('alice');
    expectStatus('POST user', r, 201);
    var alice = r.body.data;
    check('user defaults', Array.isArray(alice.pendingTasks) && alice.pendingTasks.length === 0 && alice.dateCreated, alice);
    check('no __v', !('__v' in alice), alice);

    expectStatus('POST user without name', await call('POST', '/users', { email: 'x' + RUN + '@t.com' }), 400);
    expectStatus('POST user without email', await call('POST', '/users', { name: 'x' }), 400);
    expectStatus('POST user name wrong type', await call('POST', '/users', { name: 5, email: 'y' + RUN + '@t.com' }), 400);
    expectStatus('POST duplicate email', await call('POST', '/users', { name: 'dup', email: alice.email }), 400);
    expectStatus('POST invalid JSON body', await call('POST', '/users', '{bad json'), 400);
    expectStatus('POST user pendingTasks bad id', await call('POST', '/users', { name: 'z', email: 'z' + RUN + '@t.com', pendingTasks: ['nope'] }), 400);
    expectStatus('POST user pendingTasks missing task', await call('POST', '/users', { name: 'z', email: 'z' + RUN + '@t.com', pendingTasks: [FAKE_ID] }), 404);
    expectStatus('POST user pendingTasks not a list', await call('POST', '/users', { name: 'z', email: 'z' + RUN + '@t.com', pendingTasks: 5 }), 400);

    var ignored = await newUser('dateuser', { dateCreated: '2000-01-01T00:00:00.000Z' });
    check('client dateCreated ignored', new Date(ignored.body.data.dateCreated).getFullYear() !== 2000, ignored.body);

    r = await newTask('t1');
    expectStatus('POST task', r, 201);
    var t1 = r.body.data;
    check('task defaults', t1.description === '' && t1.completed === false && t1.assignedUser === '' && t1.assignedUserName === 'unassigned' && t1.dateCreated, t1);

    expectStatus('POST task without name', await call('POST', '/tasks', { deadline: '2030-01-01' }), 400);
    expectStatus('POST task without deadline', await call('POST', '/tasks', { name: 'x' }), 400);
    expectStatus('POST task bad deadline', await call('POST', '/tasks', { name: 'x', deadline: 'not a date' }), 400);
    expectStatus('POST task numeric deadline', await newTask('numdl', { deadline: 1893456000000 }), 201);
    expectStatus('POST task bad assignedUser', await call('POST', '/tasks', { name: 'x', deadline: '2030-01-01', assignedUser: 'abc' }), 400);
    expectStatus('POST task missing assignedUser', await call('POST', '/tasks', { name: 'x', deadline: '2030-01-01', assignedUser: FAKE_ID }), 404);
    expectStatus('POST task name mismatch', await call('POST', '/tasks', { name: 'x', deadline: '2030-01-01', assignedUser: alice._id, assignedUserName: 'bob' }), 400);
    expectStatus('POST task name without user', await call('POST', '/tasks', { name: 'x', deadline: '2030-01-01', assignedUserName: 'bob' }), 400);

    // POST task assigned to alice -> in alice.pendingTasks
    r = await newTask('t2', { assignedUser: alice._id });
    expectStatus('POST assigned task', r, 201);
    var t2 = r.body.data;
    check('assignedUserName filled in', t2.assignedUserName === 'alice', t2);
    check('task added to pendingTasks', (await getUser(alice._id)).pendingTasks.indexOf(t2._id) !== -1);

    r = await newTask('t3done', { assignedUser: alice._id, assignedUserName: 'alice', completed: true });
    var t3 = r.body.data;
    check('completed task not in pendingTasks', (await getUser(alice._id)).pendingTasks.indexOf(t3._id) === -1);

    expectStatus('POST user with completed task', await call('POST', '/users', { name: 'z', email: 'z' + RUN + '@t.com', pendingTasks: [t3._id] }), 400);

    // ---------- select on single resources ----------
    r = await call('GET', '/users/' + alice._id + '?select=' + q({ name: 1 }));
    expectStatus('GET user select', r, 200);
    check('select includes only name (+_id)', r.body.data.name === 'alice' && r.body.data.email === undefined, r.body);
    r = await call('GET', '/tasks/' + t1._id + '?select=' + q({ _id: 0, name: 1 }));
    check('task select _id 0', r.body.data._id === undefined && r.body.data.name === 't1', r.body);
    r = await call('GET', '/tasks/' + t1._id + '?where=' + q({ name: 'nothing' }));
    expectStatus('GET task ignores where', r, 200);
    expectStatus('GET user bad select JSON', await call('GET', '/users/' + alice._id + '?select={bad'), 400);
    expectStatus('GET user missing', await call('GET', '/users/' + FAKE_ID), 404);
    expectStatus('GET user malformed id', await call('GET', '/users/xyz'), 404);
    expectStatus('GET task missing', await call('GET', '/tasks/' + FAKE_ID), 404);

    // ---------- Updating missing resources ----------
    expectStatus('PUT missing user', await call('PUT', '/users/' + FAKE_ID, { name: 'a', email: 'a@b.c' }), 404);
    expectStatus('PUT malformed user id', await call('PUT', '/users/bad', { name: 'a', email: 'a@b.c' }), 404);
    expectStatus('PUT missing user + bad body still 404', await call('PUT', '/users/' + FAKE_ID, {}), 404);
    expectStatus('PUT missing task', await call('PUT', '/tasks/' + FAKE_ID, { name: 'a', deadline: '2030-01-01' }), 404);
    expectStatus('PUT malformed task id', await call('PUT', '/tasks/bad', { name: 'a', deadline: '2030-01-01' }), 404);

    // ---------- Two-way references ----------
    r = await newUser('bob');
    var bob = r.body.data;

    // PUT /users: move t2 from alice to bob, add t1
    r = await call('PUT', '/users/' + bob._id, { name: 'bob', email: bob.email, pendingTasks: [t1._id, t2._id] });
    expectStatus('PUT bob takes t1,t2', r, 200);
    check('PUT response has new pendingTasks', r.body.data.pendingTasks.length === 2, r.body);
    check('dateCreated unchanged', r.body.data.dateCreated === bob.dateCreated, r.body);
    var a = await getUser(alice._id);
    check('t2 removed from alice', a.pendingTasks.indexOf(t2._id) === -1, a);
    var t2now = await getTask(t2._id);
    check('t2 assigned to bob', t2now.assignedUser === bob._id && t2now.assignedUserName === 'bob', t2now);

    // rename bob -> completed tasks too
    await call('PUT', '/tasks/' + t3._id, { name: 't3done', deadline: '2030-01-01', completed: true, assignedUser: bob._id });
    r = await call('PUT', '/users/' + bob._id, { name: 'robert', email: bob.email, pendingTasks: [t1._id, t2._id] });
    expectStatus('PUT rename bob', r, 200);
    check('rename updates pending task', (await getTask(t1._id)).assignedUserName === 'robert');
    check('rename updates completed task', (await getTask(t3._id)).assignedUserName === 'robert');

    // drop t1 from bob -> unassigned
    r = await call('PUT', '/users/' + bob._id, { name: 'robert', email: bob.email, pendingTasks: [t2._id] });
    var t1now = await getTask(t1._id);
    check('t1 unassigned', t1now.assignedUser === '' && t1now.assignedUserName === 'unassigned', t1now);
    check('completed t3 stays assigned', (await getTask(t3._id)).assignedUser === bob._id);

    // missing pendingTasks means empty list
    r = await call('PUT', '/users/' + bob._id, { name: 'robert', email: bob.email });
    check('missing pendingTasks -> []', r.body.data.pendingTasks.length === 0, r.body);
    check('t2 unassigned after empty list', (await getTask(t2._id)).assignedUser === '');

    // PUT user error ordering / atomicity
    expectStatus('PUT user email taken', await call('PUT', '/users/' + bob._id, { name: 'robert', email: alice.email }), 400);
    expectStatus('PUT user keep own email', await call('PUT', '/users/' + bob._id, { name: 'robert', email: bob.email }), 200);
    expectStatus('PUT user missing task', await call('PUT', '/users/' + bob._id, { name: 'robert', email: bob.email, pendingTasks: [t1._id, FAKE_ID] }), 404);
    check('failed PUT changed nothing', (await getTask(t1._id)).assignedUser === '' && (await getUser(bob._id)).pendingTasks.length === 0);
    expectStatus('PUT user completed task', await call('PUT', '/users/' + bob._id, { name: 'robert', email: bob.email, pendingTasks: [t3._id] }), 400);
    expectStatus('PUT user without name', await call('PUT', '/users/' + bob._id, { email: bob.email }), 400);

    // PUT /tasks
    r = await call('PUT', '/tasks/' + t1._id, { name: 't1', deadline: '2030-01-01', assignedUser: alice._id, assignedUserName: 'alice' });
    expectStatus('PUT task assign alice', r, 200);
    check('t1 in alice.pendingTasks', (await getUser(alice._id)).pendingTasks.indexOf(t1._id) !== -1);
    check('task dateCreated unchanged', r.body.data.dateCreated === t1.dateCreated, r.body);

    r = await call('PUT', '/tasks/' + t1._id, { name: 't1', deadline: '2030-01-01', assignedUser: bob._id });
    check('t1 moved off alice', (await getUser(alice._id)).pendingTasks.indexOf(t1._id) === -1);
    check('t1 now on bob', (await getUser(bob._id)).pendingTasks.indexOf(t1._id) !== -1);

    r = await call('PUT', '/tasks/' + t1._id, { name: 't1', deadline: '2030-01-01', assignedUser: bob._id, completed: true });
    expectStatus('PUT task complete', r, 200);
    check('completed removed from pendingTasks', (await getUser(bob._id)).pendingTasks.indexOf(t1._id) === -1);
    check('completed stays assigned', r.body.data.assignedUser === bob._id, r.body);

    r = await call('PUT', '/tasks/' + t1._id, { name: 't1', deadline: '2030-01-01', assignedUser: bob._id, completed: false });
    check('uncompleted re-added', (await getUser(bob._id)).pendingTasks.indexOf(t1._id) !== -1);

    r = await call('PUT', '/tasks/' + t1._id, { name: 't1', deadline: '2030-01-01', assignedUser: '' });
    check('unassign via PUT', r.body.data.assignedUserName === 'unassigned' && (await getUser(bob._id)).pendingTasks.indexOf(t1._id) === -1, r.body);

    r = await call('PUT', '/tasks/' + t3._id, { name: 't3done', deadline: '2030-01-01', completed: true, assignedUser: alice._id });
    expectStatus('PUT reassign completed task', r, 200);
    check('completed reassigned not pending', (await getUser(alice._id)).pendingTasks.indexOf(t3._id) === -1);

    expectStatus('PUT task name mismatch', await call('PUT', '/tasks/' + t1._id, { name: 't1', deadline: '2030-01-01', assignedUser: alice._id, assignedUserName: 'nope' }), 400);
    expectStatus('PUT task without deadline', await call('PUT', '/tasks/' + t1._id, { name: 't1' }), 400);
    expectStatus('PUT task missing user', await call('PUT', '/tasks/' + t1._id, { name: 't1', deadline: '2030-01-01', assignedUser: FAKE_ID }), 404);
    r = await call('PUT', '/tasks/' + t1._id, { name: 'renamed', deadline: '2030-01-01' });
    check('PUT replaces whole task (defaults)', r.body.data.description === '' && r.body.data.completed === false, r.body);

    // ---------- Query parameters ----------
    var tag = 'q' + RUN;
    for (var i = 0; i < 5; i++) {
        await newTask(tag + '-' + i, { completed: i % 2 === 0, deadline: new Date(2030, 0, 10 - i).toISOString() });
    }
    var where = q({ name: { $regex: '^' + tag } });
    r = await call('GET', '/tasks?where=' + where);
    check('where', r.status === 200 && r.body.data.length === 5, r.body);
    r = await call('GET', '/tasks?where=' + q({ name: { $regex: '^' + tag }, completed: true }));
    check('where completed', r.body.data.length === 3, r.body);
    r = await call('GET', '/tasks?where=' + where + '&sort=' + q({ deadline: 1 }));
    check('sort', r.body.data[0].name === tag + '-4', r.body.data.map(function (t) { return t.name; }));
    r = await call('GET', '/tasks?where=' + where + '&sort=' + q({ name: 1 }) + '&skip=1&limit=2');
    check('skip+limit', r.body.data.length === 2 && r.body.data[0].name === tag + '-1', r.body);
    r = await call('GET', '/tasks?where=' + where + '&count=true');
    check('count', r.body.data === 5, r.body);
    r = await call('GET', '/tasks?where=' + q({ name: 'no such task ' + RUN }));
    check('no match is 200 []', r.status === 200 && r.body.data.length === 0, r.body);
    r = await call('GET', '/tasks?where=' + q({ name: 'no such task ' + RUN }) + '&count=true');
    check('no match count 0', r.status === 200 && r.body.data === 0, r.body);
    r = await call('GET', '/tasks?where=' + q({ _id: { $in: [t1._id, t2._id] } }));
    check('where $in ids', r.body.data.length === 2, r.body);
    r = await call('GET', '/users?where=' + q({ _id: 'not-an-id' }));
    check('where uncastable id is 200 []', r.status === 200 && r.body.data.length === 0, r.body);
    r = await call('GET', '/users?select=' + q({ _id: 0 }) + '&sort=' + q({ name: 1 }));
    check('users select _id 0', r.status === 200 && r.body.data.length > 0 && r.body.data[0]._id === undefined, r.body);
    r = await call('GET', '/tasks');
    check('tasks default limit <= 100', r.status === 200 && r.body.data.length <= 100);
    expectStatus('where invalid JSON', await call('GET', '/tasks?where={bad'), 400);
    expectStatus('sort invalid JSON', await call('GET', '/users?sort=oops'), 400);
    expectStatus('limit not a number', await call('GET', '/tasks?limit="x"'), 400);
    expectStatus('sort invalid value', await call('GET', '/users?sort=' + q({ name: 'sideways' })), 400);
    expectStatus('select mixes include/exclude', await call('GET', '/users?select=' + q({ name: 1, email: 0 })), 400);

    // ---------- Deleting ----------
    r = await newTask('del', { assignedUser: alice._id });
    var del = r.body.data;
    expectStatus('DELETE task', await call('DELETE', '/tasks/' + del._id), 200);
    expectStatus('GET deleted task', await call('GET', '/tasks/' + del._id), 404);
    check('deleted task removed from pendingTasks', (await getUser(alice._id)).pendingTasks.indexOf(del._id) === -1);
    expectStatus('DELETE task again', await call('DELETE', '/tasks/' + del._id), 404);
    expectStatus('DELETE malformed task id', await call('DELETE', '/tasks/bad'), 404);

    await call('PUT', '/tasks/' + t2._id, { name: 't2', deadline: '2030-01-01', assignedUser: alice._id });
    expectStatus('DELETE user', await call('DELETE', '/users/' + alice._id), 200);
    expectStatus('GET deleted user', await call('GET', '/users/' + alice._id), 404);
    var t2after = await getTask(t2._id);
    var t3after = await getTask(t3._id);
    check('pending task unassigned after user delete', t2after.assignedUser === '' && t2after.assignedUserName === 'unassigned', t2after);
    check('completed task unassigned after user delete', t3after.assignedUser === '' && t3after.assignedUserName === 'unassigned', t3after);
    expectStatus('DELETE user again', await call('DELETE', '/users/' + alice._id), 404);

    expectStatus('unknown endpoint', await call('GET', '/nope'), 404);
}

async function cleanup() {
    for (var i = 0; i < createdTasks.length; i++) await call('DELETE', '/tasks/' + createdTasks[i]);
    for (var j = 0; j < createdUsers.length; j++) await call('DELETE', '/users/' + createdUsers[j]);
    var leftover = await call('GET', '/tasks?where=' + q({ name: { $regex: '^q' + RUN } }));
    if (leftover.body && Array.isArray(leftover.body.data)) {
        for (var k = 0; k < leftover.body.data.length; k++) await call('DELETE', '/tasks/' + leftover.body.data[k]._id);
    }
}

main()
    .catch(function (err) { failed++; console.log('ERROR', err); })
    .then(cleanup)
    .then(function () {
        console.log('\n' + passed + ' passed, ' + failed + ' failed');
        process.exit(failed ? 1 : 0);
    });
