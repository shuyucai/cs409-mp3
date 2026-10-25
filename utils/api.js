/*
 * Shared helpers for the API routes: response format, errors,
 * id checks and the JSON query string parameters.
 */

// An error we expect and want to show to the client as-is
function ApiError(status, message, data) {
    this.status = status;
    this.message = message;
    this.data = data === undefined ? null : data;
}

// Every response has the shape { message, data }
function send(res, status, message, data) {
    res.status(status).json({ message: message, data: data });
}

// A MongoDB ObjectId is exactly 24 hex characters
function isValidId(id) {
    return typeof id === 'string' && /^[0-9a-fA-F]{24}$/.test(id);
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Parse one JSON encoded query string parameter (undefined if absent)
function parseJsonParam(query, name) {
    if (query[name] === undefined) {
        return undefined;
    }
    if (typeof query[name] !== 'string') {
        throw new ApiError(400, 'The "' + name + '" parameter may only be given once');
    }
    try {
        return JSON.parse(query[name]);
    } catch (err) {
        throw new ApiError(400, 'The "' + name + '" parameter is not valid JSON');
    }
}

function parseObjectParam(query, name) {
    var value = parseJsonParam(query, name);
    if (value !== undefined && !isPlainObject(value)) {
        throw new ApiError(400, 'The "' + name + '" parameter must be a JSON object');
    }
    return value;
}

function parseCountParam(query, name) {
    var value = parseJsonParam(query, name);
    if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value < 0)) {
        throw new ApiError(400, 'The "' + name + '" parameter must be a non-negative integer');
    }
    return value;
}

// Errors that mean the database itself is unavailable (a 500, not the client's fault)
function isDatabaseFailure(err) {
    return /Network|ServerSelection|NotConnected|Timeout/.test(err.name) || err.name === 'MongooseError';
}

// Any other error while building or running a query from client parameters is a bad query.
// A value that cannot match a field (e.g. "where": {"_id": "abc"}) just matches nothing.
async function runQuery(buildQuery, noMatch) {
    try {
        return await buildQuery();
    } catch (err) {
        if (isDatabaseFailure(err)) {
            throw err;
        }
        if (err.name === 'CastError' && noMatch !== undefined) {
            return noMatch;
        }
        throw new ApiError(400, 'The query parameters are not valid for this resource');
    }
}

// GET on a collection: where, sort, select, skip, limit, count
async function listDocuments(Model, query, defaultLimit) {
    var where = parseObjectParam(query, 'where') || {};
    var sort = parseObjectParam(query, 'sort');
    var select = parseObjectParam(query, 'select');
    var skip = parseCountParam(query, 'skip');
    var limit = parseCountParam(query, 'limit');
    var count = parseJsonParam(query, 'count');

    if (count !== undefined && typeof count !== 'boolean') {
        throw new ApiError(400, 'The "count" parameter must be true or false');
    }

    if (count) {
        var options = {};
        if (skip !== undefined) options.skip = skip;
        if (limit !== undefined) options.limit = limit;
        return runQuery(function () {
            return Model.countDocuments(where, options);
        }, 0);
    }

    return runQuery(function () {
        var find = Model.find(where);
        if (sort) find.sort(sort);
        if (select) find.select(select);
        if (skip !== undefined) find.skip(skip);
        if (limit !== undefined) {
            find.limit(limit);
        } else if (defaultLimit) {
            find.limit(defaultLimit);
        }
        return find;
    }, []);
}

// GET on a single resource: only "select" applies, unknown ids are a 404
async function findOne(Model, id, query, label) {
    if (!isValidId(id)) {
        throw new ApiError(404, label + ' not found');
    }
    var select = parseObjectParam(query, 'select');
    var doc = await runQuery(function () {
        var find = Model.findById(id);
        if (select) find.select(select);
        return find;
    });
    if (!doc) {
        throw new ApiError(404, label + ' not found');
    }
    return doc;
}

// Express error handler: turn anything thrown into a clean { message, data } response
function errorHandler(err, req, res, next) {
    if (err instanceof ApiError) {
        return send(res, err.status, err.message, err.data);
    }
    if (err.type === 'entity.parse.failed') {
        return send(res, 400, 'The request body is not valid JSON', null);
    }
    if (err.code === 11000) {
        return send(res, 400, 'A user with this email already exists', null);
    }
    if (err.name === 'ValidationError' || err.name === 'CastError') {
        return send(res, 400, 'The request contains invalid data', null);
    }
    if (err.status >= 400 && err.status < 500) {
        return send(res, err.status, 'Bad request', null);
    }
    console.error(err);
    send(res, 500, 'Something went wrong on the server, please try again later', null);
}

module.exports = {
    ApiError: ApiError,
    send: send,
    isValidId: isValidId,
    isPlainObject: isPlainObject,
    listDocuments: listDocuments,
    findOne: findOne,
    errorHandler: errorHandler
};
