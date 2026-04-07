// ── Noyo Admin Cloud Functions ─────────────────────────────────────
// Deploy:  cd functions && npm install && cd .. && npx firebase deploy --only functions
// ──────────────────────────────────────────────────────────────────

const functions = require('firebase-functions');
const admin     = require('firebase-admin');
admin.initializeApp();

const db = admin.firestore();

// ── Auth guard: caller must be admin ──────────────────────────────
async function requireAdmin(context) {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'You must be logged in.');
  }
  const doc = await db.collection('users').doc(context.auth.uid).get();
  if (!doc.exists || doc.data().role !== 'admin') {
    throw new functions.https.HttpsError('permission-denied', 'Admin access required.');
  }
}

// ── 1. Reset any user's password ──────────────────────────────────
exports.adminResetUserPassword = functions.https.onCall(async (data, context) => {
  await requireAdmin(context);
  const { uid, newPassword } = data;
  if (!uid || !newPassword) {
    throw new functions.https.HttpsError('invalid-argument', 'uid and newPassword are required.');
  }
  if (newPassword.length < 8) {
    throw new functions.https.HttpsError('invalid-argument', 'Password must be at least 8 characters.');
  }
  await admin.auth().updateUser(uid, { password: newPassword });
  return { success: true };
});

// ── 2. Change any user's role ─────────────────────────────────────
exports.adminChangeUserRole = functions.https.onCall(async (data, context) => {
  await requireAdmin(context);
  const { uid, newRole } = data;
  const validRoles = ['admin', 'rental', 'customer', 'lite'];
  if (!uid || !newRole) {
    throw new functions.https.HttpsError('invalid-argument', 'uid and newRole are required.');
  }
  if (!validRoles.includes(newRole)) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid role. Must be one of: ' + validRoles.join(', '));
  }
  // Update Firestore
  await db.collection('users').doc(uid).update({
    role:     newRole,
    userType: newRole,
  });
  // Update Auth custom claims
  await admin.auth().setCustomUserClaims(uid, { role: newRole });
  return { success: true };
});

// ── 3. Delete any user ────────────────────────────────────────────
exports.adminDeleteUser = functions.https.onCall(async (data, context) => {
  await requireAdmin(context);
  const { uid } = data;
  if (!uid) {
    throw new functions.https.HttpsError('invalid-argument', 'uid is required.');
  }
  // Delete from Firestore users collection
  await db.collection('users').doc(uid).delete().catch(() => {});
  // Delete from rental_profiles if exists
  await db.collection('rental_profiles').doc(uid).delete().catch(() => {});
  // Delete from Firebase Auth
  await admin.auth().deleteUser(uid);
  return { success: true };
});

// ── 4. List all users (Admin SDK — bypasses Firestore security rules) ─
exports.adminListUsers = functions.https.onCall(async (data, context) => {
  await requireAdmin(context);
  const snap = await db.collection('users').orderBy('createdAt', 'desc').get();
  const users = snap.docs.map(doc => {
    const d = doc.data();
    return {
      id:          doc.id,
      uid:         d.uid || doc.id,
      email:       d.email       || '',
      fullName:    d.fullName    || d.name || '',
      role:        d.role        || 'customer',
      company:     d.company     || d.companyName || '',
      city:        d.city        || '',
      state:       d.state       || '',
      plan:        d.plan        || '',
      active:      d.active !== false,
      createdAt:   d.createdAt ? d.createdAt.toDate().toISOString() : '',
    };
  });
  return { users };
});
