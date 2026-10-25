var mongoose = require('mongoose');
var User = require('../models/user');
var Task = require('../models/task');
var api = require('../utils/api');
var ApiError = api.ApiError;

var UNASSIGNED = { assignedUser: '', assignedUserName: 'unassigned' };

// Check the request body and return only the fields a client may set
function readUserBody(req) {
    var body = req.body || {};

    if (typeof body.name !== 'string' || body.name.trim() === '') {
        throw new ApiError(400, 'A user must have a name');
    }
    if (typeof body.email !== 'string' || body.email.trim() === '') {
        throw new ApiError(400, 'A user must have an email');
    }

    var pendingTasks = body.pendingTasks;
    if (pendingTasks === undefined || pendingTasks === null || pendingTasks === '') {
        pendingTasks = [];
    } else if (typeof pendingTasks === 'string' && !req.is('application/json')) {
        // A form-encoded body sends a single value as a plain string
        pendingTasks = [pendingTasks];
    }
    if (!Array.isArray(pendingTasks)) {
        throw new ApiError(400, 'pendingTasks must be a list of task ids');
    }
    for (var i = 0; i < pendingTasks.length; i++) {
        if (!api.isValidId(pendingTasks[i])) {
            throw new ApiError(400, 'pendingTasks contains an invalid task id');
        }
    }

    return {
        name: body.name,
        email: body.email,
        pendingTasks: Array.from(new Set(pendingTasks))
    };
}

async function checkEmailFree(email, userId, session) {
    var filter = { email: email };
    if (userId) filter._id = { $ne: userId };
    if (await User.exists(filter).session(session)) {
        throw new ApiError(400, 'A user with this email already exists');
    }
}

// Every id in pendingTasks must be an existing, not completed task
async function checkPendingTasks(ids, session) {
    var tasks = await Task.find({ _id: { $in: ids } }).session(session);
    if (tasks.length !== ids.length) {
        throw new ApiError(404, 'One or more tasks in pendingTasks do not exist');
    }
    if (tasks.some(function (task) { return task.completed; })) {
        throw new ApiError(400, 'A completed task cannot be in pendingTasks');
    }
}

// Make the tasks match user.pendingTasks (after the user has been saved)
async function syncUserTasks(user, session) {
    var userId = user._id.toString();
    var ids = user.pendingTasks;

    // Pending tasks of this user that are no longer in the list become unassigned
    await Task.updateMany(
        { assignedUser: userId, completed: false, _id: { $nin: ids } },
        UNASSIGNED,
        { session: session }
    );
    // Tasks that move to this user are taken away from their previous user
    await User.updateMany(
        { _id: { $ne: user._id }, pendingTasks: { $in: ids } },
        { $pull: { pendingTasks: { $in: ids } } },
        { session: session }
    );
    // Assign the listed tasks, and keep the name current on all of this user's tasks
    await Task.updateMany(
        { $or: [{ _id: { $in: ids } }, { assignedUser: userId }] },
        { assignedUser: userId, assignedUserName: user.name },
        { session: session }
    );
}

async function findUserForUpdate(id, session) {
    var user = api.isValidId(id) ? await User.findById(id).session(session) : null;
    if (!user) {
        throw new ApiError(404, 'User not found');
    }
    return user;
}

module.exports = function (router) {

    var usersRoute = router.route('/users');

    usersRoute.get(async function (req, res) {
        var users = await api.listDocuments(User, req.query, 0);
        api.send(res, 200, 'OK', users);
    });

    usersRoute.post(async function (req, res) {
        var fields = readUserBody(req);
        var user = await mongoose.connection.transaction(async function (session) {
            await checkEmailFree(fields.email, null, session);
            await checkPendingTasks(fields.pendingTasks, session);
            var newUser = new User(fields);
            await newUser.save({ session: session });
            await syncUserTasks(newUser, session);
            return newUser;
        });
        api.send(res, 201, 'User created', user);
    });

    var userRoute = router.route('/users/:id');

    userRoute.get(async function (req, res) {
        var user = await api.findOne(User, req.params.id, req.query, 'User');
        api.send(res, 200, 'OK', user);
    });

    userRoute.put(async function (req, res) {
        var user = await mongoose.connection.transaction(async function (session) {
            var existing = await findUserForUpdate(req.params.id, session);
            var fields = readUserBody(req);
            await checkEmailFree(fields.email, existing._id, session);
            await checkPendingTasks(fields.pendingTasks, session);
            existing.set(fields);
            await existing.save({ session: session });
            await syncUserTasks(existing, session);
            return existing;
        });
        api.send(res, 200, 'User updated', user);
    });

    userRoute.delete(async function (req, res) {
        var user = await mongoose.connection.transaction(async function (session) {
            var existing = await findUserForUpdate(req.params.id, session);
            await Task.updateMany({ assignedUser: existing._id.toString() }, UNASSIGNED, { session: session });
            await existing.deleteOne({ session: session });
            return existing;
        });
        api.send(res, 200, 'User deleted', user);
    });

    return router;
};
