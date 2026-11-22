
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const { verifyToken, requireRole } = require('./authMiddleware');
const registerDataRoutes = require('./dataRoutes');

const app = express();
const PORT = Number(process.env.PORT) || 8080;

const allowedOrigins = (process.env.CLIENT_ORIGIN || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

const corsOptions = {
    origin(origin, callback) {
        if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
            return callback(null, true);
        }

        return callback(new Error('This origin is not allowed by the CORS policy.'));
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
};

const db = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME,
    ssl: process.env.DB_SSL === 'true'
        ? { rejectUnauthorized: process.env.DB_SSL_STRICT === 'true' }
        : undefined,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

app.use(cors(corsOptions));
app.use(express.json({ limit: '1mb' }));

const BUS_FIELDS = [
    'company',
    'type',
    'plateNumber',
    'from',
    'to',
    'depart',
    'arrive',
    'duration',
    'price',
    'seats',
    'rating',
    'status'
];

function validateBusId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function validateBusPayload(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { error: 'Request body must be a JSON object.' };
    }

    const missing = ['company', 'type', 'from', 'to'].filter((field) =>
        typeof body[field] !== 'string' || !body[field].trim()
    );

    if (missing.length) {
        return { error: `Required field(s): ${missing.join(', ')}.` };
    }

    const textFields = [
        'company',
        'type',
        'plateNumber',
        'from',
        'to',
        'depart',
        'arrive',
        'duration',
        'status'
    ];

    const clean = {};

    for (const field of textFields) {
        const value = body[field];

        if (value === undefined || value === null || value === '') {
            clean[field] = field === 'status' ? 'Active' : null;
            continue;
        }

        if (typeof value !== 'string') {
            return { error: `${field} must be a text value.` };
        }

        clean[field] = value.trim();
    }

    for (const field of ['company', 'type', 'from', 'to']) {
        if (!clean[field]) {
            return { error: `${field} cannot be empty.` };
        }
    }

    const price = Number(body.price);

    if (
        body.price === undefined ||
        body.price === null ||
        body.price === '' ||
        !Number.isFinite(price) ||
        price < 0
    ) {
        return {
            error: 'price must be a valid number greater than or equal to 0.'
        };
    }

    const seats = Number(body.seats);

    if (
        body.seats === undefined ||
        body.seats === null ||
        body.seats === '' ||
        !Number.isInteger(seats) ||
        seats < 0
    ) {
        return {
            error: 'seats must be a whole number greater than or equal to 0.'
        };
    }

    const rating =
        body.rating === undefined ||
        body.rating === null ||
        body.rating === ''
            ? 0
            : Number(body.rating);

    if (!Number.isFinite(rating) || rating < 0 || rating > 5) {
        return { error: 'rating must be a number from 0 to 5.' };
    }

    const allowedStatuses = [
        'Active',
        'Maintenance',
        'Inactive',
        'Available'
    ];

    if (!allowedStatuses.includes(clean.status)) {
        return {
            error: `status must be one of: ${allowedStatuses.join(', ')}.`
        };
    }

    clean.price = price;
    clean.seats = seats;
    clean.rating = rating;

    return { value: clean };
}

function getBusValues(bus) {
    return BUS_FIELDS.map((field) =>
        bus[field] === undefined ? null : bus[field]
    );
}

async function showBusTable(action) {
    const [buses] = await db.query(
        'SELECT * FROM buses ORDER BY id ASC'
    );

    console.log(`\n${action}`);
    console.table(buses);
}

app.get('/api/health', async (req, res, next) => {
    try {
        await db.query('SELECT 1');

        res.status(200).json({
            status: 'OK',
            message: 'BusGo API is running.',
            database: 'Connected'
        });
    } catch (error) {
        next(error);
    }
});

app.get('/api/buses', async (req, res, next) => {
    try {
        const [buses] = await db.query(
            'SELECT * FROM buses ORDER BY id ASC'
        );

        if (req.query.log === '1') {
            console.log('\nSELECT: Bus records retrieved');
            console.table(buses);
        }

        res.status(200).json(buses);
    } catch (error) {
        next(error);
    }
});

