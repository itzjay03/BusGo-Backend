const { getApps, initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');

// Cache ng role para hindi mag-Firestore read sa bawat request (polling)
const roleCache = new Map();
const ROLE_TTL_MS = 60 * 1000;

function loadServiceAccount() {
    // Sa Render (production): galing sa environment variable
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    }
    // Sa laptop mo (development): galing sa file
    return require('./serviceAccountKey.json');
}

if (!getApps().length) {
    initializeApp({
        credential: cert(loadServiceAccount())
    });
}

async function verifyToken(req, res, next) {
    const match = (req.headers.authorization || '').match(/^Bearer (.+)$/);

    if (!match) {
        return res.status(401).json({ message: 'Missing authorization token.' });
    }

    try {
        const decoded = await getAuth().verifyIdToken(match[1]);

        // Role ay kinukuha sa Firestore, hindi sa token, para hindi mapeke
        let role;
        const cached = roleCache.get(decoded.uid);

        if (cached && cached.expires > Date.now()) {
            role = cached.role;
        } else {
            const snap = await getFirestore().collection('users').doc(decoded.uid).get();

            if (!snap.exists) {
                return res.status(403).json({ message: 'No role assigned to this account.' });
            }

            role = snap.data().role;
            roleCache.set(decoded.uid, { role, expires: Date.now() + ROLE_TTL_MS });
        }

        req.user = {
            uid: decoded.uid,
            email: decoded.email,
            role
        };

        next();
    } catch (error) {
        console.error('Token verification failed:', error.message);
        return res.status(401).json({ message: 'Invalid or expired token.' });
    }
}

function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.user || !roles.includes(req.user.role)) {
            return res.status(403).json({ message: 'You do not have permission to do this.' });
        }
        next();
    };
}

module.exports = { verifyToken, requireRole };