const { verifyToken } = require('./authMiddleware');

const ITEM_COLLECTIONS = ['bookings', 'notifications', 'reviews', 'activity_logs'];

const DOC_NAMES = {
    user: ['cart', 'passengers', 'favorites', 'checkins', 'noshow', 'group', 'ops_notes'],
    admin: ['ops_incidents', 'ops_checkins', 'ops_noshows', 'ops_refunds', 'ops_maintenance'],
    global: ['admin_settings', 'frontend_settings']
};

const MAX_BATCH = 100;
const MAX_ITEM_BYTES = 20000;
const MAX_DOC_BYTES = 400000;
const ACTIVE_STATUSES = ['Pending', 'Confirmed'];

const lower = (value) => String(value || '').trim().toLowerCase();
const meOf = (user) => lower(user.email);
const isAdmin = (user) => user.role === 'admin';

function parse(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

class Reject extends Error {}

module.exports = function registerDataRoutes(app, db) {
    function itemCollection(req, res, next) {
        if (!ITEM_COLLECTIONS.includes(req.params.collection)) {
            return res.status(404).json({ message: 'Unknown collection.' });
        }
        next();
    }

    async function loadExisting(collection, id) {
        const [rows] = await db.query(
            'SELECT owner_email, audience, data FROM app_items WHERE collection = ? AND item_id = ?',
            [collection, id]
        );
        if (!rows.length) return null;
        return { owner: rows[0].owner_email, audience: rows[0].audience, data: parse(rows[0].data) || {} };
    }

    // Ang server ang magpapasya kung ano ang puwedeng isulat ng bawat user.
    async function prepare(collection, user, item, existing) {
        const me = meOf(user);
        const admin = isAdmin(user);

        if (collection === 'bookings') {
            if (admin) return { data: item, owner: lower(item.email), audience: null };

            if (!existing) {
                if (lower(item.email) !== me) throw new Reject('Booking email does not match your account.');

                const data = {
                    ...item,
                    status: 'Pending',
                    paymentStatus: item.paymentMethod === 'Cash' ? 'Pay at terminal' : 'Pending Verification'
                };
                delete data.confirmedAt;
                delete data.completedAt;
                delete data.refundStatus;

                const [rows] = await db.query(
                    "SELECT data FROM app_items WHERE collection = 'bookings' AND item_id <> ? LIMIT 5000",
                    [item.id]
                );
                const clash = rows.map((r) => parse(r.data) || {}).some((b) =>
                    ACTIVE_STATUSES.includes(b.status) &&
                    b.bus === data.bus && b.route === data.route &&
                    b.date === data.date && String(b.seat) === String(data.seat)
                );
                if (clash) throw new Reject('That seat is already reserved.');

                return { data, owner: me, audience: null };
            }

            if (existing.owner !== me) throw new Reject('Not your booking.');

            const current = existing.data;
            const next = { ...current };

            if (item.date !== undefined) next.date = item.date;
            if (item.refundStatus !== undefined) next.refundStatus = item.refundStatus;
            if (item.completedAt !== undefined) next.completedAt = item.completedAt;

            if (item.status !== undefined && item.status !== current.status) {
                const from = current.status;
                const to = item.status;
                const ok =
                    (to === 'Cancelled' && from !== 'Completed') ||
                    (to === 'Pending' && ['Pending', 'Confirmed'].includes(from)) ||
                    (to === 'Completed' && from === 'Confirmed');
                if (!ok) throw new Reject('That status change is not allowed.');
                next.status = to;
            }

            return { data: next, owner: me, audience: null };
        }

        if (collection === 'notifications') {
            if (existing) {
                const mine = existing.audience === 'passenger' && existing.owner === me;
                if (!admin && !mine) throw new Reject('Not your notification.');
            }

            if (item.audience === 'admin') {
                return { data: item, owner: me, audience: 'admin' };
            }

            if (item.audience === 'passenger') {
                if (!admin && lower(item.email) !== me) throw new Reject('Notification is for another passenger.');
                return { data: item, owner: lower(item.email), audience: 'passenger' };
            }

            throw new Reject('Invalid notification audience.');
        }

        if (collection === 'reviews') {
            if (admin) return { data: item, owner: lower(item.email) || me, audience: null };
            if (existing) {
                if (existing.owner !== me) throw new Reject('Not your review.');
                return { data: item, owner: me, audience: null };
            }
            if (lower(item.email) !== me) throw new Reject('Review email does not match your account.');
            return { data: item, owner: me, audience: null };
        }

        if (collection === 'activity_logs') {
            if (existing && !admin) throw new Reject('Only admin can edit logs.');
            return { data: item, owner: existing ? existing.owner : me, audience: null };
        }

        throw new Reject('Unknown collection.');
    }

    function canDelete(collection, user, existing) {
        const admin = isAdmin(user);
        const me = meOf(user);

        if (collection === 'bookings' || collection === 'activity_logs') return admin;
        if (collection === 'notifications') {
            return admin || (existing.audience === 'passenger' && existing.owner === me);
        }
        if (collection === 'reviews') return admin || existing.owner === me;
        return false;
    }

    app.get('/api/items/:collection', verifyToken, itemCollection, async (req, res, next) => {
        try {
            const { collection } = req.params;
            const user = req.user;
            const params = [collection];
            let sql = 'SELECT data FROM app_items WHERE collection = ?';

            if (collection === 'activity_logs' && !isAdmin(user)) {
                return res.status(200).json([]);
            }

            if (collection === 'bookings' && !isAdmin(user)) {
                sql += ' AND owner_email = ?';
                params.push(meOf(user));
            }

            if (collection === 'notifications') {
                if (isAdmin(user)) {
                    sql += " AND audience = 'admin'";
                } else {
                    sql += " AND audience = 'passenger' AND owner_email = ?";
                    params.push(meOf(user));
                }
            }

            sql += ' ORDER BY seq DESC LIMIT 1000';

            const [rows] = await db.query(sql, params);
            res.status(200).json(rows.map((row) => parse(row.data)).filter(Boolean));
        } catch (error) {
            next(error);
        }
    });

    app.post('/api/items/:collection/sync', verifyToken, itemCollection, async (req, res, next) => {
        try {
            const { collection } = req.params;
            const user = req.user;
            const upserts = Array.isArray(req.body?.upserts) ? req.body.upserts : [];
            const deletes = Array.isArray(req.body?.deletes) ? req.body.deletes : [];

            if (upserts.length > MAX_BATCH || deletes.length > MAX_BATCH) {
                return res.status(400).json({ message: 'Too many changes in one request.' });
            }

            const rejected = [];
            let saved = 0;
            let removed = 0;

            for (const item of upserts) {
                const id = item && typeof item.id === 'string' ? item.id : '';

                try {
                    if (!id || id.length > 100 || typeof item !== 'object') throw new Reject('Invalid item.');
                    if (Buffer.byteLength(JSON.stringify(item)) > MAX_ITEM_BYTES) throw new Reject('Item is too large.');

                    const existing = await loadExisting(collection, id);
                    const result = await prepare(collection, user, item, existing);

                    await db.query(
                        'INSERT INTO app_items (collection, item_id, owner_email, audience, data) VALUES (?,?,?,?,?) ' +
                        'ON DUPLICATE KEY UPDATE owner_email = VALUES(owner_email), audience = VALUES(audience), data = VALUES(data)',
                        [collection, id, result.owner, result.audience, JSON.stringify(result.data)]
                    );
                    saved += 1;
                } catch (error) {
                    if (!(error instanceof Reject)) throw error;
                    rejected.push({ id, reason: error.message });
                }
            }

            for (const rawId of deletes) {
                const id = String(rawId);
                const existing = await loadExisting(collection, id);
                if (!existing) continue;

                if (!canDelete(collection, user, existing)) {
                    rejected.push({ id, reason: 'Not allowed to delete.' });
                    continue;
                }

                await db.query('DELETE FROM app_items WHERE collection = ? AND item_id = ?', [collection, id]);
                removed += 1;
            }

            res.status(200).json({ saved, removed, rejected });
        } catch (error) {
            next(error);
        }
    });

    // Upuan na kinuha na ng lahat ng pasahero (walang personal na detalye).
    app.get('/api/taken-seats', verifyToken, async (req, res, next) => {
        try {
            const [rows] = await db.query(
                "SELECT data FROM app_items WHERE collection = 'bookings' ORDER BY seq DESC LIMIT 5000"
            );

            const seats = rows
                .map((row) => parse(row.data) || {})
                .filter((b) => ACTIVE_STATUSES.includes(b.status))
                .map((b) => ({ bus: b.bus, route: b.route, date: b.date, seat: b.seat, status: b.status }));

            res.status(200).json(seats);
        } catch (error) {
            next(error);
        }
    });

    function docAccess(req, res, next) {
        const { scope, name } = req.params;
        const names = DOC_NAMES[scope];

        if (!names || !names.includes(name)) {
            return res.status(404).json({ message: 'Unknown document.' });
        }

        if (scope === 'admin' && !isAdmin(req.user)) {
            return res.status(403).json({ message: 'Admin only.' });
        }

        req.docOwner = scope === 'user' ? meOf(req.user) : '';
        next();
    }

    app.get('/api/docs/:scope/:name', verifyToken, docAccess, async (req, res, next) => {
        try {
            const [rows] = await db.query(
                'SELECT data FROM app_docs WHERE scope = ? AND owner = ? AND name = ?',
                [req.params.scope, req.docOwner, req.params.name]
            );

            res.status(200).json({ data: rows.length ? parse(rows[0].data) : null });
        } catch (error) {
            next(error);
        }
    });

    app.put('/api/docs/:scope/:name', verifyToken, docAccess, async (req, res, next) => {
        try {
            const { scope, name } = req.params;

            if (scope === 'global' && !isAdmin(req.user)) {
                return res.status(403).json({ message: 'Only admin can change this.' });
            }

            const data = req.body?.data;

            if (data === null || typeof data !== 'object') {
                return res.status(400).json({ message: 'data must be an object or array.' });
            }

            const text = JSON.stringify(data);

            if (Buffer.byteLength(text) > MAX_DOC_BYTES) {
                return res.status(400).json({ message: 'Document is too large.' });
            }

            await db.query(
                'INSERT INTO app_docs (scope, owner, name, data) VALUES (?,?,?,?) ' +
                'ON DUPLICATE KEY UPDATE data = VALUES(data)',
                [scope, req.docOwner, name, text]
            );

            res.status(200).json({ ok: true });
        } catch (error) {
            next(error);
        }
    });
};
