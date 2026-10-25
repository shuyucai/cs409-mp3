var mongoose = require('mongoose');
var User = require('../models/user');
var Task = require('../models/task');
var api = require('../utils/api');
var ApiError = api.ApiError;

// Accept a date string or a timestamp in milliseconds
function readDeadline(value) {
    var date = null;
    if (typeof value === 'number') {
        date = new Date(value);
    } else if (typeof value === 'string' && value.trim() !== '') {
        date = /^-?\d+$/.test(value.trim()) ? new Date(Number(value)) : new Date(value);
    }
    if (!date || isNaN(date.getTime())) {
        throw new ApiError(400, 'A task must have a valid deadline');
    }
    return date;
}

// Accept true/false, or "true"/"false" from a form-encoded body
function readCompleted(value) {
    if (value === undefined || value === null) return false;
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    throw new ApiError(400, 'completed must be true or false');
}

// Check the request body and return only the fields a client may set
function readTaskBody(req) {
    var body = req.body || {};

    if (typeof body.name !== 'string' || body.name.trim() === '') {
        throw new ApiError(400, 'A task must have a name');
    }
    if (body.deadline === undefined || body.deadline === null) {
        throw new ApiError(400, 'A task must have a deadline');
    }
    var deadline = readDeadline(body.deadline);

    var description = body.description;
    if (description === undefined || description === null) {
        description = '';
    } else if (typeof description !== 'string') {
        throw new ApiError(400, 'description must be text');
    }

    var assignedUser = body.assignedUser;
    if (assignedUser === undefined || assignedUser === null) {
        assignedUser = '';
    }
    if (typeof assignedUser !== 'string' || (assignedUser !== '' && !api.isValidId(assignedUser))) {
        throw new ApiError(400, 'assignedUser is not a valid user id');
    }

    var assignedUserName = body.assignedUserName;
    if (assignedUserName === null) {
        assignedUserName = undefined;
    }
    if (assignedUserName !== undefined && typeof assignedUserName !== 'string') {
        throw new ApiError(400, 'assignedUserName must be text');
    }
    if (assignedUser === '' && assignedUserName !== undefined &&
        assignedUserName !== '' && assignedUserName !== 'unassigned') {
        throw new ApiError(400, 'assignedUserName is set but assignedUser is not');
    }

    return {
        name: body.name,
        description: description,
        deadline: deadline,
        completed: readCompleted(body.completed),
        assignedUser: assignedUser,
        assignedUserName: assignedUserName
    };
}

// The assigned user must exist and assignedUserName must be that user's name
async function resolveAssignee(fields, session) {
    if (fields.assignedUser === '') {
        fields.assignedUserName = 'unassigned';
        return;
    }
    var user = await User.findById(fields.assignedUser).session(session);
    if (!user) {
        throw new ApiError(404, 'The assigned user does not exist');
    }
    if (fields.assignedUserName !== undefined && fields.assignedUserName !== '' &&
        fields.assignedUserName !== user.name) {
        throw new ApiError(400, 'assignedUserName does not match the name of the assigned user');
    }
    fields.assignedUserName = user.name;
}

// Make the users' pendingTasks match the task (after the task has been saved)
async function syncTaskOwner(task, session) {
    var taskId = task._id.toString();
    await User.updateMany(
        { pendingTasks: taskId },
        { $pull: { pendingTasks: taskId } },
        { session: session }
    );
    if (task.assignedUser !== '' && !task.completed) {
        await User.updateOne(
            { _id: task.assignedUser },
            { $addToSet: { pendingTasks: taskId } },
            { session: session }
        );
    }
}

async function findTaskForUpdate(id, session) {
    var task = api.isValidId(id) ? await Task.findById(id).session(session) : null;
    if (!task) {
        throw new ApiError(404, 'Task not found');
    }
    return task;
}

module.exports = function (router) {

    var tasksRoute = router.route('/tasks');

    tasksRoute.get(async function (req, res) {
        var tasks = await api.listDocuments(Task, req.query, 100);
        api.send(res, 200, 'OK', tasks);
    });

    tasksRoute.post(async function (req, res) {
        var fields = readTaskBody(req);
        var task = await mongoose.connection.transaction(async function (session) {
            await resolveAssignee(fields, session);
            var newTask = new Task(fields);
            await newTask.save({ session: session });
            await syncTaskOwner(newTask, session);
            return newTask;
        });
        api.send(res, 201, 'Task created', task);
    });

    var taskRoute = router.route('/tasks/:id');

    taskRoute.get(async function (req, res) {
        var task = await api.findOne(Task, req.params.id, req.query, 'Task');
        api.send(res, 200, 'OK', task);
    });

    taskRoute.put(async function (req, res) {
        var task = await mongoose.connection.transaction(async function (session) {
            var existing = await findTaskForUpdate(req.params.id, session);
            var fields = readTaskBody(req);
            await resolveAssignee(fields, session);
            existing.set(fields);
            await existing.save({ session: session });
            await syncTaskOwner(existing, session);
            return existing;
        });
        api.send(res, 200, 'Task updated', task);
    });

    taskRoute.delete(async function (req, res) {
        var task = await mongoose.connection.transaction(async function (session) {
            var existing = await findTaskForUpdate(req.params.id, session);
            var taskId = existing._id.toString();
            await User.updateMany({ pendingTasks: taskId }, { $pull: { pendingTasks: taskId } }, { session: session });
            await existing.deleteOne({ session: session });
            return existing;
        });
        api.send(res, 200, 'Task deleted', task);
    });

    return router;
};