app.get('/api/buses/:id', async (req, res, next) => {
    try {
        const id = validateBusId(req.params.id);

        if (!id) {
            return res.status(400).json({
                message: 'Invalid bus ID.'
            });
        }

        const [rows] = await db.query(
            'SELECT * FROM buses WHERE id = ?',
            [id]
        );

        if (!rows.length) {
            return res.status(404).json({
                message: 'Bus not found.'
            });
        }

        res.status(200).json(rows[0]);
    } catch (error) {
        next(error);
    }
});

app.post('/api/buses', verifyToken, requireRole('admin'), async (req, res, next) => {
    try {
        const validation = validateBusPayload(req.body);

        if (validation.error) {
            return res.status(400).json({
                message: validation.error
            });
        }

        const bus = validation.value;

        const [result] = await db.query(
            'INSERT INTO buses (company, type, plateNumber, `from`, `to`, depart, arrive, duration, price, seats, rating, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
            getBusValues(bus)
        );

        const [rows] = await db.query(
            'SELECT * FROM buses WHERE id = ?',
            [result.insertId]
        );

        await showBusTable('INSERT: New bus added successfully');

        res.status(201).json(rows[0]);
    } catch (error) {
        next(error);
    }
});

app.put('/api/buses/:id', verifyToken, requireRole('admin'), async (req, res, next) => {
    try {
        const id = validateBusId(req.params.id);

        if (!id) {
            return res.status(400).json({
                message: 'Invalid bus ID.'
            });
        }

        const validation = validateBusPayload(req.body);

        if (validation.error) {
            return res.status(400).json({
                message: validation.error
            });
        }

        const bus = validation.value;

        const [result] = await db.query(
            'UPDATE buses SET company = ?, type = ?, plateNumber = ?, `from` = ?, `to` = ?, depart = ?, arrive = ?, duration = ?, price = ?, seats = ?, rating = ?, status = ? WHERE id = ?',
            [...getBusValues(bus), id]
        );

        if (result.affectedRows === 0) {
            const [existing] = await db.query(
                'SELECT id FROM buses WHERE id = ?',
                [id]
            );

            if (!existing.length) {
                return res.status(404).json({
                    message: 'Bus not found.'
                });
            }
        }

        const [rows] = await db.query(
            'SELECT * FROM buses WHERE id = ?',
            [id]
        );

        await showBusTable('UPDATE: Bus updated successfully');

        res.status(200).json(rows[0]);
    } catch (error) {
        next(error);
    }
});

app.delete('/api/buses/:id', verifyToken, requireRole('admin'), async (req, res, next) => {
    try {
        const id = validateBusId(req.params.id);

        if (!id) {
            return res.status(400).json({
                message: 'Invalid bus ID.'
            });
        }

        const [result] = await db.query(
            'DELETE FROM buses WHERE id = ?',
            [id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({
                message: 'Bus not found.'
            });
        }

        await showBusTable('DELETE: Bus deleted successfully');

        res.status(200).json({
            message: 'Bus deleted successfully.'
        });
    } catch (error) {
        next(error);
    }
});

// Cloud data (bookings, notifications, reviews, logs, per-user data)
registerDataRoutes(app, db);

app.use('/api', (req, res) => {
    res.status(404).json({
        message: 'API endpoint not found.'
    });
});

app.use((error, req, res, next) => {
    if (res.headersSent) {
        return next(error);
    }

    if (
        error instanceof SyntaxError &&
        error.status === 400 &&
        'body' in error
    ) {
        return res.status(400).json({
            message: 'Invalid JSON request body.'
        });
    }

    if (error.message && error.message.includes('CORS')) {
        return res.status(403).json({
            message: error.message
        });
    }

    console.error('API Error:', error.message);

    res.status(500).json({
        message: 'Internal server error.'
    });
});

app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);

    try {
        const connection = await db.getConnection();

        console.log('Database Connected');

        connection.release();
    } catch (error) {
        console.error(
            'Database Connection Failed:',
            error.message
        );
    }
});
